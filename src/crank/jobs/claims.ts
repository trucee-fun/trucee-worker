/**
 * Crank job "claims" (CRK-03): once a market is finalized, claims the surplus share of every remaining position.
 * claim_surplus is permissionless: the router forces the share into the owner's canonical quote ATA and closes the
 * position to the owner, so the crank gains nothing. It pays the fees, plus the rent of any quote ATA it creates.
 *
 * Each tick first reads and plans finalized markets (stopping once it has as many claims as it may attempt), then
 * fetches one blockhash and sends the claims in order. Every RPC call is bounded by a wall-clock timeout, and a tick
 * attempts at most ctx.maxTx * MAX_ATTEMPTS_PER_TX claims, so positions whose claim keeps failing cost a bounded
 * number of calls per tick.
 */
import { Buffer } from 'node:buffer'
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type BlockhashWithExpiryBlockHeight,
  type Commitment,
  type Connection,
  type GetProgramAccountsFilter,
  type Keypair,
  type SimulatedTransactionResponse,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  claimSurplusInstruction,
  decodePosition,
  decodeTxError,
  fetchAllMarkets,
  getClusterConfig,
  marketAccountsFor,
  type ClusterConfig,
  type MarketAccount,
  type MarketAccounts,
  type PositionAccount,
} from '@trucee/sdk'
import { errorMessage, redactUrls } from '../../log.js'
import type { CrankContext, CrankJob, CrankJobResult } from '../index.js'

const JOB_NAME = 'claims'
const COMMITMENT: Commitment = 'confirmed'
/** sha256("account:Position")[..8], as in the SDK decoder. */
const POSITION_DISCRIMINATOR: readonly number[] = Object.freeze([170, 188, 143, 228, 122, 64, 247, 208])
/** Position layout: discriminator 8 | owner 32 | market 32 | ... */
const POSITION_MARKET_OFFSET = 40
/** getMultipleAccounts accepts at most 100 keys per call. */
const MAX_KEYS_PER_CALL = 100
/** Wall-clock bound on every RPC call except confirmation, so a stalled RPC cannot hold the tick open. */
export const RPC_TIMEOUT_MS = 30_000
/** Wall-clock bound on one confirmation; after it the outcome is unknown and the next tick re-reads the chain. */
export const CONFIRM_TIMEOUT_MS = 45_000
/** Claims attempted per tick (simulated, failed or sent) are capped at ctx.maxTx times this. */
export const MAX_ATTEMPTS_PER_TX = 3
/** owner_quote in claim_surplus's accounts: cranker, owner, market, position, owner_quote, ... */
const CLAIM_OWNER_QUOTE_INDEX = 4
/** The only token programs a quote mint can live under. */
const QUOTE_TOKEN_PROGRAMS: readonly PublicKey[] = Object.freeze([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])
/** Router, hook and DBC program ids are the same on every cluster; claimsJob passes ctx.cluster anyway. */
const DEFAULT_CLUSTER: ClusterConfig = getClusterConfig('devnet')
const TIMED_OUT: unique symbol = Symbol('timed out')

/* ---------- planner ---------- */

function requireQuoteTokenProgram(program: PublicKey): PublicKey {
  if (!QUOTE_TOKEN_PROGRAMS.some((allowed) => allowed.equals(program))) {
    throw new TypeError(`quoteTokenProgram must be the SPL Token or Token-2022 program, got ${program.toBase58()}`)
  }
  return program
}

function requirePositionOf(market: MarketAccount, position: PositionAccount): PositionAccount {
  if (!position.market.equals(market.address)) {
    const [address, own, other] = [position.address, market.address, position.market].map((key) => key.toBase58())
    throw new Error(`position ${address} belongs to another market (${other}), not ${own}`)
  }
  return position
}

/** The owner's canonical quote ATA, the only account claim_surplus may pay. Throws for an owner off the curve. */
function ownerQuoteAta(accounts: MarketAccounts, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(accounts.quoteMint, owner, false, accounts.quoteTokenProgram)
}

