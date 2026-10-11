/**
 * Crank job "claims" (CRK-03): once a market is finalized, claims the surplus share of every remaining position.
 * claim_surplus is permissionless: the router forces the share into the owner's canonical quote ATA and closes the
 * position to the owner, so the crank gains nothing. It pays the fees, plus the rent of any quote ATA it creates.
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
/** Wall-clock cap on waiting for a confirmation; after it the outcome is unknown and the next tick re-reads the chain. */
const CONFIRM_TIMEOUT_MS = 45_000
/** owner_quote in claim_surplus's accounts: cranker, owner, market, position, owner_quote, ... */
const CLAIM_OWNER_QUOTE_INDEX = 4
/** The only token programs a quote mint can live under. */
const QUOTE_TOKEN_PROGRAMS: readonly PublicKey[] = Object.freeze([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])
/** Router, hook and DBC program ids are the same on every cluster; claimsJob passes ctx.cluster anyway. */
const DEFAULT_CLUSTER: ClusterConfig = getClusterConfig('devnet')

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
 *   or when a position owner is off the ed25519 curve (no canonical ATA can be derived for it).
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
  const accounts = await connection.getProgramAccounts(router, {
    commitment: COMMITMENT,
    filters: positionFilters(market.address),
  })
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
    chunk(atas, MAX_KEYS_PER_CALL).map((keys) => connection.getMultipleAccountsInfo(keys, COMMITMENT)),
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

/* ---------- sending ---------- */

type SubmitOutcome =
  | { readonly kind: 'sent'; readonly signature: string }
  /** Sent, but not confirmed within CONFIRM_TIMEOUT_MS: it may still land, so it is not resent this tick. */
  | { readonly kind: 'unknown'; readonly signature: string }
  | { readonly kind: 'simulation-failed'; readonly reason: string }
  | { readonly kind: 'failed'; readonly submitted: boolean; readonly reason: string }

interface PreparedTransaction {
  readonly tx: VersionedTransaction
  readonly blockhash: BlockhashWithExpiryBlockHeight
  /** Why the simulation failed; null when it succeeded. */
  readonly simulationError: string | null
}

function stringifyError(err: unknown): string {
  try {
    return typeof err === 'string' ? err : JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function describeSimulationError(simulation: SimulatedTransactionResponse): string {
  const decoded = decodeTxError(simulation)
  return decoded === null ? stringifyError(simulation.err) : `${decoded.name}: ${decoded.message}`
}

function signTransaction(payer: Keypair, blockhash: string, instructions: TransactionInstruction[]): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions })
    .compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([payer])
  return tx
}

async function prepareTransaction(ctx: CrankContext, instructions: TransactionInstruction[]): Promise<PreparedTransaction> {
  const blockhash = await ctx.connection.getLatestBlockhash(COMMITMENT)
  const tx = signTransaction(ctx.payer, blockhash.blockhash, instructions)
  const simulation = await ctx.connection.simulateTransaction(tx, { commitment: COMMITMENT })
  const simulationError = simulation.value.err === null ? null : describeSimulationError(simulation.value)
  return { tx, blockhash, simulationError }
}

const TIMED_OUT: unique symbol = Symbol('timed out')

/** Resolves TIMED_OUT after `ms`; the timer is always cleared, and a late rejection of `promise` stays handled. */
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

async function sendAndConfirm(connection: Connection, { tx, blockhash }: PreparedTransaction): Promise<SubmitOutcome> {
  // Just simulated against the same blockhash, so a preflight would only repeat it.
  const signature = await connection.sendTransaction(tx, { skipPreflight: true })
  const confirming = connection.confirmTransaction({ signature, ...blockhash }, COMMITMENT)
  const confirmation = await withTimeout(confirming, CONFIRM_TIMEOUT_MS)
  if (confirmation === TIMED_OUT) return { kind: 'unknown', signature }
  if (confirmation.value.err !== null) {
    const reason = `transaction ${signature} failed on chain: ${stringifyError(confirmation.value.err)}`
    return { kind: 'failed', submitted: true, reason }
  }
  return { kind: 'sent', signature }
}

/** Simulates first: a claim whose simulation fails is skipped, never sent. Never throws. */
async function submitTransaction(ctx: CrankContext, instructions: TransactionInstruction[]): Promise<SubmitOutcome> {
  let prepared: PreparedTransaction
  try {
    prepared = await prepareTransaction(ctx, instructions)
  } catch (err) {
    return { kind: 'failed', submitted: false, reason: errorMessage(err) }
  }
  if (prepared.simulationError !== null) return { kind: 'simulation-failed', reason: prepared.simulationError }
  try {
    return await sendAndConfirm(ctx.connection, prepared)
  } catch (err) {
    return { kind: 'failed', submitted: true, reason: errorMessage(err) }
  }
}

/* ---------- job ---------- */

interface Tally {
  readonly sent: readonly string[]
  readonly skipped: number
  readonly errors: readonly string[]
  /** Transactions submitted this run, landed or not; counted against ctx.maxTx. */
  readonly submitted: number
}

