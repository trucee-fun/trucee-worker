/**
 * Crank job: exits, at cost, every position whose Auto-Exit deadline has passed while its curve is still live
 * (router `auto_exit`, ONC-12). The router compares the deadline with Clock.unix_timestamp, so "now" comes from the
 * Clock sysvar, never from the local wall clock.
 *
 * planAutoExits is pure: one transaction per due position, the most overdue first. It is [auto_exit] when the owner's
 * canonical quote ATA exists, else [create that ATA (idempotent, paid by the crank), auto_exit].
 *
 * ATA rent guard (CRK-10): an owner can close the ATA the crank paid for and keep its rent, so a missing ATA is created
 * only when the refund is at least minAtaValueLamports, and at most maxAtaCreatesPerTick ATAs are created per tick.
 * Any other exit with a missing ATA is skipped (left to the owner) without using the tick's budget. While the payer
 * holds less than crankMinSolLamports, the job plans nothing.
 *
 * The job fetches the state, plans, then simulates each transaction and sends at most ctx.maxTx of them.
 * Every RPC call is bounded in wall-clock time, because the tick runner has no tick-level timeout.
 */
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type GetProgramAccountsFilter,
  type Keypair,
  type TransactionError,
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
  refundFor,
  type ClusterConfig,
  type DecodedTxError,
  type MarketAccount,
  type PositionAccount,
} from '@trucee/sdk'
import { defaultCrankGuards, type CrankGuards } from '../../config.js'
import { errorMessage, redactUrls } from '../../log.js'
import type { CrankContext, CrankJob, CrankJobResult } from '../index.js'

const JOB_NAME = 'auto-exit'
const COMMITMENT = 'confirmed'
/** Wall-clock bound on every RPC request (fetches, blockhash, simulate, send). */
export const RPC_TIMEOUT_MS = 30_000
/** Wall-clock bound on one confirmation; past it the outcome is unknown and the exit is not resent this tick. */
export const CONFIRM_TIMEOUT_MS = 45_000
/** Simulations per tick are capped at ctx.maxTx times this; due exits over the cap count as skipped. */
export const MAX_ATTEMPTS_PER_TX = 3
const TIMED_OUT = Symbol('timed out')

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
/** A deadline of 0 means Auto-Exit is off. */
const AUTO_EXIT_DISABLED = 0n
/**
 * Router errors that only mean the chain moved on since the fetch, so they are logged as info, not errors:
 * the owner sold out (InvalidExitAmount 6007), the clock had not reached the deadline yet (AutoExitNotDue 6020),
 * or the curve graduated (AutoExitCurveComplete 6021).
 */
const RACE_ERROR_CODES: ReadonlySet<number> = new Set([6007, 6020, 6021])
/** Simulation error of a transaction whose blockhash expired; a send error says the same in words. */
const BLOCKHASH_NOT_FOUND = 'BlockhashNotFound'
const BLOCKHASH_NOT_FOUND_MESSAGE = /blockhash not found/i

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

/** The guards this job applies (CRK-10); WorkerConfig satisfies it. */
export type AutoExitGuards = Pick<CrankGuards, 'minAtaValueLamports' | 'maxAtaCreatesPerTick' | 'crankMinSolLamports'>

/** What the planner knows about owners' quote ATAs. */
export interface AtaRule {
  /** Canonical owner quote ATA (base58) to whether it is a live token account; an absent ATA counts as missing. */
  readonly ownerQuoteAtaExists: ReadonlyMap<string, boolean>
  /** A missing ATA is created (rent paid by the crank) only when refundFor(basis, fee) is at least this. */
  readonly minAtaValueLamports: bigint
}

interface PlannedExit {
  readonly position: PositionAccount
  readonly instructions: TransactionInstruction[]
  /** The transaction creates the owner's quote ATA, its rent paid by the crank. */
  readonly createsAta: boolean
}