function planClaim(
  accounts: MarketAccounts,
  owner: PublicKey,
  ownerQuoteAtaExists: ReadonlyMap<string, boolean>,
  payer: PublicKey,
  cluster: ClusterConfig,
): TransactionInstruction[] {
  const ownerQuote = ownerQuoteAta(accounts, owner)
  const claim = claimSurplusInstruction({ cluster, accounts, cranker: payer, owner })
  // The router enforces this too; failing here keeps a wrong builder from ever reaching the chain.
  if (claim.keys[CLAIM_OWNER_QUOTE_INDEX]?.pubkey.equals(ownerQuote) !== true) {
    throw new Error(`claim_surplus for owner ${owner.toBase58()} does not pay the owner's canonical quote ATA`)
  }
  if (ownerQuoteAtaExists.get(ownerQuote.toBase58()) === true) return [claim]
  const createAta = createAssociatedTokenAccountIdempotentInstruction(
    payer, ownerQuote, owner, accounts.quoteMint, accounts.quoteTokenProgram,
  )
  return [createAta, claim]
}

/**
 * One transaction per position, in input order: claim_surplus with `payer` as cranker, preceded by an idempotent
 * creation (paid by `payer`) of the owner's canonical quote ATA unless `ownerQuoteAtaExists` maps that ATA's
 * base58 address to true. Plans nothing until the market is finalized.
 *
 * @param cluster program ids for the instructions; defaults to the SDK's, which are the same on every cluster.
 * @throws when `quoteTokenProgram` is not SPL Token or Token-2022, when a position belongs to another market,
 *   when a position owner is off the ed25519 curve (no canonical ATA can be derived for it), or when the SDK's
 *   claim instruction would pay any account other than the owner's canonical quote ATA.
 */
export function planClaims(
  market: MarketAccount,
  positions: readonly PositionAccount[],
  ownerQuoteAtaExists: ReadonlyMap<string, boolean>,
  payer: PublicKey,
  quoteTokenProgram: PublicKey,
  cluster: ClusterConfig = DEFAULT_CLUSTER,
): TransactionInstruction[][] {
  if (!market.finalized) return []
  const accounts = marketAccountsFor(market, requireQuoteTokenProgram(quoteTokenProgram))
  return positions.map((position) =>
    planClaim(accounts, requirePositionOf(market, position).owner, ownerQuoteAtaExists, payer, cluster),
  )
}

/* ---------- timeouts ---------- */

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

/** Awaits one RPC call for at most RPC_TIMEOUT_MS; throws when it does not answer in time. */
async function rpc<T>(call: Promise<T>, name: string): Promise<T> {
  const result = await withTimeout(call, RPC_TIMEOUT_MS)
  if (result === TIMED_OUT) throw new Error(`${name} not answered within ${RPC_TIMEOUT_MS} ms`)
  return result
}

/* ---------- reads ---------- */

function positionFilters(market: PublicKey): GetProgramAccountsFilter[] {
  return [
    { memcmp: { offset: 0, bytes: Buffer.from(POSITION_DISCRIMINATOR).toString('base64'), encoding: 'base64' } },
    { memcmp: { offset: POSITION_MARKET_OFFSET, bytes: market.toBase58() } },
  ]
}

interface MarketPositions {
  readonly positions: readonly PositionAccount[]
  /** Accounts that failed to decode or name another market; they are reported, never claimed. */
  readonly errors: readonly string[]
}

type DecodedPosition = { readonly position: PositionAccount } | { readonly error: string }

function decodeOwnPosition(market: MarketAccount, address: PublicKey, data: Buffer): DecodedPosition {
  try {
    return { position: requirePositionOf(market, decodePosition(address, data)) }
  } catch (err) {
    return { error: `position ${address.toBase58()}: ${errorMessage(err)}` }
  }
}

