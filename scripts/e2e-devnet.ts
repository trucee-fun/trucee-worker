/**
 * SDK-driven devnet E2E from market launch through graduation and surplus claims on router v5.
 * Every run launches a fresh wSOL market (threshold 0.3 SOL) and walks it from launch to surplus claim: launch (1),
 * seven wrapped buys whose quoteBuy matches each BuyEvent (2), the floor until graduation equals a full refund
 * before graduation (basis minus fee at cost minus the 2-lamport haircut) (3), a half exit before graduation equals
 * quoteExit (4), hook rejections 6000 of a direct DBC buy and a wallet transfer (5), Anti-Whale
 * rejection 6022 (6), Auto-Exit by the real autoExitJob (7), graduation under the cap with the hook revoked (8), the
 * real finalizeJob (9), migrateJob to DAMM v2 (10) and claimsJob (11), a plain transfer after graduation (12) and the
 * sweep of every trader's SOL (13). Each step prints a PASS or FAIL line; the last line is "<p> passed, <f> failed".
 * A step that throws stops the journey: later steps report FAIL (not run), a live curve's positions exit at cost and
 * the traders are swept.
 *
 * Crank jobs run one tick at a time on a connection scoped to this market (scopeToMarket): finalizeJob, createClaimsJob
 * and createAutoExitJob scan every router market or position and take no market filter, so their router scans return
 * only this market and its positions; createMigrateJob also gets a listMarkets override. Every signature a job sends
 * must touch this market or its pool. Traders follow scripts/seed-devnet.ts: keys go to
 * out/e2e-devnet.traders.json (mode 0600, gitignored) before any is funded and an existing file is reused, never
 * overwritten; the payer pays every fee and tops a trader up per buy; buys are pre-checked against the cap.
 *
 * Usage (from worker/; the RPC URL never reaches argv or the output):
 *   RPC_URL="$DEVNET_RPC" npx tsx scripts/e2e-devnet.ts > out/e2e-devnet.log 2>&1
 *   node --env-file=../litesvm-diff/.env --import tsx scripts/e2e-devnet.ts > out/e2e-devnet.log 2>&1
 * Env: RPC_URL (falls back to DEVNET_RPC; must answer with devnet's genesis hash), PAYER_KEYPAIR (default
 * ~/.config/solana/id.json). Output: out/e2e-devnet.json (accounts and signatures per step). Exit 0 when 0 failed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import {
  Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SendTransactionError, SystemProgram, Transaction,
  TransactionExpiredBlockheightExceededError,
  type Commitment, type GetProgramAccountsConfig, type GetProgramAccountsResponse, type TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, createTransferCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction, getAssociatedTokenAddressSync, getMint, getTransferHook, unpackAccount,
} from '@solana/spl-token'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS, DAMM_V2_PROGRAM_ID, DynamicBondingCurveClient, SwapMode, createDbcProgram,
  deriveDammV2PoolAddress, type ConfigWithTransferHook, type TransferHookPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import {
  POSITION_ACCOUNT_SIZE_V2, buildLaunchPlan, buyInstructions, decodePosition, decodeTxError, fetchMarket, findPositionPda,
  floorValue, getClusterConfig, marketAccountsFor, parseRouterEvents, quoteBuy, quoteExit, sellInstructions,
  setAutoExitInstructions,
  type BuyQuote, type ClusterConfig, type DecodedTxError, type MarketAccount, type MarketAccounts, type PositionAccount,
  type QuoteMintInfo, type RouterEvent,
} from '@trucee/sdk'
import { z } from 'zod'
import { loadConfig, loadCrankKeypair, type WorkerConfig } from '../src/config.js'
import type { CrankContext, CrankJob, CrankJobResult } from '../src/crank/index.js'
import { createAutoExitJob } from '../src/crank/jobs/auto-exit.js'
import { createClaimsJob } from '../src/crank/jobs/claims.js'
import { finalizeJob } from '../src/crank/jobs/finalize.js'
import { createMigrateJob } from '../src/crank/jobs/migrate.js'
import { errorMessage, log, registerSecret } from '../src/log.js'

/* ---------- constants ---------- */
const OUT_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'out')
const OUTPUT_PATH = join(OUT_DIR, 'e2e-devnet.json')
const TRADERS_PATH = join(OUT_DIR, 'e2e-devnet.traders.json')
const TRADERS_FILE_MODE = 0o600
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const COMMITMENT: Commitment = 'confirmed'
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1'])
const DEFAULT_PAYER_KEYPAIR = '~/.config/solana/id.json'
const MIN_SECRET_FRAGMENT = 8
const LAMPORTS_PER_SOL = 1_000_000_000n
const MIGRATION_QUOTE_THRESHOLD = 300_000_000n
const FEE_BPS = 100
/** No metadata app runs in the E2E; the uri sits under the reserved .invalid TLD, so nothing ever resolves it. */
const TOKEN = Object.freeze({ name: 'Trucee E2E', symbol: 'E2E', uri: 'https://trucee.invalid/e2e-devnet.json' })
const TRADER_COUNT = 7
const BPS = 10_000n
/** zpvp_router ANTI_WHALE_BPS: one position may hold at most 20% of the config's swap_base_amount. */
const ANTI_WHALE_BPS = 2_000n
/** Spread buy size: 40 chunks fill the curve. */
const BUY_CHUNK = MIGRATION_QUOTE_THRESHOLD / 40n
const PERCENT = 100n
/** Buys accept at most 1% less than quoted (only this run trades its fresh market). */
const MIN_OUT_PERCENT = 99n
const HALF_PERCENT = 50n
/** The run stops before any step that would take the payer below 5 SOL. */
const PAYER_FLOOR_LAMPORTS = 5n * LAMPORTS_PER_SOL
/** One 0.3 SOL curve, rents, fees and the DAMM v2 migration, with a margin. */
const ESTIMATED_SPEND_LAMPORTS = LAMPORTS_PER_SOL
/** A trader's first buy in a market: base ATA, position and maybe the wSOL ATA rent (~0.0058 SOL), rounded up. */
const FIRST_BUY_RENT_LAMPORTS = 7_000_000n
/** Kept on a trader after each buy so its wallet never drops below the rent-exempt minimum (0.00089 SOL). */
const TRADER_FLOAT_LAMPORTS = 2_000_000n
const DIRECT_BUY_LAMPORTS = 1_000_000n
const LIMITS = Object.freeze({ sendAttempts: 3, graduationBuys: 150, claimTicks: 3, logTailLines: 8, txFetchAttempts: 15 })
const TIMING = Object.freeze({ autoExitDelaySeconds: 20n, clockPollMs: 2_000, clockWaitMaxMs: 120_000, txFetchDelayMs: 1_000 })
const BASE_DECIMALS = 6
const EXPECTED_CODE = Object.freeze({ hookTransferNotViaRouter: 6000, routerPositionCapExceeded: 6022 })
/** Trader roles by index. The Auto-Exit trader sits out the graduation buys. */
const ROLE = Object.freeze({ floor: 0, halfExit: 1, autoExit: 2, hookProbe: 3, whaleProbe: 4, transferFrom: 5, transferTo: 6 })
const PRICE_MOVERS: readonly number[] = [5, 6]
const GRADUATION_TRADERS: readonly number[] = [0, 1, 3, 4, 5, 6]
/** DBC MigrationProgress (worker/src/crank/jobs/migrate.ts). */
const PRE_BONDING_CURVE = 0
const CREATED_POOL = 3
/** Position: discriminator 8 | owner 32 | market 32 | ... */
const POSITION_MARKET_OFFSET = 40
const PUBKEY_BYTES = 32
const POSITION_DISCRIMINATOR = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208])
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32

