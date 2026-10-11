/**
 * Crank job: exits, at cost, every position whose Auto-Exit deadline has passed while its curve is still live
 * (router `auto_exit`, ONC-12). The router compares the deadline with Clock.unix_timestamp, so "now" comes from the
 * Clock sysvar, never from the local wall clock.
 *
 * planAutoExits is pure: one transaction per due position, the most overdue first, each
 * [create the owner's canonical quote ATA (idempotent, paid by the crank), auto_exit].
 * autoExitJob.run fetches the state, plans, then simulates each transaction and sends at most ctx.maxTx of them.
 */
import {
  SYSVAR_CLOCK_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type Connection,
  type GetProgramAccountsFilter,
  type Keypair,
  type PublicKey,
  type SimulatedTransactionResponse,
  type TransactionInstruction,
} from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  autoExitInstruction,
  decodeMarket,
  decodePosition,
  decodeTxError,
  getClusterConfig,
  marketAccountsFor,
  type ClusterConfig,
  type DecodedTxError,
  type MarketAccount,
  type PositionAccount,
} from '@trucee/sdk'
import { errorMessage, redactUrls } from '../../log.js'
import type { CrankContext, CrankJob, CrankJobResult } from '../index.js'

/** sha256("account:Position")[..8]. The SDK keeps it private, so it is duplicated here. */
const POSITION_DISCRIMINATOR: readonly number[] = Object.freeze([170, 188, 143, 228, 122, 64, 247, 208])
/** DBC VirtualPool.migration_progress: 0 (PreBondingCurve) is a live curve, anything else is complete. */
const POOL_MIGRATION_PROGRESS_OFFSET = 308
const CURVE_LIVE = 0
/** Clock sysvar: slot u64 | epoch_start_timestamp i64 | epoch u64 | leader_schedule_epoch u64 | unix_timestamp i64. */
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32
const CLOCK_SIZE = 40
/** getMultipleAccounts takes at most 100 keys per call. */
const MAX_KEYS_PER_CALL = 100
/** Wall-clock bound on one confirmation; past it the outcome is unknown and the exit is not retried this tick. */
const CONFIRM_TIMEOUT_MS = 45_000
/** A deadline of 0 means Auto-Exit is off. */
const AUTO_EXIT_DISABLED = 0n
/**
 * Router errors that only mean the chain moved on since the fetch, so they are logged as info, not errors:
 * the owner sold out (InvalidExitAmount 6007), the clock had not reached the deadline yet (AutoExitNotDue 6020),
 * or the curve graduated (AutoExitCurveComplete 6021).
 */
const RACE_ERROR_CODES: ReadonlySet<number> = new Set([6007, 6020, 6021])

/**
 * The planner takes no cluster: the router, hook and DBC ids are the same SDK constants on every cluster, and
 * mainnet-beta lists every quote mint the router allows (devnet's SOL included). run() checks ctx.cluster agrees.
 */
const PLAN_CLUSTER: ClusterConfig = getClusterConfig('mainnet-beta')
const PROGRAM_ID_FIELDS = Object.freeze(['routerProgramId', 'hookProgramId', 'dbcProgramId'] as const)
const QUOTE_TOKEN_PROGRAMS: ReadonlyMap<string, PublicKey> = new Map(
  PLAN_CLUSTER.quoteMints.map((quote) => [quote.mint.toBase58(), quote.tokenProgram]),
)

const POSITION_FILTER: GetProgramAccountsFilter = Object.freeze({
  memcmp: { offset: 0, bytes: Buffer.from(POSITION_DISCRIMINATOR).toString('base64'), encoding: 'base64' },
})

interface PlannedExit {
  readonly position: PositionAccount
  readonly instructions: TransactionInstruction[]
}

/* ---------- planner (pure) ---------- */

function hasDeadline(position: PositionAccount): boolean {
  return position.autoExitDeadline !== null && position.autoExitDeadline > AUTO_EXIT_DISABLED
}

/** Mirrors the router: due from the deadline on (now >= deadline); an emptied position has nothing to exit. */
function isDue(position: PositionAccount, nowUnix: bigint): boolean {
  return hasDeadline(position) && nowUnix >= (position.autoExitDeadline ?? AUTO_EXIT_DISABLED) && position.tokens > 0n
}

function compareBigint(a: bigint, b: bigint): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Most overdue first, then by address so the order is deterministic. */
function byDeadline(a: PositionAccount, b: PositionAccount): number {
  const order = compareBigint(a.autoExitDeadline ?? AUTO_EXIT_DISABLED, b.autoExitDeadline ?? AUTO_EXIT_DISABLED)
  return order !== 0 ? order : a.address.toBase58().localeCompare(b.address.toBase58())
}