async function fetchMarketPositions(
  connection: Connection,
  router: PublicKey,
  market: MarketAccount,
): Promise<MarketPositions> {
  const config = { commitment: COMMITMENT, filters: positionFilters(market.address) }
  const accounts = await rpc(connection.getProgramAccounts(router, config), 'getProgramAccounts(positions)')
  const decoded = accounts.map(({ pubkey, account }) => decodeOwnPosition(market, pubkey, account.data))
  return {
    positions: decoded.flatMap((entry) => ('position' in entry ? [entry.position] : [])),
    errors: decoded.flatMap((entry) => ('error' in entry ? [entry.error] : [])),
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
}

/**
 * ATA base58 address to whether it is a live token account. Anyone can send lamports to an ATA address before it
 * exists, so only an account owned by the quote token program counts; anything else gets the idempotent create.
 */
async function fetchAtaExistence(
  connection: Connection,
  atas: readonly PublicKey[],
  tokenProgram: PublicKey,
): Promise<Map<string, boolean>> {
  const batches = await Promise.all(
    chunk(atas, MAX_KEYS_PER_CALL).map((keys) =>
      rpc(connection.getMultipleAccountsInfo(keys, COMMITMENT), 'getMultipleAccountsInfo'),
    ),
  )
  const infos = batches.flat()
  return new Map(atas.map((ata, i) => [ata.toBase58(), infos[i]?.owner.equals(tokenProgram) === true]))
}

function quoteTokenProgramOf(cluster: ClusterConfig, market: MarketAccount): PublicKey {
  const quote = cluster.quoteMints.find((info) => info.mint.equals(market.quoteMint))
  if (quote === undefined) {
    throw new Error(`quote mint ${market.quoteMint.toBase58()} is not configured for ${cluster.cluster}`)
  }
  return quote.tokenProgram
}

const isOnCurve = (owner: PublicKey): boolean => PublicKey.isOnCurve(owner.toBytes())

/**
 * Off-curve positions already warned about. They are skipped (and counted) every tick, but a warning every tick
 * would only repeat itself, so each is logged once per process.
 */
let reportedOffCurve: ReadonlySet<string> = new Set()

function reportOffCurve(ctx: CrankContext, market: MarketAccount, positions: readonly PositionAccount[]): void {
  const fresh = positions.filter((position) => !reportedOffCurve.has(position.address.toBase58()))
  fresh.forEach((position) =>
    ctx.log.warn('claims: owner is off curve; skipped', {
      market: market.address.toBase58(), position: position.address.toBase58(), owner: position.owner.toBase58(),
    }),
  )
  reportedOffCurve = new Set([...reportedOffCurve, ...fresh.map((position) => position.address.toBase58())])
}

/* ---------- per-market plan ---------- */

interface PlannedClaim {
  readonly market: MarketAccount
  readonly position: PositionAccount
  readonly instructions: TransactionInstruction[]
}

interface MarketPlan {
  readonly claims: readonly PlannedClaim[]
  readonly skipped: number
  readonly errors: readonly string[]
}

async function readAndPlanMarket(ctx: CrankContext, cluster: ClusterConfig, market: MarketAccount): Promise<MarketPlan> {
  const quoteTokenProgram = quoteTokenProgramOf(cluster, market)
  const fetched = await fetchMarketPositions(ctx.connection, cluster.routerProgramId, market)
  const claimable = fetched.positions.filter((position) => isOnCurve(position.owner))
  const offCurve = fetched.positions.filter((position) => !isOnCurve(position.owner))
  reportOffCurve(ctx, market, offCurve)
  const accounts = marketAccountsFor(market, quoteTokenProgram)
  const atas = claimable.map((position) => ownerQuoteAta(accounts, position.owner))
  const ataExists = await fetchAtaExistence(ctx.connection, atas, quoteTokenProgram)
  const plan = planClaims(market, claimable, ataExists, ctx.payer.publicKey, quoteTokenProgram, cluster)
  if (plan.length !== claimable.length) {
    throw new Error(`planned ${plan.length} claims for ${claimable.length} positions`)
  }
  const claims = claimable.map((position, i) => ({ market, position, instructions: plan[i] ?? [] }))
  return { claims, skipped: offCurve.length, errors: fetched.errors }
}

/** Reads and plans one finalized market. Never throws: a failure becomes the market's only error. */
async function planMarket(ctx: CrankContext, cluster: ClusterConfig, market: MarketAccount): Promise<MarketPlan> {
  try {
    return await readAndPlanMarket(ctx, cluster, market)
  } catch (err) {
    return { claims: [], skipped: 0, errors: [`market ${market.address.toBase58()}: ${errorMessage(err)}`] }
  }
}

/* ---------- sending ---------- */

type SubmitOutcome =
  | { readonly kind: 'sent'; readonly signature: string }
  /** Sent, but the send or its confirmation did not answer in time: it may still land, so it is not resent. */
  | { readonly kind: 'unknown'; readonly signature: string | null; readonly reason: string }
  | { readonly kind: 'simulation-failed'; readonly reason: string }
  | { readonly kind: 'failed'; readonly submitted: boolean; readonly reason: string }

function stringifyError(err: unknown): string {
  try {
    return typeof err === 'string' ? err : JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function describeSimulationError(simulation: SimulatedTransactionResponse): string {
  const decoded = decodeTxError({ error: simulation.err, logs: simulation.logs })
  return decoded === null ? stringifyError(simulation.err) : `${decoded.name}: ${decoded.message}`
}

function signTransaction(payer: Keypair, blockhash: string, instructions: TransactionInstruction[]): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions })
    .compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([payer])
  return tx
}