/**
 * Crank guards of this E2E, read through loadConfig like the worker's env. A 0.3 SOL curve over seven traders pays
 * refunds and surplus shares of about 0.001-0.05 SOL, all under the 0.25 SOL default MIN_ATA_VALUE_LAMPORTS, so with
 * the default the jobs would skip any owner whose wSOL ATA is missing. 0 lets them create it; its rent comes back to
 * the payer when the sweep closes the ATA. MAX_ATA_CREATES_PER_TICK 10 covers all seven owners in one tick.
 * CRANK_MIN_SOL_LAMPORTS keeps the 0.05 SOL default (the payer floor is 5 SOL). MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS 0
 * is the devnet default, written out so the 0.3 SOL pool is migrated. MAX_TX_PER_TICK keeps the default 10.
 */
const E2E_CRANK_ENV = Object.freeze({
  CLUSTER: 'devnet', MAX_TX_PER_TICK: '10', MIN_ATA_VALUE_LAMPORTS: '0', MAX_ATA_CREATES_PER_TICK: '10',
  CRANK_MIN_SOL_LAMPORTS: '50000000', MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS: '0',
})
const STEP_NAMES: readonly string[] = [
  'launch: wSOL market via buildLaunchPlan, threshold 0.3 SOL',
  '7 traders buy (wrap): every quoteBuy prediction matches its BuyEvent',
  'Your floor: floorValue equals the on-chain refund of a later full exit',
  'exit at cost: refund == quoteExit.refund',
  'hook rejects a direct DBC buy and a wallet-to-wallet transfer (6000)',
  'a buy above 20% of the curve supply is rejected (6022)',
  'Auto-Exit 20 s ahead: autoExitJob exits after the deadline, refund == floor',
  'graduation: no position above the cap, transfer hook revoked',
  'finalizeJob: market finalized',
  'migrateJob: DAMM v2 pool exists',
  'claimsJob: every position closed, sum of shares <= surplus snapshot',
  'after graduation: plain wallet transfer succeeds',
  'sweep: trader SOL returned to the payer',
]

/* ---------- types ---------- */
interface Ctx {
  readonly connection: Connection; readonly cluster: ClusterConfig; readonly quote: QuoteMintInfo; readonly payer: Keypair
  readonly traders: readonly Keypair[]; readonly dbc: ReturnType<typeof createDbcProgram>['program']; readonly cfg: WorkerConfig
}
/** `scoped`: connection whose router scans see only this market and its positions (for the crank jobs). */
interface Live { readonly market: MarketAccount; readonly accounts: MarketAccounts; readonly cap: bigint; readonly scoped: Connection }
interface CurveState { readonly quoteReserve: bigint; readonly migrationProgress: number; readonly isMigrated: boolean }
interface Outcome {
  readonly pass: boolean; readonly detail: string
  readonly signatures?: Readonly<Record<string, string | readonly string[]>>; readonly accounts?: Readonly<Record<string, string>>
}
interface StepRecord extends Outcome { readonly n: number; readonly name: string }
interface Report { readonly steps: StepRecord[]; readonly accounts: Record<string, string>; save(extra?: Readonly<Record<string, unknown>>): void }
interface SweepRow { readonly trader: string; readonly lamports: string; readonly signature: string | null; readonly error?: string }
interface Buy { readonly signature: string; readonly quote: BuyQuote; readonly before: PositionAccount | null }
type EventNamed<N extends RouterEvent['name']> = Extract<RouterEvent, { name: N }>
/** `received`: change of the trader's wSOL ATA balance. */
interface Exit { readonly signature: string; readonly event: EventNamed<'SellEvent'>; readonly received: bigint }
type Rejection = { readonly landed: false; readonly decoded: DecodedTxError | null } | { readonly landed: true; readonly signature: string }
type Blockhash = Awaited<ReturnType<Connection['getLatestBlockhash']>>
class Abort extends Error {}

/* ---------- RPC URL, secrets and small helpers ---------- */
function parseRpcUrl(env: NodeJS.ProcessEnv): URL {
  const raw = [env.RPC_URL, env.DEVNET_RPC].map((v) => v?.trim()).find((v) => v !== undefined && v !== '')
  if (raw === undefined) throw new Error('RPC_URL is required (load DEVNET_RPC from litesvm-diff/.env)')
  const url = URL.canParse(raw) ? new URL(raw) : null
  const isLocalHttp = url?.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(url.hostname)
  if (url === null || (url.protocol !== 'https:' && !isLocalHttp)) throw new Error('RPC_URL must be an https URL')
  return url
}

let scrubList: readonly string[] = []
/** Removes every part of the RPC URL that could identify the provider or carry its key. */
const scrub = (text: string): string => scrubList.reduce((acc, part) => acc.split(part).join('[redacted]'), text)
/** Registers the URL parts with the logger, and scrubs console output (web3.js retry and websocket lines) too. */
function protectRpcUrl(url: URL): void {
  const parts = [url.href, url.origin, url.host, url.hostname, url.pathname, url.search, ...url.pathname.split('/'), ...url.searchParams.values()]
  scrubList = [...new Set(parts.filter((part) => part.length >= MIN_SECRET_FRAGMENT))].sort((a, b) => b.length - a.length)
  scrubList.forEach(registerSecret)
  const toStdout = (...args: unknown[]): void => void process.stdout.write(`${scrub(format(...args))}\n`)
  const toStderr = (...args: unknown[]): void => void process.stderr.write(`${scrub(format(...args))}\n`)
  Object.assign(console, { log: toStdout, info: toStdout, warn: toStderr, error: toStderr })
}

const fail = (message: string): never => { throw new Error(message) }
const formatSol = (lamports: bigint): string => {
  const abs = lamports < 0n ? -lamports : lamports
  return `${lamports < 0n ? '-' : ''}${abs / LAMPORTS_PER_SOL}.${(abs % LAMPORTS_PER_SOL).toString().padStart(9, '0')}`
}
const toBigint = (value: { toString(): string }): bigint => BigInt(value.toString())
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const tokensOf = (position: PositionAccount | null): bigint => position?.tokens ?? 0n
const isCode = (decoded: DecodedTxError | null, program: DecodedTxError['program'], code: number): boolean =>
  decoded?.program === program && decoded.code === code
const describeRejection = (r: Rejection): string =>
  r.landed ? `LANDED ${r.signature}` : r.decoded === null ? 'undecoded error' : `${r.decoded.program} ${r.decoded.code ?? '-'} ${r.decoded.name}`