const EMPTY_TALLY: Tally = Object.freeze({ sent: [], skipped: 0, errors: [], submitted: 0 })

/** Every error string passes through redactUrls: web3.js errors can embed the RPC URL and its API key. */
const withErrors = (tally: Tally, errors: readonly string[]): Tally => ({
  ...tally,
  errors: [...tally.errors, ...errors.map(redactUrls)],
})
const withError = (tally: Tally, error: string): Tally => withErrors(tally, [error])
const withSkipped = (tally: Tally, count: number): Tally => ({ ...tally, skipped: tally.skipped + count })
const withSubmitted = (tally: Tally, count: number): Tally => ({ ...tally, submitted: tally.submitted + count })
const budgetLeft = (tally: Tally, maxTx: number): number => Math.max(0, maxTx - tally.submitted)

function toResult(tally: Tally): CrankJobResult {
  return { sent: [...tally.sent], skipped: tally.skipped, errors: [...tally.errors] }
}

function recordOutcome(
  ctx: CrankContext,
  market: MarketAccount,
  position: PositionAccount,
  tally: Tally,
  outcome: SubmitOutcome,
): Tally {
  const fields = {
    market: market.address.toBase58(),
    position: position.address.toBase58(),
    owner: position.owner.toBase58(),
  }
  const claimLabel = `claim for position ${fields.position}`
  switch (outcome.kind) {
    case 'sent':
      ctx.log.info('claims: surplus claimed', { ...fields, signature: outcome.signature })
      return withSubmitted({ ...tally, sent: [...tally.sent, outcome.signature] }, 1)
    case 'unknown': {
      const { signature } = outcome
      const timeoutMs = CONFIRM_TIMEOUT_MS
      ctx.log.warn('claims: confirmation timed out; outcome unknown', { ...fields, signature, timeoutMs })
      const error = `${claimLabel}: transaction ${signature} not confirmed within ${CONFIRM_TIMEOUT_MS} ms; outcome unknown`
      return withSubmitted(withError(tally, error), 1)
    }
    case 'simulation-failed':
      ctx.log.warn('claims: simulation failed; skipped', { ...fields, error: outcome.reason })
      return withSkipped(tally, 1)
    case 'failed':
      return withSubmitted(withError(tally, `${claimLabel}: ${outcome.reason}`), outcome.submitted ? 1 : 0)
  }
}

/** Sends the plan in order until ctx.maxTx is spent; the rest count as skipped and are retried next tick. */
async function sendPlan(
  ctx: CrankContext,
  market: MarketAccount,
  positions: readonly PositionAccount[],
  plan: readonly TransactionInstruction[][],
  tally: Tally,
): Promise<Tally> {
  let current = tally
  for (const [i, position] of positions.entries()) {
    const instructions = plan[i]
    if (instructions === undefined) {
      return withError(current, `claim plan for ${market.address.toBase58()} is missing position ${i}`)
    }
    if (budgetLeft(current, ctx.maxTx) === 0) return withSkipped(current, positions.length - i)
    current = recordOutcome(ctx, market, position, current, await submitTransaction(ctx, instructions))
  }
  return current
}

/** Claims every position of one finalized market. Never throws: a failure becomes an error in the tally. */
async function claimMarket(
  ctx: CrankContext,
  cluster: ClusterConfig,
  market: MarketAccount,
  tally: Tally,
): Promise<Tally> {
  const label = market.address.toBase58()
  try {
    const quoteTokenProgram = quoteTokenProgramOf(cluster, market)
    const fetched = await fetchMarketPositions(ctx.connection, cluster.routerProgramId, market)
    const claimable = fetched.positions.filter((position) => isOnCurve(position.owner))
    const offCurve = fetched.positions.filter((position) => !isOnCurve(position.owner))
    offCurve.forEach((position) =>
      ctx.log.warn('claims: owner is off curve; skipped', {
        market: label, position: position.address.toBase58(), owner: position.owner.toBase58(),
      }),
    )
    const accounts = marketAccountsFor(market, quoteTokenProgram)
    const atas = claimable.map((position) => ownerQuoteAta(accounts, position.owner))
    const ataExists = await fetchAtaExistence(ctx.connection, atas, quoteTokenProgram)
    const plan = planClaims(market, claimable, ataExists, ctx.payer.publicKey, quoteTokenProgram, cluster)
    const withReads = withErrors(withSkipped(tally, offCurve.length), fetched.errors)
    return await sendPlan(ctx, market, claimable, plan, withReads)
  } catch (err) {
    return withError(tally, `market ${label}: ${errorMessage(err)}`)
  }
}

async function runClaims(ctx: CrankContext): Promise<CrankJobResult> {
  if (ctx.maxTx <= 0) return toResult(EMPTY_TALLY)
  const cluster = ctx.cluster
  const markets = await fetchAllMarkets(ctx.connection, cluster.routerProgramId)
  let tally = EMPTY_TALLY
  for (const market of markets.filter((candidate) => candidate.finalized)) {
    if (budgetLeft(tally, ctx.maxTx) === 0) break
    tally = await claimMarket(ctx, cluster, market, tally)
  }
  return toResult(tally)
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