interface ExitPlan {
  readonly exits: readonly PlannedExit[]
  /** Due exits skipped because the owner's quote ATA is missing and the refund is below minAtaValueLamports. */
  readonly belowMinValue: number
}

/** A due position on a live curve, with what its exit needs. */
interface ExitTarget {
  readonly position: PositionAccount
  readonly market: MarketAccount
  readonly quoteTokenProgram: PublicKey
  readonly ownerQuote: PublicKey
}

/* ---------- planner (pure) ---------- */

function hasDeadline(position: PositionAccount): boolean {
  return position.autoExitDeadline !== null && position.autoExitDeadline > AUTO_EXIT_DISABLED
}

/** Mirrors the router: due from the deadline on (now >= deadline); an emptied position has nothing to exit. */
function isDue(position: PositionAccount, nowUnix: bigint): boolean {
  return hasDeadline(position) && nowUnix >= (position.autoExitDeadline ?? AUTO_EXIT_DISABLED) && position.tokens > 0n
}

function compare<T extends bigint | string>(a: T, b: T): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** Most overdue first, then by address so the order is deterministic. */
function byDeadline(a: PositionAccount, b: PositionAccount): number {
  const order = compare(a.autoExitDeadline ?? AUTO_EXIT_DISABLED, b.autoExitDeadline ?? AUTO_EXIT_DISABLED)
  return order !== 0 ? order : compare(a.address.toBase58(), b.address.toBase58())
}

/**
 * Null unless the market is known and not finalized, its curve is known to be live, its quote mint is allowed, and the
 * owner is on the ed25519 curve (an off-curve owner has no canonical ATA).
 */
function exitTarget(
  position: PositionAccount,
  markets: ReadonlyMap<string, MarketAccount>,
  poolProgress: ReadonlyMap<string, number>,
): ExitTarget | null {
  const market = markets.get(position.market.toBase58())
  if (market === undefined || market.finalized) return null
  if (poolProgress.get(market.pool.toBase58()) !== CURVE_LIVE) return null
  const quoteTokenProgram = QUOTE_TOKEN_PROGRAMS.get(market.quoteMint.toBase58())
  if (quoteTokenProgram === undefined || !PublicKey.isOnCurve(position.owner.toBytes())) return null
  const ownerQuote = getAssociatedTokenAddressSync(market.quoteMint, position.owner, false, quoteTokenProgram)
  return { position, market, quoteTokenProgram, ownerQuote }
}

const BELOW_MIN_VALUE = Symbol('below min value')

/** The exit of `target`, or BELOW_MIN_VALUE when its ATA is missing and the refund cannot justify the rent. */
function planTarget(target: ExitTarget, ata: AtaRule, payer: PublicKey): PlannedExit | typeof BELOW_MIN_VALUE {
  const { position, market, quoteTokenProgram, ownerQuote } = target
  const owner = position.owner
  const accounts = marketAccountsFor(market, quoteTokenProgram)
  const exit = autoExitInstruction({ cluster: PLAN_CLUSTER, accounts, cranker: payer, owner })
  if (ata.ownerQuoteAtaExists.get(ownerQuote.toBase58()) === true) return { position, instructions: [exit], createsAta: false }
  if (refundFor(position.basis, market.feeNumerator) < ata.minAtaValueLamports) return BELOW_MIN_VALUE
  const createAta = createAssociatedTokenAccountIdempotentInstruction(payer, ownerQuote, owner, market.quoteMint, quoteTokenProgram)
  return { position, instructions: [createAta, exit], createsAta: true }
}

function planExits(
  positions: readonly PositionAccount[],
  markets: ReadonlyMap<string, MarketAccount>,
  poolProgress: ReadonlyMap<string, number>,
  nowUnix: bigint,
  payer: PublicKey,
  ata: AtaRule,
): ExitPlan {
  const planned = positions
    .filter((position) => isDue(position, nowUnix))
    .sort(byDeadline)
    .map((position) => exitTarget(position, markets, poolProgress))
    .filter((target): target is ExitTarget => target !== null)
    .map((target) => planTarget(target, ata, payer))
  return {
    exits: planned.filter((exit): exit is PlannedExit => exit !== BELOW_MIN_VALUE),
    belowMinValue: planned.filter((exit) => exit === BELOW_MIN_VALUE).length,
  }
}