const trader = (ctx: Ctx, i: number): Keypair => ctx.traders[i] ?? fail(`no trader ${i}`)
const lamportsOf = async (ctx: Ctx, key: PublicKey): Promise<bigint> => BigInt(await ctx.connection.getBalance(key, COMMITMENT))

/** Throws before a step that would take the payer below PAYER_FLOOR_LAMPORTS. */
async function guardPayer(ctx: Ctx, spend: bigint): Promise<void> {
  const balance = await lamportsOf(ctx, ctx.payer.publicKey)
  if (balance - spend < PAYER_FLOOR_LAMPORTS) throw new Error(`payer balance ${formatSol(balance)} SOL minus ${formatSol(spend)} would drop below the ${formatSol(PAYER_FLOOR_LAMPORTS)} SOL floor`)
}

/* ---------- sending ---------- */
function describeSendError(err: unknown): string {
  const decoded = decodeTxError(err)
  const logs = err instanceof SendTransactionError ? (err.logs ?? []) : []
  const name = decoded === null ? errorMessage(err) : `${decoded.program} ${decoded.name}: ${decoded.message}`
  const tail = logs.slice(-LIMITS.logTailLines).join(' | ')
  return scrub(tail === '' ? name : `${name} (logs: ${tail})`)
}

async function signed(ctx: Ctx, instructions: readonly TransactionInstruction[], signers: readonly Keypair[]): Promise<{ tx: Transaction; latest: Blockhash }> {
  const latest = await ctx.connection.getLatestBlockhash(COMMITMENT)
  const tx = new Transaction({ feePayer: ctx.payer.publicKey, ...latest }).add(...instructions)
  const all = [ctx.payer, ...signers]
  tx.sign(...all.filter((s, i) => all.findIndex((t) => t.publicKey.equals(s.publicKey)) === i))
  return { tx, latest }
}

/** 'expired' when the blockhash expired before confirmation; throws when the transaction failed. */
async function confirmOrExpire(ctx: Ctx, label: string, signature: string, latest: Blockhash): Promise<'confirmed' | 'expired'> {
  try {
    const { value } = await ctx.connection.confirmTransaction({ signature, ...latest }, COMMITMENT)
    if (value.err !== null) throw new Error(`${label}: transaction ${signature} failed: ${JSON.stringify(value.err)}`)
    return 'confirmed'
  } catch (err) {
    if (err instanceof TransactionExpiredBlockheightExceededError) return 'expired'
    throw new Error(scrub(errorMessage(err)))
  }
}

/** True when an expired transaction never landed, so sending it again cannot execute it twice. */
async function neverLanded(ctx: Ctx, label: string, signature: string): Promise<boolean> {
  const { value } = await ctx.connection.getSignatureStatus(signature, { searchTransactionHistory: true })
  if (value !== null && value.err !== null) throw new Error(`${label}: transaction ${signature} failed: ${JSON.stringify(value.err)}`)
  return value === null
}

/** Sends with the payer as fee payer; resends only an expired transaction that never landed (as the seed script). */
async function send(ctx: Ctx, label: string, instructions: readonly TransactionInstruction[], signers: readonly Keypair[]): Promise<string> {
  for (let attempt = 1; attempt <= LIMITS.sendAttempts; attempt++) {
    const { tx, latest } = await signed(ctx, instructions, signers)
    let signature: string
    try {
      signature = await ctx.connection.sendRawTransaction(tx.serialize(), { preflightCommitment: COMMITMENT })
    } catch (err) {
      throw new Error(`${label}: ${describeSendError(err)}`)
    }
    if ((await confirmOrExpire(ctx, label, signature, latest)) === 'confirmed') return signature
    if (!(await neverLanded(ctx, label, signature))) return signature
    log.warn('blockhash expired before confirmation, resending', { label, attempt })
  }
  throw new Error(`${label}: not confirmed after ${LIMITS.sendAttempts} attempts`)
}

/** Sends with preflight: a transaction the programs reject never leaves the RPC, and its error is decoded. */
async function sendExpectingRejection(ctx: Ctx, label: string, instructions: readonly TransactionInstruction[], signers: readonly Keypair[]): Promise<Rejection> {
  const { tx, latest } = await signed(ctx, instructions, signers)
  try {
    const signature = await ctx.connection.sendRawTransaction(tx.serialize(), { preflightCommitment: COMMITMENT })
    await confirmOrExpire(ctx, label, signature, latest)
    return { landed: true, signature }
  } catch (err) {
    log.info('rejected as expected', { label, error: describeSendError(err) })
    return { landed: false, decoded: decodeTxError(err) }
  }
}

/* ---------- transactions and events ---------- */
async function transactionOf(ctx: Ctx, signature: string): Promise<VersionedTransactionResponse> {
  for (let attempt = 1; attempt <= LIMITS.txFetchAttempts; attempt++) {
    const tx = await ctx.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    if (tx !== null) return tx
    await sleep(TIMING.txFetchDelayMs)
  }
  throw new Error(`transaction ${signature} not found after ${LIMITS.txFetchAttempts} attempts`)
}

async function routerEventsOf(ctx: Ctx, signature: string): Promise<RouterEvent[]> {
  const tx = await transactionOf(ctx, signature)
  if (tx.meta === null || tx.meta.err !== null) throw new Error(`transaction ${signature} has no meta or failed`)
  return parseRouterEvents(tx.meta.logMessages ?? [], ctx.cluster.routerProgramId)
}

function eventOf<N extends RouterEvent['name']>(events: readonly RouterEvent[], name: N, user?: PublicKey): EventNamed<N> {
  const found = events.find((e): e is EventNamed<N> => e.name === name && (user === undefined || ('user' in e && e.user.equals(user))))
  return found ?? fail(`${name}${user === undefined ? '' : ` of ${user.toBase58()}`} missing from the logs`)
}

/* ---------- traders and balances ---------- */
const secretKeysSchema = z.array(z.array(z.number().int().min(0).max(255)).length(64)).length(TRADER_COUNT)
/** Reuses an existing traders file (never overwrites keys that may hold SOL); otherwise writes fresh keys first. */
function loadOrCreateTraders(): Keypair[] {
  mkdirSync(OUT_DIR, { recursive: true })
  if (existsSync(TRADERS_PATH)) {
    // The JSON.parse message would quote the key bytes, so it is dropped on purpose.
    const json: unknown = ((): unknown => { try { return JSON.parse(readFileSync(TRADERS_PATH, 'utf8')) } catch { return null } })()
    const parsed = secretKeysSchema.safeParse(json)
    if (!parsed.success) throw new Error(`${TRADERS_PATH} must be JSON holding ${TRADER_COUNT} 64-byte secret keys`)
    return parsed.data.map((secret) => Keypair.fromSecretKey(Uint8Array.from(secret)))
  }
  const traders = Array.from({ length: TRADER_COUNT }, () => Keypair.generate())
  writeFileSync(TRADERS_PATH, JSON.stringify(traders.map((t) => Array.from(t.secretKey))), { mode: TRADERS_FILE_MODE, flag: 'wx' })
  return traders
}