function exitInstructions(
  position: PositionAccount,
  market: MarketAccount,
  quoteTokenProgram: PublicKey,
  payer: PublicKey,
): TransactionInstruction[] {
  const owner = position.owner
  const ownerQuote = getAssociatedTokenAddressSync(market.quoteMint, owner, false, quoteTokenProgram)
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, ownerQuote, owner, market.quoteMint, quoteTokenProgram),
    autoExitInstruction({ cluster: PLAN_CLUSTER, accounts: marketAccountsFor(market, quoteTokenProgram), cranker: payer, owner }),
  ]
}

/** Null unless the position is due, its market is known and not finalized, and its curve is known to be live. */
function planExit(
  position: PositionAccount,
  markets: ReadonlyMap<string, MarketAccount>,
  poolProgress: ReadonlyMap<string, number>,
  payer: PublicKey,
): PlannedExit | null {
  const market = markets.get(position.market.toBase58())
  if (market === undefined || market.finalized) return null
  if (poolProgress.get(market.pool.toBase58()) !== CURVE_LIVE) return null
  const quoteTokenProgram = QUOTE_TOKEN_PROGRAMS.get(market.quoteMint.toBase58())
  if (quoteTokenProgram === undefined) return null
  return { position, instructions: exitInstructions(position, market, quoteTokenProgram, payer) }
}

function planExits(
  positions: readonly PositionAccount[],
  markets: ReadonlyMap<string, MarketAccount>,
  poolProgress: ReadonlyMap<string, number>,
  nowUnix: bigint,
  payer: PublicKey,
): PlannedExit[] {
  return positions
    .filter((position) => isDue(position, nowUnix))
    .sort(byDeadline)
    .map((position) => planExit(position, markets, poolProgress, payer))
    .filter((exit): exit is PlannedExit => exit !== null)
}

/**
 * One transaction per position to auto-exit now, the most overdue first.
 * @param markets decoded router markets by market address (base58)
 * @param poolProgress DBC pool migration progress byte (@308) by pool address (base58)
 * @param nowUnix the chain clock (Clock.unix_timestamp)
 * @param payer the crank: signs auto_exit and pays for the owner's quote ATA if it does not exist
 */
export function planAutoExits(
  positions: PositionAccount[],
  markets: Map<string, MarketAccount>,
  poolProgress: Map<string, number>,
  nowUnix: bigint,
  payer: PublicKey,
): TransactionInstruction[][] {
  return planExits(positions, markets, poolProgress, nowUnix, payer).map((exit) => exit.instructions)
}

/* ---------- chain state ---------- */

interface Fetched<T> {
  readonly value: T
  readonly errors: readonly string[]
}

function requirePlanPrograms(cluster: ClusterConfig): PublicKey {
  const differing = PROGRAM_ID_FIELDS.filter((field) => !cluster[field].equals(PLAN_CLUSTER[field]))
  if (differing.length > 0) {
    throw new Error(`cluster ${cluster.cluster} uses other ${differing.join(', ')} than the SDK constants the planner uses`)
  }
  return cluster.routerProgramId
}

/** Every Position with a non-zero deadline; an undecodable account becomes an error, not a failed job. */
async function fetchDeadlinePositions(connection: Connection, routerProgramId: PublicKey): Promise<Fetched<PositionAccount[]>> {
  const accounts = await connection.getProgramAccounts(routerProgramId, { filters: [POSITION_FILTER] })
  const decoded = accounts.map(({ pubkey, account }) => {
    try {
      return { position: decodePosition(pubkey, account.data), error: null }
    } catch (err) {
      return { position: null, error: `position ${pubkey.toBase58()}: ${errorMessage(err)}` }
    }
  })
  return {
    value: decoded.flatMap(({ position }) => (position !== null && hasDeadline(position) ? [position] : [])),
    errors: decoded.flatMap(({ error }) => (error === null ? [] : [error])),
  }
}

async function fetchChainUnixTime(connection: Connection): Promise<bigint> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
  if (clock === null || clock.data.length < CLOCK_SIZE) throw new Error('Clock sysvar unavailable')
  return clock.data.readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET)
}

function uniqueKeys(keys: readonly PublicKey[]): PublicKey[] {
  return [...new Map(keys.map((key) => [key.toBase58(), key])).values()]
}