/**
 * One transaction per position to auto-exit now, the most overdue first. A position whose quote ATA is missing and
 * whose refund is below `ata.minAtaValueLamports` gets none. The per-tick ATA create cap is applied when sending.
 * @param markets decoded router markets by market address (base58)
 * @param poolProgress DBC pool migration progress byte (@308) by pool address (base58)
 * @param nowUnix the chain clock (Clock.unix_timestamp)
 * @param payer the crank: signs auto_exit and pays for the owner's quote ATA if it does not exist
 * @param ata which owner quote ATAs exist, and the least refund for which the crank creates a missing one
 */
export function planAutoExits(
  positions: PositionAccount[],
  markets: Map<string, MarketAccount>,
  poolProgress: Map<string, number>,
  nowUnix: bigint,
  payer: PublicKey,
  ata: AtaRule,
): TransactionInstruction[][] {
  return planExits(positions, markets, poolProgress, nowUnix, payer, ata).exits.map((exit) => exit.instructions)
}

/* ---------- bounded RPC ---------- */

class RpcTimeoutError extends Error {
  constructor(call: string, ms: number) {
    super(`${call} timed out after ${ms} ms`)
    this.name = 'RpcTimeoutError'
  }
}

/**
 * Settles with `promise`, or with TIMED_OUT after `ms`. The timer is always cleared. A later rejection of `promise`
 * stays handled, because Promise.race keeps its subscription.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** One RPC request bounded by RPC_TIMEOUT_MS; throws RpcTimeoutError when it takes longer. */
async function rpc<T>(call: string, request: Promise<T>): Promise<T> {
  const result = await withTimeout(request, RPC_TIMEOUT_MS)
  if (result === TIMED_OUT) throw new RpcTimeoutError(call, RPC_TIMEOUT_MS)
  return result
}

/* ---------- chain state ---------- */

interface Fetched<T> {
  readonly value: T
  readonly errors: readonly string[]
}

function requirePlanPrograms(cluster: ClusterConfig): void {
  const differing = PROGRAM_ID_FIELDS.filter((field) => !cluster[field].equals(PLAN_CLUSTER[field]))
  if (differing.length > 0) {
    throw new Error(`cluster ${cluster.cluster} uses other ${differing.join(', ')} than the SDK constants the planner uses`)
  }
}

/** Every Position with a non-zero deadline; an undecodable account becomes an error, not a failed job. */
async function fetchDeadlinePositions(ctx: CrankContext, routerProgramId: PublicKey): Promise<Fetched<PositionAccount[]>> {
  const accounts = await rpc(
    'getProgramAccounts',
    ctx.connection.getProgramAccounts(routerProgramId, { commitment: COMMITMENT, filters: [POSITION_FILTER] }),
  )
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

async function fetchChainUnixTime(ctx: CrankContext): Promise<bigint> {
  const clock = await rpc('getAccountInfo(Clock)', ctx.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, COMMITMENT))
  if (clock === null || clock.data.length < CLOCK_SIZE) throw new Error('Clock sysvar missing or too short')
  return clock.data.readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET)
}

function uniqueKeys(keys: readonly PublicKey[]): PublicKey[] {
  return [...new Map(keys.map((key) => [key.toBase58(), key])).values()]
}

/** Existing accounts by address (base58), in getMultipleAccounts batches. */
async function fetchAccounts(ctx: CrankContext, keys: readonly PublicKey[]): Promise<Map<string, AccountInfo<Buffer>>> {
  const batches = Array.from({ length: Math.ceil(keys.length / MAX_KEYS_PER_CALL) }, (_, i) =>
    keys.slice(i * MAX_KEYS_PER_CALL, (i + 1) * MAX_KEYS_PER_CALL),
  )
  const responses = await Promise.all(
    batches.map((batch) => rpc('getMultipleAccountsInfo', ctx.connection.getMultipleAccountsInfo(batch, COMMITMENT))),
  )
  const infos = responses.flat()
  return new Map(keys.flatMap((key, i) => {
    const info = infos[i]
    return info === null || info === undefined ? [] : [[key.toBase58(), info] as const]
  }))
}