const wsolAtaOf = (ctx: Ctx, owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(ctx.quote.mint, owner, false, ctx.quote.tokenProgram)
const baseAtaOf = (live: Live, owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(live.market.baseMint, owner, false, TOKEN_2022_PROGRAM_ID)
async function tokenBalance(ctx: Ctx, account: PublicKey, program: PublicKey): Promise<bigint> {
  const info = await ctx.connection.getAccountInfo(account, COMMITMENT)
  return info === null ? 0n : unpackAccount(account, info, program).amount
}
const wsolOf = (ctx: Ctx, owner: PublicKey): Promise<bigint> => tokenBalance(ctx, wsolAtaOf(ctx, owner), ctx.quote.tokenProgram)

/** Closes the trader's wSOL ATA and sends every lamport to the payer (the payer pays the fee). */
async function sweepTrader(ctx: Ctx, keypair: Keypair): Promise<SweepRow> {
  const wsolAta = wsolAtaOf(ctx, keypair.publicKey)
  const [wallet, ata] = await ctx.connection.getMultipleAccountsInfo([keypair.publicKey, wsolAta], COMMITMENT)
  const lamports = BigInt((wallet?.lamports ?? 0) + (ata?.lamports ?? 0))
  if (lamports === 0n) return { trader: keypair.publicKey.toBase58(), lamports: '0', signature: null }
  const close = ata === null ? [] : [createCloseAccountInstruction(wsolAta, keypair.publicKey, keypair.publicKey, [], ctx.quote.tokenProgram)]
  const transfer = SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: ctx.payer.publicKey, lamports })
  const signature = await send(ctx, 'sweep', [...close, transfer], [keypair])
  return { trader: keypair.publicKey.toBase58(), lamports: lamports.toString(), signature }
}

async function sweepTraders(ctx: Ctx): Promise<SweepRow[]> {
  const rows: SweepRow[] = []
  for (const keypair of ctx.traders) {
    rows.push(await sweepTrader(ctx, keypair).catch((err: unknown): SweepRow => {
      const error = scrub(errorMessage(err))
      log.error('sweep failed, rerun to retry', { trader: keypair.publicKey.toBase58(), error })
      return { trader: keypair.publicKey.toBase58(), lamports: '0', signature: null, error }
    }))
  }
  return rows
}

/* ---------- chain reads ---------- */
async function readCurve(ctx: Ctx, pool: PublicKey): Promise<CurveState> {
  const info = (await ctx.connection.getAccountInfo(pool, COMMITMENT)) ?? fail(`DBC pool ${pool.toBase58()} not found`)
  const { poolState } = ctx.dbc.coder.accounts.decode<TransferHookPool>('transferHookPool', info.data)
  const migrationProgress = Number(poolState.migrationProgress)
  const isMigrated = Number(poolState.isMigrated) !== 0 || migrationProgress === CREATED_POOL
  return { quoteReserve: toBigint(poolState.quoteReserve), migrationProgress, isMigrated }
}
const isComplete = (curve: CurveState): boolean => curve.isMigrated || curve.migrationProgress !== PRE_BONDING_CURVE
async function readConfig(ctx: Ctx, config: PublicKey): Promise<ConfigWithTransferHook['config']> {
  const info = (await ctx.connection.getAccountInfo(config, COMMITMENT)) ?? fail(`DBC config ${config.toBase58()} not found`)
  return ctx.dbc.coder.accounts.decode<ConfigWithTransferHook>('configWithTransferHook', info.data).config
}
const readMarket = async (ctx: Ctx, live: Live): Promise<MarketAccount> =>
  (await fetchMarket(ctx.connection, live.market.address)) ?? fail(`market ${live.market.address.toBase58()} not found`)

/** Each trader's position in the market, null when it has none. */
async function readPositions(ctx: Ctx, live: Live): Promise<(PositionAccount | null)[]> {
  const addresses = ctx.traders.map((t) => findPositionPda(live.market.address, t.publicKey, ctx.cluster.routerProgramId))
  const infos = await ctx.connection.getMultipleAccountsInfo(addresses, COMMITMENT)
  return addresses.map((address, i) => {
    const info = infos[i]
    return info === null || info === undefined ? null : decodePosition(address, info.data)
  })
}
const readPosition = async (ctx: Ctx, live: Live, i: number): Promise<PositionAccount | null> => (await readPositions(ctx, live))[i] ?? null
async function requirePosition(ctx: Ctx, live: Live, i: number): Promise<PositionAccount> {
  const position = await readPosition(ctx, live, i)
  return position !== null && position.tokens > 0n ? position : fail(`trader ${i} holds no position`)
}

/** Every router position of the market (any owner, current layout). */
async function marketPositions(ctx: Ctx, live: Live): Promise<PositionAccount[]> {
  const filters = [
    { memcmp: { offset: 0, bytes: POSITION_DISCRIMINATOR.toString('base64'), encoding: 'base64' as const } }, { dataSize: POSITION_ACCOUNT_SIZE_V2 },
    { memcmp: { offset: POSITION_MARKET_OFFSET, bytes: live.market.address.toBase58() } }]
  const accounts = await ctx.connection.getProgramAccounts(ctx.cluster.routerProgramId, { commitment: COMMITMENT, filters })
  return accounts.map(({ pubkey, account }) => decodePosition(pubkey, account.data))
}
const hookProgramOf = async (ctx: Ctx, mint: PublicKey): Promise<PublicKey | null> =>
  getTransferHook(await getMint(ctx.connection, mint, COMMITMENT, TOKEN_2022_PROGRAM_ID))?.programId ?? null
const chainUnixTime = async (ctx: Ctx): Promise<bigint> =>
  ((await ctx.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, COMMITMENT)) ?? fail('Clock sysvar missing')).data.readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET)

async function waitForChainTime(ctx: Ctx, unix: bigint): Promise<bigint> {
  const giveUpAt = Date.now() + TIMING.clockWaitMaxMs
  for (;;) {
    const now = await chainUnixTime(ctx)
    if (now >= unix) return now
    if (Date.now() > giveUpAt) throw new Error(`chain clock did not reach ${unix} within ${TIMING.clockWaitMaxMs} ms`)
    await sleep(TIMING.clockPollMs)
  }
}