async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  blockhash: BlockhashWithExpiryBlockHeight,
): Promise<SubmitOutcome> {
  // Just simulated against the same blockhash, so a preflight would only repeat it.
  const sent = await withTimeout(connection.sendTransaction(tx, { skipPreflight: true }), RPC_TIMEOUT_MS)
  if (sent === TIMED_OUT) {
    return { kind: 'unknown', signature: null, reason: `send not answered within ${RPC_TIMEOUT_MS} ms` }
  }
  const confirming = connection.confirmTransaction({ signature: sent, ...blockhash }, COMMITMENT)
  const confirmation = await withTimeout(confirming, CONFIRM_TIMEOUT_MS)
  if (confirmation === TIMED_OUT) {
    return { kind: 'unknown', signature: sent, reason: `transaction ${sent} not confirmed within ${CONFIRM_TIMEOUT_MS} ms` }
  }
  if (confirmation.value.err !== null) {
    const reason = `transaction ${sent} failed on chain: ${stringifyError(confirmation.value.err)}`
    return { kind: 'failed', submitted: true, reason }
  }
  return { kind: 'sent', signature: sent }
}

/** Signs and simulates first: a claim whose simulation fails is skipped, never sent. Never throws. */
async function submitTransaction(
  ctx: CrankContext,
  blockhash: BlockhashWithExpiryBlockHeight,
  instructions: TransactionInstruction[],
): Promise<SubmitOutcome> {
  let tx: VersionedTransaction
  try {
    tx = signTransaction(ctx.payer, blockhash.blockhash, instructions)
    const simulation = await rpc(ctx.connection.simulateTransaction(tx, { commitment: COMMITMENT }), 'simulateTransaction')
    if (simulation.value.err !== null) {
      return { kind: 'simulation-failed', reason: describeSimulationError(simulation.value) }
    }
  } catch (err) {
    return { kind: 'failed', submitted: false, reason: errorMessage(err) }
  }
  try {
    return await sendAndConfirm(ctx.connection, tx, blockhash)
  } catch (err) {
    return { kind: 'failed', submitted: true, reason: errorMessage(err) }
  }
}

/* ---------- tally ---------- */

interface Tally {
  readonly sent: readonly string[]
  readonly skipped: number
  readonly errors: readonly string[]
  /** Transactions submitted this tick, landed or not; capped at ctx.maxTx. */
  readonly submitted: number
  /** Claims attempted this tick (simulated at least); capped at ctx.maxTx * MAX_ATTEMPTS_PER_TX. */
  readonly attempts: number
}

const EMPTY_TALLY: Tally = Object.freeze({ sent: [], skipped: 0, errors: [], submitted: 0, attempts: 0 })

/** Every error string passes through redactUrls: web3.js errors can embed the RPC URL and its API key. */
const withErrors = (tally: Tally, errors: readonly string[]): Tally => ({
  ...tally,
  errors: [...tally.errors, ...errors.map(redactUrls)],
})
const withError = (tally: Tally, error: string): Tally => withErrors(tally, [error])
const withSkipped = (tally: Tally, count: number): Tally => ({ ...tally, skipped: tally.skipped + count })
const withSubmitted = (tally: Tally, count: number): Tally => ({ ...tally, submitted: tally.submitted + count })
const maxAttempts = (maxTx: number): number => maxTx * MAX_ATTEMPTS_PER_TX
const canAttempt = (tally: Tally, maxTx: number): boolean =>
  tally.submitted < maxTx && tally.attempts < maxAttempts(maxTx)