/** Markets of `positions`, decoded only from accounts the router owns. */
async function fetchMarkets(
  ctx: CrankContext,
  routerProgramId: PublicKey,
  positions: readonly PositionAccount[],
): Promise<Fetched<Map<string, MarketAccount>>> {
  const keys = uniqueKeys(positions.map((position) => position.market))
  const infos = await fetchAccounts(ctx, keys)
  const decoded = keys.map((key) => {
    const market = key.toBase58()
    const info = infos.get(market)
    if (info === undefined) return { market: null, error: `market ${market} not found` }
    if (!info.owner.equals(routerProgramId)) return { market: null, error: `market ${market} is not owned by the router` }
    try {
      return { market: decodeMarket(key, info.data), error: null }
    } catch (err) {
      return { market: null, error: `market ${market}: ${errorMessage(err)}` }
    }
  })
  return {
    value: new Map(decoded.flatMap(({ market }) => (market === null ? [] : [[market.address.toBase58(), market] as const]))),
    errors: decoded.flatMap(({ error }) => (error === null ? [] : [error])),
  }
}

/**
 * Canonical quote ATA (base58) of each target to whether it is a live token account. Anyone can send lamports to an
 * ATA address before it exists, so only an account owned by the quote token program counts.
 */
async function fetchAtaExistence(ctx: CrankContext, targets: readonly ExitTarget[]): Promise<Map<string, boolean>> {
  const infos = await fetchAccounts(ctx, uniqueKeys(targets.map((target) => target.ownerQuote)))
  return new Map(
    targets.map(({ ownerQuote, quoteTokenProgram }) => {
      const ata = ownerQuote.toBase58()
      return [ata, infos.get(ata)?.owner.equals(quoteTokenProgram) === true] as const
    }),
  )
}

/** True when the payer holds at least `minLamports`; otherwise logs once and the job plans nothing this tick. */
async function payerAboveFloor(ctx: CrankContext, minLamports: bigint): Promise<boolean> {
  const balance = BigInt(await rpc('getBalance', ctx.connection.getBalance(ctx.payer.publicKey, COMMITMENT)))
  if (balance >= minLamports) return true
  const fields = { job: JOB_NAME, payer: ctx.payer.publicKey, balanceLamports: balance, minLamports }
  ctx.log.warn('auto-exit: crank payer balance below CRANK_MIN_SOL_LAMPORTS; nothing planned this tick', fields)
  return false
}

/** Migration progress of each market's pool, read only from accounts the DBC program owns. */
async function fetchPoolProgress(
  ctx: CrankContext,
  dbcProgramId: PublicKey,
  markets: Iterable<MarketAccount>,
): Promise<Fetched<Map<string, number>>> {
  const keys = uniqueKeys([...markets].map((market) => market.pool))
  const infos = await fetchAccounts(ctx, keys)
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
  /** The chain moved on since the fetch (a race router error): info, not an error. */
  | { readonly kind: 'skipped' }
  /**
   * usesBudget: a transaction was (or may have been) sent, or an RPC call failed, so it counts against ctx.maxTx.
   * halts: an RPC call timed out, so the RPC is treated as stalled and no further exit is tried this tick.
   */
  | { readonly kind: 'error'; readonly error: string; readonly usesBudget: boolean; readonly halts: boolean }

/** The transaction's blockhash expired; the caller refreshes it once and retries. */
const STALE_BLOCKHASH = Symbol('stale blockhash')
type Step = Outcome | typeof STALE_BLOCKHASH

interface Attempt {
  readonly outcome: Outcome
  readonly blockhash: BlockhashWithExpiryBlockHeight
}

function failure(
  ctx: CrankContext,
  exit: PlannedExit,
  reason: string,
  flags: { readonly usesBudget: boolean; readonly halts: boolean },
  msg = 'auto-exit failed',
): Outcome {
  const position = exit.position.address.toBase58()
  ctx.log.warn(msg, { job: JOB_NAME, position, owner: exit.position.owner, market: exit.position.market, reason })
  return { kind: 'error', error: `position ${position}: ${reason}`, ...flags }
}

function buildTransaction(payer: Keypair, instructions: readonly TransactionInstruction[], blockhash: string): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([payer])
  return tx
}