/* ---------- crank jobs, scoped to this market ---------- */
/** The jobs' connection: router program scans keep only this Market and its Positions; every other call is untouched. */
function scopeToMarket(connection: Connection, routerProgramId: PublicKey, market: PublicKey): Connection {
  const marketBytes = market.toBuffer()
  const isOwnPosition = (data: Buffer): boolean =>
    data.length >= POSITION_MARKET_OFFSET + PUBKEY_BYTES &&
    data.subarray(0, POSITION_DISCRIMINATOR.length).equals(POSITION_DISCRIMINATOR) &&
    data.subarray(POSITION_MARKET_OFFSET, POSITION_MARKET_OFFSET + PUBKEY_BYTES).equals(marketBytes)
  const getProgramAccounts = async (programId: PublicKey, config?: GetProgramAccountsConfig | Commitment): Promise<GetProgramAccountsResponse> => {
    if (typeof config === 'object' && config.withContext === true) throw new Error('scoped connection: withContext scans are not supported')
    const accounts = await connection.getProgramAccounts(programId, config)
    if (!programId.equals(routerProgramId)) return accounts
    return accounts.filter(({ pubkey, account }) => pubkey.equals(market) || isOwnPosition(account.data))
  }
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'getProgramAccounts') return getProgramAccounts
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** One tick of `job` on the scoped connection; every signature it sends must touch this market or its pool. */
async function tick(ctx: Ctx, live: Live, job: CrankJob): Promise<CrankJobResult> {
  const crank: CrankContext = Object.freeze({ connection: live.scoped, payer: ctx.payer, cluster: ctx.cluster, log, maxTx: ctx.cfg.maxTxPerTick })
  const result = await job.run(crank)
  log.info('e2e crank tick', { job: job.name, sent: result.sent, skipped: result.skipped, errors: result.errors.map(scrub) })
  for (const signature of result.sent) {
    const keys = (await transactionOf(ctx, signature)).transaction.message.staticAccountKeys
    const touchesMarket = keys.some((key) => key.equals(live.market.address) || key.equals(live.market.pool))
    if (!touchesMarket) throw new Error(`${job.name} transaction ${signature} touches neither this market nor its pool`)
  }
  return result
}

/* ---------- trades ---------- */
/** A payer transfer that brings `to` up to `need` lamports, or nothing when it already holds them. */
async function topUp(ctx: Ctx, to: PublicKey, need: bigint): Promise<TransactionInstruction[]> {
  const balance = await lamportsOf(ctx, to)
  const lamports = need > balance ? need - balance : 0n
  await guardPayer(ctx, lamports)
  return lamports > 0n ? [SystemProgram.transfer({ fromPubkey: ctx.payer.publicKey, toPubkey: to, lamports })] : []
}

/** One router buy (wrapping SOL), quoted first and checked against the Anti-Whale cap before it is sent. */
async function buy(ctx: Ctx, live: Live, i: number, amount: bigint): Promise<Buy> {
  const keypair = trader(ctx, i)
  const before = await readPosition(ctx, live, i)
  const quote = await quoteBuy(ctx.connection, live.market, amount)
  const after = tokensOf(before) + quote.tokensOut
  if (after > live.cap) throw new Error(`buy by trader ${i} would pass the Anti-Whale cap (${after} > ${live.cap})`)
  const fund = await topUp(ctx, keypair.publicKey, amount + (before === null ? FIRST_BUY_RENT_LAMPORTS : 0n) + TRADER_FLOAT_LAMPORTS)
  const minOut = (quote.tokensOut * MIN_OUT_PERCENT) / PERCENT
  const ixs = buyInstructions({ cluster: ctx.cluster, accounts: live.accounts, user: keypair.publicKey, amountIn: amount, minOut })
  return { signature: await send(ctx, `buy by trader ${i}`, [...fund, ...ixs], [keypair]), quote, before }
}

async function exitAtCost(ctx: Ctx, live: Live, i: number, tokens: bigint): Promise<Exit> {
  const keypair = trader(ctx, i)
  const before = await wsolOf(ctx, keypair.publicKey)
  const ixs = sellInstructions({ cluster: ctx.cluster, accounts: live.accounts, user: keypair.publicKey, tokens, unwrapSol: false })
  const signature = await send(ctx, `exit by trader ${i}`, ixs, [keypair])
  const event = eventOf(await routerEventsOf(ctx, signature), 'SellEvent', keypair.publicKey)
  return { signature, event, received: (await wsolOf(ctx, keypair.publicKey)) - before }
}

/* ---------- steps 1-6 ---------- */
async function launch(ctx: Ctx): Promise<{ live: Live; outcome: Outcome }> {
  const plan = await buildLaunchPlan({
    connection: ctx.connection, cluster: ctx.cluster, creator: ctx.payer.publicKey, ...TOKEN, initialBuy: 0n,
    preset: { quote: ctx.quote, migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD, feeBps: FEE_BPS, feeClaimer: ctx.payer.publicKey, leftoverReceiver: ctx.payer.publicKey },
  })
  const signatures: string[] = []
  for (const [i, tx] of plan.transactions.entries()) signatures.push(await send(ctx, `launch ${i}`, tx.instructions, plan.signers[i] ?? []))
  const market = (await fetchMarket(ctx.connection, plan.market)) ?? fail(`router market ${plan.market.toBase58()} missing after launch`)
  const config = await readConfig(ctx, market.config)
  const live: Live = {
    market, accounts: marketAccountsFor(market, ctx.quote.tokenProgram),
    cap: (toBigint(config.swapBaseAmount) * ANTI_WHALE_BPS) / BPS,
    scoped: scopeToMarket(ctx.connection, ctx.cluster.routerProgramId, market.address),
  }
  const owner = (await ctx.connection.getAccountInfo(market.address, COMMITMENT))?.owner
  const hook = await hookProgramOf(ctx, market.baseMint)
  const threshold = toBigint(config.migrationQuoteThreshold)
  const pass = owner?.equals(ctx.cluster.routerProgramId) === true && market.quoteMint.equals(NATIVE_MINT) &&
    threshold === MIGRATION_QUOTE_THRESHOLD && hook?.equals(ctx.cluster.hookProgramId) === true && !isComplete(await readCurve(ctx, market.pool))
  const detail = `market ${market.address.toBase58()}, threshold ${threshold}, hook ${hook?.toBase58() ?? 'none'}, cap ${live.cap}`
  return { live, outcome: { pass, detail, signatures: { launch: signatures } } }
}

async function sevenBuys(ctx: Ctx, live: Live): Promise<Outcome> {
  const signatures: string[] = []
  const mismatches: string[] = []
  for (let i = 0; i < TRADER_COUNT; i++) {
    const { signature, quote, before } = await buy(ctx, live, i, BUY_CHUNK)
    const event = eventOf(await routerEventsOf(ctx, signature), 'BuyEvent', trader(ctx, i).publicKey)
    const basis = (before?.basis ?? 0n) + quote.basisAdded
    const matches = event.market.equals(live.market.address) && event.tokensOut === quote.tokensOut &&
      event.netIntoCurve === quote.netIntoCurve && event.basis === basis
    if (!matches) mismatches.push(`trader ${i}: event ${event.tokensOut}/${event.netIntoCurve}/${event.basis} vs quote ${quote.tokensOut}/${quote.netIntoCurve}/${basis}`)
    signatures.push(signature)
  }
  const detail = mismatches.length === 0 ? `${TRADER_COUNT}/${TRADER_COUNT} BuyEvents match quoteBuy (tokensOut, netIntoCurve, basis), ${BUY_CHUNK} lamports each` : mismatches.join('; ')
  return { pass: mismatches.length === 0, detail, signatures: { buys: signatures } }
}