function toResult(tally: Tally): CrankJobResult {
  return { sent: [...tally.sent], skipped: tally.skipped, errors: [...tally.errors] }
}

function recordOutcome(ctx: CrankContext, claim: PlannedClaim, tally: Tally, outcome: SubmitOutcome): Tally {
  const fields = {
    market: claim.market.address.toBase58(),
    position: claim.position.address.toBase58(),
    owner: claim.position.owner.toBase58(),
  }
  const claimLabel = `claim for position ${fields.position}`
  switch (outcome.kind) {
    case 'sent':
      ctx.log.info('claims: surplus claimed', { ...fields, signature: outcome.signature })
      return withSubmitted({ ...tally, sent: [...tally.sent, outcome.signature] }, 1)
    case 'unknown':
      ctx.log.warn('claims: outcome unknown; not resent this tick', {
        ...fields, signature: outcome.signature, reason: outcome.reason,
      })
      return withSubmitted(withError(tally, `${claimLabel}: ${outcome.reason}; outcome unknown`), 1)
    case 'simulation-failed':
      ctx.log.warn('claims: simulation failed; skipped', { ...fields, error: outcome.reason })
      return withSkipped(tally, 1)
    case 'failed':
      return withSubmitted(withError(tally, `${claimLabel}: ${outcome.reason}`), outcome.submitted ? 1 : 0)
  }
}

/* ---------- job ---------- */

/** Reads and plans finalized markets in order until there are enough claims to fill the tick's attempt cap. */
async function planTick(ctx: CrankContext, cluster: ClusterConfig): Promise<MarketPlan> {
  const markets = await rpc(fetchAllMarkets(ctx.connection, cluster.routerProgramId), 'fetchAllMarkets')
  let claims: readonly PlannedClaim[] = []
  let skipped = 0
  let errors: readonly string[] = []
  for (const market of markets.filter((candidate) => candidate.finalized)) {
    if (claims.length >= maxAttempts(ctx.maxTx)) break
    const plan = await planMarket(ctx, cluster, market)
    claims = [...claims, ...plan.claims]
    skipped += plan.skipped
    errors = [...errors, ...plan.errors]
  }
  return { claims, skipped, errors }
}

/** Sends the planned claims in order on one blockhash until ctx.maxTx sends or the attempt cap; the rest are skipped. */
async function sendClaims(ctx: CrankContext, claims: readonly PlannedClaim[], tally: Tally): Promise<Tally> {
  let blockhash: BlockhashWithExpiryBlockHeight
  try {
    blockhash = await rpc(ctx.connection.getLatestBlockhash(COMMITMENT), 'getLatestBlockhash')
  } catch (err) {
    return withSkipped(withError(tally, errorMessage(err)), claims.length)
  }
  let current = tally
  for (const [i, claim] of claims.entries()) {
    if (!canAttempt(current, ctx.maxTx)) return withSkipped(current, claims.length - i)
    const outcome = await submitTransaction(ctx, blockhash, claim.instructions)
    current = recordOutcome(ctx, claim, { ...current, attempts: current.attempts + 1 }, outcome)
  }
  return current
}

async function runClaims(ctx: CrankContext): Promise<CrankJobResult> {
  if (ctx.maxTx <= 0) return toResult(EMPTY_TALLY)
  const plan = await planTick(ctx, ctx.cluster)
  const planned = withErrors(withSkipped(EMPTY_TALLY, plan.skipped), plan.errors)
  if (plan.claims.length === 0) return toResult(planned)
  return toResult(await sendClaims(ctx, plan.claims, planned))
}

export const claimsJob: CrankJob = Object.freeze({
  name: JOB_NAME,
  async run(ctx: CrankContext): Promise<CrankJobResult> {
    try {
      return await runClaims(ctx)
    } catch (err) {
      return toResult(withError(EMPTY_TALLY, `claims: ${errorMessage(err)}`))
    }
  },
})