/** Existing accounts by address (base58), in getMultipleAccounts batches. */
async function fetchAccounts(connection: Connection, keys: readonly PublicKey[]): Promise<Map<string, AccountInfo<Buffer>>> {
  const batches = Array.from({ length: Math.ceil(keys.length / MAX_KEYS_PER_CALL) }, (_, i) =>
    keys.slice(i * MAX_KEYS_PER_CALL, (i + 1) * MAX_KEYS_PER_CALL),
  )
  const infos = (await Promise.all(batches.map((batch) => connection.getMultipleAccountsInfo(batch)))).flat()
  return new Map(keys.flatMap((key, i) => {
    const info = infos[i]
    return info === null || info === undefined ? [] : [[key.toBase58(), info] as const]
  }))
}

async function fetchMarkets(connection: Connection, positions: readonly PositionAccount[]): Promise<Fetched<Map<string, MarketAccount>>> {
  const keys = uniqueKeys(positions.map((position) => position.market))
  const infos = await fetchAccounts(connection, keys)
  const decoded = keys.map((key) => {
    const info = infos.get(key.toBase58())
    if (info === undefined) return { market: null, error: `market ${key.toBase58()} not found` }
    try {
      return { market: decodeMarket(key, info.data), error: null }
    } catch (err) {
      return { market: null, error: `market ${key.toBase58()}: ${errorMessage(err)}` }
    }
  })
  return {
    value: new Map(decoded.flatMap(({ market }) => (market === null ? [] : [[market.address.toBase58(), market] as const]))),
    errors: decoded.flatMap(({ error }) => (error === null ? [] : [error])),
  }
}

/** Migration progress of each market's pool, read only from accounts the DBC program owns. */
async function fetchPoolProgress(
  connection: Connection,
  dbcProgramId: PublicKey,
  markets: Iterable<MarketAccount>,
): Promise<Fetched<Map<string, number>>> {
  const keys = uniqueKeys([...markets].map((market) => market.pool))
  const infos = await fetchAccounts(connection, keys)
  const progress = keys.map((key) => {
    const pool = key.toBase58()
    const info = infos.get(pool)
    if (info === undefined) return { pool, byte: undefined, error: `pool ${pool} not found` }
    if (!info.owner.equals(dbcProgramId)) return { pool, byte: undefined, error: `pool ${pool} is not owned by the DBC program` }
    const byte = info.data[POOL_MIGRATION_PROGRESS_OFFSET]
    return { pool, byte, error: byte === undefined ? `pool ${pool} is too short` : null }
  })
  return {
    value: new Map(progress.flatMap(({ pool, byte }) => (byte === undefined ? [] : [[pool, byte] as const]))),
    errors: progress.flatMap(({ error }) => (error === null ? [] : [error])),
  }
}

/* ---------- execution ---------- */

type Outcome =
  | { readonly kind: 'sent'; readonly signature: string }
  | { readonly kind: 'skipped' }
  /** Simulation failed: nothing was sent. */
  | { readonly kind: 'rejected'; readonly error: string }
  /** An RPC call threw, or the transaction failed on chain; uses the budget so an RPC outage cannot spin the tick. */
  | { readonly kind: 'failed'; readonly error: string }
  /** Sent, but not confirmed within CONFIRM_TIMEOUT_MS: it may still land. */
  | { readonly kind: 'unknown'; readonly error: string }

type Timed<T> = { readonly timedOut: true } | { readonly timedOut: false; readonly value: T }