async function floorThenFullExit(ctx: Ctx, live: Live): Promise<Outcome> {
  const position = await requirePosition(ctx, live, ROLE.floor)
  const floor = floorValue(position, live.market)
  const moves: string[] = []
  for (const i of PRICE_MOVERS) moves.push((await buy(ctx, live, i, BUY_CHUNK)).signature)
  const exit = await exitAtCost(ctx, live, ROLE.floor, position.tokens)
  const after = await readPosition(ctx, live, ROLE.floor)
  const pass = exit.event.refund === floor && exit.received === floor && tokensOf(after) === 0n
  const detail = `floor ${floor}, refund ${exit.event.refund}, wSOL received ${exit.received} after ${moves.length} price-moving buys`
  return { pass, detail, signatures: { priceMoves: moves, exit: exit.signature } }
}

async function halfExit(ctx: Ctx, live: Live): Promise<Outcome> {
  const position = await requirePosition(ctx, live, ROLE.halfExit)
  const tokens = (position.tokens * HALF_PERCENT) / PERCENT
  const quoted = quoteExit(position, live.market, tokens)
  const exit = await exitAtCost(ctx, live, ROLE.halfExit, tokens)
  const pass = exit.event.refund === quoted.refund && exit.event.basisPart === quoted.basisPart && exit.received === quoted.refund
  const detail = `${tokens} of ${position.tokens} tokens: refund ${exit.event.refund}, quoteExit.refund ${quoted.refund}, wSOL received ${exit.received}`
  return { pass, detail, signatures: { exit: exit.signature } }
}

async function hookRejections(ctx: Ctx, live: Live): Promise<Outcome> {
  const owner = trader(ctx, ROLE.hookProbe)
  const client = new DynamicBondingCurveClient(ctx.connection, COMMITMENT)
  const swap = await client.pool.swap2WithTransferHook({
    owner: owner.publicKey, payer: ctx.payer.publicKey, pool: live.market.pool, swapBaseForQuote: false,
    swapMode: SwapMode.PartialFill, amountIn: new BN(DIRECT_BUY_LAMPORTS.toString()), minimumAmountOut: new BN(0), referralTokenAccount: null,
  })
  const direct = await sendExpectingRejection(ctx, 'direct DBC buy', swap.instructions, [owner])
  const tokens = (await requirePosition(ctx, live, ROLE.hookProbe)).tokens / 2n
  const to = baseAtaOf(live, trader(ctx, ROLE.whaleProbe).publicKey)
  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    ctx.connection, baseAtaOf(live, owner.publicKey), live.market.baseMint, to, owner.publicKey, tokens, BASE_DECIMALS, [], COMMITMENT, TOKEN_2022_PROGRAM_ID,
  )
  const transfer = await sendExpectingRejection(ctx, 'wallet-to-wallet transfer', [transferIx], [owner])
  const ok = (r: Rejection): boolean => !r.landed && isCode(r.decoded, 'hook', EXPECTED_CODE.hookTransferNotViaRouter)
  return { pass: ok(direct) && ok(transfer), detail: `direct DBC buy: ${describeRejection(direct)}; transfer: ${describeRejection(transfer)}` }
}

/** The smallest of a few buy sizes (below the curve's remaining quote) that takes the position past the cap. */
async function whaleAmount(ctx: Ctx, live: Live, held: bigint): Promise<{ amount: bigint; quote: BuyQuote } | null> {
  const remaining = MIGRATION_QUOTE_THRESHOLD - (await readCurve(ctx, live.market.pool)).quoteReserve
  for (const amount of [remaining / 4n, remaining / 2n, (remaining * 3n) / 4n, remaining - 1n]) {
    const quote = await quoteBuy(ctx.connection, live.market, amount)
    if (held + quote.tokensOut > live.cap) return { amount, quote }
  }
  return null
}

async function whaleRejected(ctx: Ctx, live: Live): Promise<Outcome> {
  const keypair = trader(ctx, ROLE.whaleProbe)
  const held = (await requirePosition(ctx, live, ROLE.whaleProbe)).tokens
  const whale = await whaleAmount(ctx, live, held)
  if (whale === null) return { pass: false, detail: 'no buy below the remaining curve quote passes the cap' }
  const fund = await topUp(ctx, keypair.publicKey, whale.amount + TRADER_FLOAT_LAMPORTS)
  const ixs = buyInstructions({ cluster: ctx.cluster, accounts: live.accounts, user: keypair.publicKey, amountIn: whale.amount, minOut: 0n })
  const result = await sendExpectingRejection(ctx, 'whale buy', [...fund, ...ixs], [keypair])
  const pass = !result.landed && isCode(result.decoded, 'router', EXPECTED_CODE.routerPositionCapExceeded)
  return { pass, detail: `buy of ${whale.amount} lamports: ${held} + ${whale.quote.tokensOut} > cap ${live.cap}: ${describeRejection(result)}` }
}

/* ---------- steps 7-12 ---------- */
async function autoExit(ctx: Ctx, live: Live, job: CrankJob): Promise<Outcome> {
  const owner = trader(ctx, ROLE.autoExit)
  const deadline = (await chainUnixTime(ctx)) + TIMING.autoExitDelaySeconds
  const ixs = setAutoExitInstructions({ cluster: ctx.cluster, accounts: live.accounts, owner: owner.publicKey, deadline })
  const setSignature = await send(ctx, 'set_auto_exit', ixs, [owner])
  const floor = floorValue(await requirePosition(ctx, live, ROLE.autoExit), live.market)
  const early = await tick(ctx, live, job)
  const now = await waitForChainTime(ctx, deadline)
  const before = await wsolOf(ctx, owner.publicKey)
  const due = await tick(ctx, live, job)
  const signature = due.sent[0]
  if (signature === undefined) return { pass: false, detail: `autoExitJob sent nothing after the deadline: ${due.errors.join('; ')}`, signatures: { setAutoExit: setSignature } }
  const events = await routerEventsOf(ctx, signature)
  const exitEvent = eventOf(events, 'AutoExitEvent', owner.publicKey)
  const sell = eventOf(events, 'SellEvent', owner.publicKey)
  const received = (await wsolOf(ctx, owner.publicKey)) - before
  const after = await readPosition(ctx, live, ROLE.autoExit)
  const pass = early.sent.length === 0 && due.sent.length === 1 && exitEvent.cranker.equals(ctx.payer.publicKey) &&
    sell.refund === floor && received === floor && tokensOf(after) === 0n && after?.autoExitDeadline === 0n
  const detail = `deadline ${deadline}, before it the job sent ${early.sent.length}; at chain time ${now} it sent ${due.sent.length}: refund ${sell.refund}, floor ${floor}, wSOL received ${received}`
  const position = findPositionPda(live.market.address, owner.publicKey, ctx.cluster.routerProgramId).toBase58()
  return { pass, detail, signatures: { setAutoExit: setSignature, autoExit: signature }, accounts: { autoExitPosition: position } }
}