/** Only the router's own race errors; decodeTxError attributes a failure to the innermost failing program's logs. */
function isRace(decoded: DecodedTxError | null): boolean {
  return decoded !== null && decoded.program === 'router' && decoded.code !== null && RACE_ERROR_CODES.has(decoded.code)
}

function describeTxError(err: TransactionError, logs: readonly string[] | null): string {
  const decoded = decodeTxError({ error: err, logs })
  return decoded === null ? JSON.stringify(err) : `${decoded.name}: ${decoded.message}`
}

function simulationOutcome(ctx: CrankContext, exit: PlannedExit, err: TransactionError, logs: readonly string[] | null): Step {
  if (err === BLOCKHASH_NOT_FOUND) return STALE_BLOCKHASH
  const decoded = decodeTxError({ error: err, logs })
  if (isRace(decoded)) {
    const fields = { job: JOB_NAME, position: exit.position.address, owner: exit.position.owner, reason: decoded?.name }
    ctx.log.info('auto-exit skipped: chain state changed since the fetch', fields)
    return { kind: 'skipped' }
  }
  return failure(ctx, exit, `simulation failed: ${describeTxError(err, logs)}`, { usesBudget: false, halts: false })
}

/** Never throws. A confirmation past CONFIRM_TIMEOUT_MS is an unknown outcome: logged, not resent this tick. */
async function confirmExit(
  ctx: CrankContext,
  exit: PlannedExit,
  signature: string,
  blockhash: BlockhashWithExpiryBlockHeight,
): Promise<Outcome> {
  try {
    const strategy = { signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }
    const confirmation = await withTimeout(ctx.connection.confirmTransaction(strategy, COMMITMENT), CONFIRM_TIMEOUT_MS)
    if (confirmation === TIMED_OUT) {
      const reason = `transaction ${signature} not confirmed within ${CONFIRM_TIMEOUT_MS} ms; outcome unknown, not resent this tick`
      return failure(ctx, exit, reason, { usesBudget: true, halts: true }, 'auto-exit outcome unknown')
    }
    const err = confirmation.value.err
    if (err !== null) return failure(ctx, exit, `transaction ${signature} failed: ${describeTxError(err, null)}`, { usesBudget: true, halts: false })
    ctx.log.info('auto-exit sent', { job: JOB_NAME, position: exit.position.address, owner: exit.position.owner, signature })
    return { kind: 'sent', signature }
  } catch (err) {
    return failure(ctx, exit, `transaction ${signature}: ${errorMessage(err)}`, { usesBudget: true, halts: false })
  }
}