/** Settles with the promise, or with timedOut after `ms`; the timer never outlives the race. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<Timed<T>> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms)
  })
  try {
    return await Promise.race([promise.then((value): Timed<T> => ({ timedOut: false, value })), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function buildTransaction(payer: Keypair, instructions: TransactionInstruction[], blockhash: string): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([payer])
  return tx
}

function isRace(decoded: DecodedTxError | null): boolean {
  if (decoded === null || decoded.code === null) return false
  return (decoded.program === 'router' || decoded.program === 'unknown') && RACE_ERROR_CODES.has(decoded.code)
}

function simulationOutcome(ctx: CrankContext, exit: PlannedExit, value: SimulatedTransactionResponse): Outcome {
  const decoded = decodeTxError({ logs: value.logs ?? [], error: value.err })
  const reason = decoded?.name ?? JSON.stringify(value.err)
  const fields = { position: exit.position.address, owner: exit.position.owner, market: exit.position.market, reason }
  if (isRace(decoded)) {
    ctx.log.info('auto-exit skipped: chain state changed since the fetch', fields)
    return { kind: 'skipped' }
  }
  ctx.log.warn('auto-exit simulation failed', { ...fields, message: decoded?.message, logs: value.logs?.slice(-5) })
  const detail = decoded === null ? reason : `${reason} (${decoded.message})`
  return { kind: 'rejected', error: `position ${exit.position.address.toBase58()}: simulation failed: ${detail}` }
}

async function sendAndConfirm(ctx: CrankContext, exit: PlannedExit, tx: VersionedTransaction, blockhash: BlockhashWithExpiryBlockHeight): Promise<Outcome> {
  const position = exit.position.address
  const signature = await ctx.connection.sendTransaction(tx)
  const confirmation = await withTimeout(ctx.connection.confirmTransaction({ signature, ...blockhash }), CONFIRM_TIMEOUT_MS)
  if (confirmation.timedOut) {
    ctx.log.warn('auto-exit outcome unknown: not confirmed in time', { position, signature, timeoutMs: CONFIRM_TIMEOUT_MS })
    return { kind: 'unknown', error: `position ${position.toBase58()}: transaction ${signature} outcome unknown (not confirmed within ${CONFIRM_TIMEOUT_MS} ms)` }
  }
  const err = confirmation.value.value.err
  if (err !== null) {
    ctx.log.warn('auto-exit transaction failed', { position, signature, error: err })
    return { kind: 'failed', error: `position ${position.toBase58()}: transaction ${signature} failed: ${JSON.stringify(err)}` }
  }
  ctx.log.info('auto-exit sent', { position, owner: exit.position.owner, market: exit.position.market, signature })
  return { kind: 'sent', signature }
}

/** Simulates first; sends only a transaction whose simulation succeeded. Never retried within the tick. */
async function executeExit(ctx: CrankContext, exit: PlannedExit): Promise<Outcome> {
  const position = exit.position.address
  try {
    const blockhash = await ctx.connection.getLatestBlockhash()
    const tx = buildTransaction(ctx.payer, exit.instructions, blockhash.blockhash)
    const simulation = await ctx.connection.simulateTransaction(tx)
    if (simulation.value.err !== null) return simulationOutcome(ctx, exit, simulation.value)
    return await sendAndConfirm(ctx, exit, tx, blockhash)
  } catch (err) {
    ctx.log.warn('auto-exit send failed', { position, error: errorMessage(err) })
    return { kind: 'failed', error: `position ${position.toBase58()}: ${errorMessage(err)}` }
  }
}

const usesBudget = (outcome: Outcome): boolean => outcome.kind !== 'skipped' && outcome.kind !== 'rejected'
const errorOf = (outcome: Outcome): string[] => ('error' in outcome ? [outcome.error] : [])

/** Tries the exits in order until maxTx transactions went out; simulation failures do not use the budget. */
async function executeExits(ctx: CrankContext, exits: readonly PlannedExit[]): Promise<CrankJobResult> {
  let outcomes: readonly Outcome[] = []
  for (const exit of exits) {
    if (outcomes.filter(usesBudget).length >= ctx.maxTx) break
    outcomes = [...outcomes, await executeExit(ctx, exit)]
  }
  return {
    sent: outcomes.flatMap((o) => (o.kind === 'sent' ? [o.signature] : [])),
    skipped: exits.length - outcomes.length + outcomes.filter((o) => o.kind === 'skipped').length,
    errors: outcomes.flatMap(errorOf),
  }
}

async function runAutoExits(ctx: CrankContext): Promise<CrankJobResult> {
  if (ctx.maxTx <= 0) return { sent: [], skipped: 0, errors: [] }
  const cluster = ctx.cluster
  const routerProgramId = requirePlanPrograms(cluster)
  const [positions, nowUnix] = await Promise.all([
    fetchDeadlinePositions(ctx.connection, routerProgramId),
    fetchChainUnixTime(ctx.connection),
  ])
  const due = positions.value.filter((position) => isDue(position, nowUnix))
  const markets = await fetchMarkets(ctx.connection, due)
  const poolProgress = await fetchPoolProgress(ctx.connection, cluster.dbcProgramId, markets.value.values())
  const exits = planExits(due, markets.value, poolProgress.value, nowUnix, ctx.payer.publicKey)
  const executed = await executeExits(ctx, exits)
  return { ...executed, errors: [...positions.errors, ...markets.errors, ...poolProgress.errors, ...executed.errors] }
}

/** RPC errors can quote the RPC URL, and with it the provider key: every error string leaves with URLs reduced to hosts. */
function redactErrors(result: CrankJobResult): CrankJobResult {
  return { ...result, errors: result.errors.map(redactUrls) }
}

export const autoExitJob: CrankJob = Object.freeze({
  name: 'auto-exit',
  async run(ctx: CrankContext): Promise<CrankJobResult> {
    try {
      return redactErrors(await runAutoExits(ctx))
    } catch (err) {
      return redactErrors({ sent: [], skipped: 0, errors: [`auto-exit: ${errorMessage(err)}`] })
    }
  },
})