/** The trader in `eligible` holding the fewest tokens. */
const lightest = (eligible: readonly number[], positions: readonly (PositionAccount | null)[]): number =>
  eligible.reduce((best, i) => (tokensOf(positions[i] ?? null) < tokensOf(positions[best] ?? null) ? i : best), eligible[0] ?? 0)

async function graduate(ctx: Ctx, live: Live): Promise<Outcome> {
  const buys: string[] = []
  for (let n = 0; n < LIMITS.graduationBuys && !isComplete(await readCurve(ctx, live.market.pool)); n++) {
    buys.push((await buy(ctx, live, lightest(GRADUATION_TRADERS, await readPositions(ctx, live)), BUY_CHUNK)).signature)
  }
  const curve = await readCurve(ctx, live.market.pool)
  const largest = (await readPositions(ctx, live)).reduce((max, p) => (tokensOf(p) > max ? tokensOf(p) : max), 0n)
  const hook = await hookProgramOf(ctx, live.market.baseMint)
  const pass = isComplete(curve) && largest <= live.cap && (hook === null || hook.equals(PublicKey.default))
  const detail = `${buys.length} buys of ${BUY_CHUNK}, migrationProgress ${curve.migrationProgress}, largest position ${largest} <= cap ${live.cap}, hook program ${hook?.toBase58() ?? 'null'}`
  return { pass, detail, signatures: { graduationBuys: buys } }
}

async function finalize(ctx: Ctx, live: Live): Promise<Outcome> {
  const buffer = await tokenBalance(ctx, live.market.bufferVault, ctx.quote.tokenProgram)
  const basis = (await marketPositions(ctx, live)).reduce((sum, p) => sum + p.basis, 0n)
  const result = await tick(ctx, live, finalizeJob)
  const market = await readMarket(ctx, live)
  const signature = result.sent[0]
  const event = signature === undefined ? null : eventOf(await routerEventsOf(ctx, signature), 'FinalizeEvent')
  const pass = result.sent.length === 1 && market.finalized && market.surplusSnapshot === buffer && event?.surplus === buffer && market.basisSnapshot === basis
  const detail = `finalized ${market.finalized}, surplus snapshot ${market.surplusSnapshot} (buffer ${buffer}), basis snapshot ${market.basisSnapshot} (positions ${basis})`
  return { pass, detail, signatures: { finalize: result.sent } }
}

async function migrate(ctx: Ctx, live: Live): Promise<Outcome> {
  const job = createMigrateJob({ listMarkets: async () => [{ pool: live.market.pool, config: live.market.config }] }, ctx.cfg)
  const result = await tick(ctx, live, job)
  const config = await readConfig(ctx, live.market.config)
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption] ?? fail(`migration fee option ${config.migrationFeeOption} has no DAMM v2 config`)
  const dammPool = deriveDammV2PoolAddress(dammConfig, live.market.baseMint, live.market.quoteMint)
  const info = await ctx.connection.getAccountInfo(dammPool, COMMITMENT)
  const curve = await readCurve(ctx, live.market.pool)
  const pass = result.sent.length === 1 && info?.owner.equals(DAMM_V2_PROGRAM_ID) === true && curve.isMigrated
  const detail = `DAMM v2 pool ${dammPool.toBase58()} ${info === null ? 'missing' : `owned by ${info.owner.toBase58()}`}, DBC pool migrated ${curve.isMigrated}`
  return { pass, detail, signatures: { migrate: result.sent }, accounts: { dammConfig: dammConfig.toBase58(), dammPool: dammPool.toBase58() } }
}

async function claims(ctx: Ctx, live: Live): Promise<Outcome> {
  const job = createClaimsJob(ctx.cfg)
  const holders = (await marketPositions(ctx, live)).length
  const sent: string[] = []
  for (let n = 0; n < LIMITS.claimTicks && (await marketPositions(ctx, live)).length > 0; n++) sent.push(...(await tick(ctx, live, job)).sent)
  let shares = 0n
  for (const signature of sent) shares += eventOf(await routerEventsOf(ctx, signature), 'ClaimEvent').share
  const market = await readMarket(ctx, live)
  const left = (await marketPositions(ctx, live)).length
  const residual = market.surplusSnapshot - shares
  const pass = holders > 0 && left === 0 && sent.length === holders && shares <= market.surplusSnapshot &&
    residual <= BigInt(holders) && market.surplusClaimed === shares
  const detail = `${sent.length} claims for ${holders} positions, ${left} left; shares ${shares} of snapshot ${market.surplusSnapshot}, residual ${residual} <= ${holders}`
  return { pass, detail, signatures: { claims: sent } }
}

async function freeTransfer(ctx: Ctx, live: Live): Promise<Outcome> {
  const from = trader(ctx, ROLE.transferFrom)
  const [fromAta, toAta] = [baseAtaOf(live, from.publicKey), baseAtaOf(live, trader(ctx, ROLE.transferTo).publicKey)]
  const balances = async (): Promise<[bigint, bigint]> => [await tokenBalance(ctx, fromAta, TOKEN_2022_PROGRAM_ID), await tokenBalance(ctx, toAta, TOKEN_2022_PROGRAM_ID)]
  const [fromBefore, toBefore] = await balances()
  const ix = createTransferCheckedInstruction(fromAta, live.market.baseMint, toAta, from.publicKey, 1n, BASE_DECIMALS, [], TOKEN_2022_PROGRAM_ID)
  const signature = await send(ctx, 'post-graduation transfer', [ix], [from])
  const [fromAfter, toAfter] = await balances()
  const pass = fromAfter === fromBefore - 1n && toAfter === toBefore + 1n
  return { pass, detail: `1 raw token, plain transferChecked without hook accounts: ${fromBefore} -> ${fromAfter}, ${toBefore} -> ${toAfter}`, signatures: { transfer: signature } }
}

/* ---------- journey, unwind, sweep ---------- */
function record(report: Report, n: number, outcome: Outcome): void {
  const name = STEP_NAMES[n - 1] ?? `step ${n}`
  const row: StepRecord = { n, name, ...outcome, detail: scrub(outcome.detail) }
  report.steps.push(row)
  Object.assign(report.accounts, outcome.accounts ?? {})
  process.stdout.write(`${row.pass ? 'PASS' : 'FAIL'}  [${n}/${STEP_NAMES.length}] ${name}  (${row.detail})\n`)
  report.save()
}

/** Runs one step; a step that throws is recorded as FAIL and stops the journey. */
async function step<T>(report: Report, n: number, run: () => Promise<{ outcome: Outcome; value: T }>): Promise<T> {
  try {
    const { outcome, value } = await run()
    record(report, n, outcome)
    return value
  } catch (err) {
    record(report, n, { pass: false, detail: `threw: ${errorMessage(err)}` })
    throw new Abort(`step ${n} threw`)
  }
}

const MARKET_FIELDS = ['pool', 'config', 'baseMint', 'quoteMint', 'baseVault', 'quoteVault', 'bufferVault'] as const
const marketAccountsRecord = (market: MarketAccount): Record<string, string> =>
  ({ market: market.address.toBase58(), ...Object.fromEntries(MARKET_FIELDS.map((field) => [field, market[field].toBase58()])) })