/** Simulates, then sends (no preflight: it would repeat the simulation) and confirms. Never throws. */
async function executeExit(ctx: CrankContext, exit: PlannedExit, blockhash: BlockhashWithExpiryBlockHeight): Promise<Step> {
  const tx = buildTransaction(ctx.payer, exit.instructions, blockhash.blockhash)
  try {
    const simulation = await rpc('simulateTransaction', ctx.connection.simulateTransaction(tx, { commitment: COMMITMENT }))
    if (simulation.value.err !== null) return simulationOutcome(ctx, exit, simulation.value.err, simulation.value.logs)
  } catch (err) {
    return failure(ctx, exit, `simulation: ${errorMessage(err)}`, { usesBudget: false, halts: err instanceof RpcTimeoutError })
  }
  try {
    const signature = await rpc('sendRawTransaction', ctx.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true }))
    return await confirmExit(ctx, exit, signature, blockhash)
  } catch (err) {
    if (err instanceof RpcTimeoutError) {
      const reason = `${err.message}; outcome unknown, not resent this tick`
      return failure(ctx, exit, reason, { usesBudget: true, halts: true }, 'auto-exit outcome unknown')
    }
    if (BLOCKHASH_NOT_FOUND_MESSAGE.test(errorMessage(err))) return STALE_BLOCKHASH
    return failure(ctx, exit, `send failed: ${errorMessage(err)}`, { usesBudget: true, halts: false })
  }
}

async function latestBlockhash(ctx: CrankContext): Promise<BlockhashWithExpiryBlockHeight> {
  return rpc('getLatestBlockhash', ctx.connection.getLatestBlockhash(COMMITMENT))
}

/** One exit with the tick's blockhash; if that blockhash expired, refreshes it once and retries the exit once. */
async function attemptExit(ctx: CrankContext, exit: PlannedExit, blockhash: BlockhashWithExpiryBlockHeight): Promise<Attempt> {
  const first = await executeExit(ctx, exit, blockhash)
  if (first !== STALE_BLOCKHASH) return { outcome: first, blockhash }
  try {
    const fresh = await latestBlockhash(ctx)
    const second = await executeExit(ctx, exit, fresh)
    const outcome = second !== STALE_BLOCKHASH
      ? second
      : failure(ctx, exit, 'blockhash not found, even after a refresh', { usesBudget: false, halts: false })
    return { outcome, blockhash: fresh }
  } catch (err) {
    const halts = err instanceof RpcTimeoutError
    return { outcome: failure(ctx, exit, `blockhash refresh: ${errorMessage(err)}`, { usesBudget: true, halts }), blockhash }
  }
}

const usesBudget = (outcome: Outcome): boolean => outcome.kind === 'sent' || (outcome.kind === 'error' && outcome.usesBudget)
const halts = (outcome: Outcome): boolean => outcome.kind === 'error' && outcome.halts

function mayContinue(ctx: CrankContext, outcomes: readonly Outcome[]): boolean {
  return (
    outcomes.length < ctx.maxTx * MAX_ATTEMPTS_PER_TX &&
    outcomes.filter(usesBudget).length < ctx.maxTx &&
    !outcomes.some(halts)
  )
}

interface Executed {
  readonly result: CrankJobResult
  /** Exits not tried because maxAtaCreates ATAs were already created this tick. */
  readonly overCreateCap: number
}

/** A fresh result per call, so no caller can alias another call's arrays. */
const emptyResult = (): CrankJobResult => ({ sent: [], skipped: 0, errors: [] })

/**
 * Tries the exits in order with one blockhash per tick, until maxTx transactions went out, maxTx * 3 exits were
 * tried, or an RPC call timed out. An exit that would create an ATA is not tried once maxAtaCreates transactions that
 * create one went out (or may have). Exits not tried count as skipped.
 */
async function executeExits(ctx: CrankContext, exits: readonly PlannedExit[], maxAtaCreates: number): Promise<Executed> {
  if (exits.length === 0) return { result: emptyResult(), overCreateCap: 0 }
  let blockhash: BlockhashWithExpiryBlockHeight
  try {
    blockhash = await latestBlockhash(ctx)
  } catch (err) {
    return { result: { sent: [], skipped: exits.length, errors: [`${JOB_NAME}: ${errorMessage(err)}`] }, overCreateCap: 0 }
  }
  let outcomes: readonly Outcome[] = []
  let atasCreated = 0
  let overCreateCap = 0
  for (const exit of exits) {
    if (!mayContinue(ctx, outcomes)) break
    if (exit.createsAta && atasCreated >= maxAtaCreates) {
      overCreateCap += 1
      continue
    }
    const attempt = await attemptExit(ctx, exit, blockhash)
    outcomes = [...outcomes, attempt.outcome]
    blockhash = attempt.blockhash
    if (exit.createsAta && usesBudget(attempt.outcome)) atasCreated += 1
  }
  const result = {
    sent: outcomes.flatMap((o) => (o.kind === 'sent' ? [o.signature] : [])),
    skipped: exits.length - outcomes.length + outcomes.filter((o) => o.kind === 'skipped').length,
    errors: outcomes.flatMap((o) => (o.kind === 'error' ? [o.error] : [])),
  }
  return { result, overCreateCap }
}