async function journey(ctx: Ctx, report: Report, onLive: (live: Live) => void): Promise<void> {
  const live = await step(report, 1, async () => {
    const launched = await launch(ctx)
    onLive(launched.live)
    return { outcome: { ...launched.outcome, accounts: marketAccountsRecord(launched.live.market) }, value: launched.live }
  })
  const autoExitJob = createAutoExitJob(ctx.cfg)
  const steps: readonly (() => Promise<Outcome>)[] = [
    () => sevenBuys(ctx, live), () => floorThenFullExit(ctx, live), () => halfExit(ctx, live), () => hookRejections(ctx, live),
    () => whaleRejected(ctx, live), () => autoExit(ctx, live, autoExitJob), () => graduate(ctx, live), () => finalize(ctx, live),
    () => migrate(ctx, live), () => claims(ctx, live), () => freeTransfer(ctx, live),
  ]
  for (const [i, run] of steps.entries()) await step(report, i + 2, async () => ({ outcome: await run(), value: null }))
}

/** After an abort on a live curve, exits every position at cost so the sweep can return the refunds. */
async function unwind(ctx: Ctx, live: Live | null): Promise<void> {
  if (live === null || isComplete(await readCurve(ctx, live.market.pool))) return
  for (const [i, position] of (await readPositions(ctx, live)).entries()) {
    if (tokensOf(position) === 0n) continue
    await exitAtCost(ctx, live, i, tokensOf(position)).catch((err: unknown) => log.error('unwind exit failed', { trader: i, error: scrub(errorMessage(err)) }))
  }
}

async function sweepStep(ctx: Ctx, report: Report): Promise<readonly SweepRow[]> {
  const rows = await sweepTraders(ctx)
  const left = await ctx.connection.getMultipleAccountsInfo(ctx.traders.flatMap((t) => [t.publicKey, wsolAtaOf(ctx, t.publicKey)]), COMMITMENT)
  const leftover = left.reduce((sum, info) => sum + BigInt(info?.lamports ?? 0), 0n)
  const swept = rows.reduce((sum, row) => sum + BigInt(row.lamports), 0n)
  const failed = rows.filter((row) => row.error !== undefined).length
  record(report, STEP_NAMES.length, {
    pass: failed === 0 && leftover === 0n,
    detail: `swept ${formatSol(swept)} SOL from ${TRADER_COUNT} traders, ${failed} failed, ${leftover} lamports left in wallets and wSOL ATAs`,
    signatures: { sweep: rows.flatMap((row) => (row.signature === null ? [] : [row.signature])) },
  })
  return rows
}

function markNotRun(report: Report): void {
  const done = new Set(report.steps.map((s) => s.n))
  for (let n = 1; n < STEP_NAMES.length; n++) if (!done.has(n)) record(report, n, { pass: false, detail: 'not run: an earlier step threw' })
}

/* ---------- main ---------- */
function createReport(ctx: Ctx, payerBefore: bigint): Report {
  const base = {
    task: 'QA-02', cluster: 'devnet', routerProgramId: ctx.cluster.routerProgramId.toBase58(), hookProgramId: ctx.cluster.hookProgramId.toBase58(),
    dbcProgramId: ctx.cluster.dbcProgramId.toBase58(), payer: ctx.payer.publicKey.toBase58(), traders: ctx.traders.map((t) => t.publicKey.toBase58()),
    migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD.toString(), feeBps: FEE_BPS, buyChunkLamports: BUY_CHUNK.toString(),
    crankGuards: E2E_CRANK_ENV, startedAt: new Date().toISOString(), payerSolBefore: formatSol(payerBefore),
  }
  const report: Report = {
    steps: [],
    accounts: {},
    save(extra = {}) {
      const output = { ...base, accounts: report.accounts, steps: [...report.steps].sort((a, b) => a.n - b.n), ...extra }
      writeFileSync(OUTPUT_PATH, `${scrub(JSON.stringify(output, null, 1))}\n`)
    },
  }
  return report
}

/** Refuses any cluster but devnet (genesis hash) before a key is loaded or a transaction is built. */
async function createContext(rpc: URL): Promise<Ctx> {
  const cfg = loadConfig({ ...E2E_CRANK_ENV, RPC_URL: rpc.href, CRANK_KEYPAIR: process.env.PAYER_KEYPAIR?.trim() || DEFAULT_PAYER_KEYPAIR })
  const connection = new Connection(rpc.href, COMMITMENT)
  const genesis = await connection.getGenesisHash()
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error(`RPC_URL is not devnet (genesis ${genesis}); refusing to send anything`)
  const cluster = getClusterConfig(cfg.cluster)
  const quote = cluster.quoteMints.find((q) => q.symbol === 'SOL') ?? fail('devnet has no SOL quote mint')
  const payer = loadCrankKeypair(cfg.crankKeypairPath)
  return { connection, cluster, quote, payer, traders: loadOrCreateTraders(), dbc: createDbcProgram(connection, COMMITMENT).program, cfg }
}

/** Resolves once `line` is flushed, so the summary stays the last line even though the process exits right after. */
const writeLine = (line: string): Promise<void> => new Promise((done) => void process.stdout.write(`${line}\n`, () => done()))

async function main(): Promise<number> {
  const rpc = parseRpcUrl(process.env)
  protectRpcUrl(rpc)
  const ctx = await createContext(rpc)
  const before = await lamportsOf(ctx, ctx.payer.publicKey)
  log.info('payer balance before', { payer: ctx.payer.publicKey.toBase58(), sol: formatSol(before) })
  await guardPayer(ctx, ESTIMATED_SPEND_LAMPORTS)
  const report = createReport(ctx, before)
  const state: { live: Live | null } = { live: null }
  let sweep: readonly SweepRow[] = []
  try {
    await journey(ctx, report, (live) => { state.live = live })
  } catch (err) {
    if (!(err instanceof Abort)) throw err
    markNotRun(report)
  } finally {
    await unwind(ctx, state.live).catch((err: unknown) => log.error('unwind failed', { error: scrub(errorMessage(err)) }))
    sweep = await sweepStep(ctx, report)
  }
  const after = await lamportsOf(ctx, ctx.payer.publicKey)
  const failed = report.steps.filter((s) => !s.pass).length
  const summary = `${report.steps.length - failed} passed, ${failed} failed`
  log.info('payer balance after', { sol: formatSol(after), spentSol: formatSol(before - after) })
  report.save({ finishedAt: new Date().toISOString(), payerSolAfter: formatSol(after), spentSol: formatSol(before - after), sweep, summary })
  await writeLine(summary)
  return failed === 0 ? 0 : 1
}

/** Exits explicitly: an RPC websocket left open by confirmTransaction must not keep the process (or its log) alive. */
main().then(
  (code) => process.exit(code),
  async (err: unknown) => {
    log.error('e2e-devnet failed', { error: scrub(errorMessage(err)) })
    await writeLine('0 passed, 1 failed')
    process.exit(1)
  },
)