/** One line per tick for the exits left to their owners because their quote ATA is missing; no owner is named. */
function logAtaSkips(ctx: CrankContext, guards: AutoExitGuards, belowMinValue: number, overCreateCap: number): void {
  if (belowMinValue + overCreateCap === 0) return
  ctx.log.info('auto-exit: quote ATA missing; exits left to their owners this tick', {
    job: JOB_NAME,
    belowMinValue,
    overCreateCap,
    minAtaValueLamports: guards.minAtaValueLamports,
    maxAtaCreatesPerTick: guards.maxAtaCreatesPerTick,
  })
}

async function runAutoExits(ctx: CrankContext, configured: AutoExitGuards | undefined): Promise<CrankJobResult> {
  if (ctx.maxTx <= 0) return emptyResult()
  const cluster = ctx.cluster
  requirePlanPrograms(cluster)
  const guards = configured ?? defaultCrankGuards(cluster.cluster)
  if (!(await payerAboveFloor(ctx, guards.crankMinSolLamports))) return emptyResult()
  const [positions, nowUnix] = await Promise.all([fetchDeadlinePositions(ctx, cluster.routerProgramId), fetchChainUnixTime(ctx)])
  const due = positions.value.filter((position) => isDue(position, nowUnix))
  const markets = await fetchMarkets(ctx, cluster.routerProgramId, due)
  const poolProgress = await fetchPoolProgress(ctx, cluster.dbcProgramId, markets.value.values())
  const targets = due.flatMap((position) => exitTarget(position, markets.value, poolProgress.value) ?? [])
  const ownerQuoteAtaExists = await fetchAtaExistence(ctx, targets)
  const ata: AtaRule = { ownerQuoteAtaExists, minAtaValueLamports: guards.minAtaValueLamports }
  const plan = planExits(due, markets.value, poolProgress.value, nowUnix, ctx.payer.publicKey, ata)
  const executed = await executeExits(ctx, plan.exits, guards.maxAtaCreatesPerTick)
  logAtaSkips(ctx, guards, plan.belowMinValue, executed.overCreateCap)
  const { result } = executed
  return {
    ...result,
    skipped: result.skipped + plan.belowMinValue,
    errors: [...positions.errors, ...markets.errors, ...poolProgress.errors, ...result.errors],
  }
}

/** RPC errors can quote the RPC URL, and with it the provider key: every error string leaves with URLs reduced to hosts. */
function redactErrors(result: CrankJobResult): CrankJobResult {
  return { ...result, errors: result.errors.map(redactUrls) }
}

/**
 * The job: exits every due position on a live curve (simulated first), at most ctx.maxTx per tick, within `guards`.
 * Without `guards` it uses defaultCrankGuards for ctx.cluster; the worker passes its WorkerConfig. Never throws.
 */
export function createAutoExitJob(guards?: AutoExitGuards): CrankJob {
  return Object.freeze({
    name: JOB_NAME,
    async run(ctx: CrankContext): Promise<CrankJobResult> {
      try {
        return redactErrors(await runAutoExits(ctx, guards))
      } catch (err) {
        return redactErrors({ sent: [], skipped: 0, errors: [`${JOB_NAME}: ${errorMessage(err)}`] })
      }
    },
  })
}

/** The job with the default guards of ctx.cluster. */
export const autoExitJob: CrankJob = createAutoExitJob()
