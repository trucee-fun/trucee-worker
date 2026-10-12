/**
 * Prepares a graduated-but-unfinalized router v5 market on devnet for an unattended crank run, then records
 * that run and sweeps the traders. Three modes, run in this order (from worker/; the RPC URL never reaches argv or
 * the output):
 *
 *   1. RPC_URL="$DEVNET_RPC" CLUSTER=devnet npx tsx scripts/graduate-devnet.ts
 *      Launches a wSOL market (threshold 0.3 SOL) through the SDK and spreads buys over 6 traders until the curve
 *      completes, each buy pre-checked against the Anti-Whale cap. Stops there: no finalize, migrate or claim, which
 *      are left to the crank (npm start). Prints the market and "graduated: true". The traders keep their wSOL ATAs,
 *      so the crank's claims need no ATA creation.
 *   2. RPC_URL="$DEVNET_RPC" CLUSTER=devnet npx tsx scripts/graduate-devnet.ts --record
 *      Reads the crank run log (out/crank-run.log), looks up every signature the crank sent (status, and which router
 *      markets it touched) and records them per job, split into this market's and other markets'.
 *   3. RPC_URL="$DEVNET_RPC" CLUSTER=devnet npx tsx scripts/graduate-devnet.ts --sweep
 *      Counts this market's remaining positions and returns every trader's SOL (wallet and wSOL ATA) to the payer.
 *
 * Built from scripts/e2e-devnet.ts: devnet genesis-hash check before any key is loaded, RPC URL scrubbed from
 * all output, payer floor of 5 SOL, trader keys written to out/graduate-devnet.traders.json (mode 0600, gitignored)
 * before any is funded and reused (never overwritten) when present, and on a failed graduation every position exits at
 * cost and the traders are swept (try/finally). Everything is recorded in out/crank-run-devnet.json.
 * Env: RPC_URL (falls back to DEVNET_RPC), CLUSTER (devnet only), PAYER_KEYPAIR (default ~/.config/solana/id.json),
 * CRANK_LOG (mode 2; default out/crank-run.log).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import {
  Connection, Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionExpiredBlockheightExceededError,
  type Commitment, type TransactionInstruction,
} from '@solana/web3.js'
import { NATIVE_MINT, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { createDbcProgram, type ConfigWithTransferHook, type TransferHookPool } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  POSITION_ACCOUNT_SIZE_V2, buildLaunchPlan, buyInstructions, decodePosition, decodeTxError, fetchAllMarkets, fetchMarket,
  findPositionPda, getClusterConfig, marketAccountsFor, quoteBuy, sellInstructions,
  type ClusterConfig, type MarketAccount, type MarketAccounts, type PositionAccount, type QuoteMintInfo,
} from '@trucee/sdk'
import { z } from 'zod'
import { expandHome, loadCrankKeypair } from '../src/config.js'
import { errorMessage, log, registerSecret } from '../src/log.js'

/* ---------- constants ---------- */
const OUT_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'out')
const OUTPUT_PATH = join(OUT_DIR, 'crank-run-devnet.json')
const TRADERS_PATH = join(OUT_DIR, 'graduate-devnet.traders.json')
const DEFAULT_CRANK_LOG = join(OUT_DIR, 'crank-run.log')
const TRADERS_FILE_MODE = 0o600
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const COMMITMENT: Commitment = 'confirmed'
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1'])
const DEFAULT_PAYER_KEYPAIR = '~/.config/solana/id.json'
const MIN_SECRET_FRAGMENT = 8
const LAMPORTS_PER_SOL = 1_000_000_000n
/** As litesvm-diff/out/scenario_tiny.json: a 0.3 SOL curve. */
const MIGRATION_QUOTE_THRESHOLD = 300_000_000n
const FEE_BPS = 100
/** No metadata app serves this market; the uri sits under the reserved .invalid TLD, so nothing ever resolves it. */
const TOKEN = Object.freeze({ name: 'Trucee CRK-07', symbol: 'CRK7', uri: 'https://trucee.invalid/crk-07.json' })
const TRADER_COUNT = 6
const BPS = 10_000n
/** zpvp_router ANTI_WHALE_BPS: one position may hold at most 20% of the config's swap_base_amount. */
const ANTI_WHALE_BPS = 2_000n
/** Spread buy size: 40 chunks fill the curve. */
const BUY_CHUNK = MIGRATION_QUOTE_THRESHOLD / 40n
const PERCENT = 100n
/** Buys accept at most 1% less than quoted (only this script trades its fresh market). */
const MIN_OUT_PERCENT = 99n
/** The script stops before any step that would take the payer below 5 SOL. */
const PAYER_FLOOR_LAMPORTS = 5n * LAMPORTS_PER_SOL
/** One 0.3 SOL curve, launch rents, 6 traders' first-buy rents and fees, with a margin. */
const ESTIMATED_SPEND_LAMPORTS = LAMPORTS_PER_SOL
/** A trader's first buy in a market: base ATA, position and maybe the wSOL ATA rent (~0.0058 SOL), rounded up. */
const FIRST_BUY_RENT_LAMPORTS = 7_000_000n
/** Kept on a trader after each buy so its wallet never drops below the rent-exempt minimum (0.00089 SOL). */
const TRADER_FLOAT_LAMPORTS = 2_000_000n
const LIMITS = Object.freeze({ sendAttempts: 3, graduationBuys: 150, logTailLines: 8, statusBatch: 256 })
/** DBC MigrationProgress (worker/src/crank/jobs/migrate.ts). */
const PRE_BONDING_CURVE = 0
const CREATED_POOL = 3
/** Position: discriminator 8 | owner 32 | market 32 | ... */
const POSITION_MARKET_OFFSET = 40
const POSITION_DISCRIMINATOR = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208])
/** The crank jobs in the worker's tick order (src/index.ts buildJobs). */
const CRANK_JOBS = ['finalize', 'migrate', 'claims', 'auto-exit'] as const
const MARKET_FIELDS = ['pool', 'config', 'baseMint', 'quoteMint', 'baseVault', 'quoteVault', 'bufferVault'] as const

/* ---------- types ---------- */
interface Ctx {
  readonly connection: Connection; readonly cluster: ClusterConfig; readonly quote: QuoteMintInfo; readonly payer: Keypair
  readonly traders: readonly Keypair[]; readonly dbc: ReturnType<typeof createDbcProgram>['program']
}
interface Live { readonly market: MarketAccount; readonly accounts: MarketAccounts; readonly cap: bigint }
interface CurveState { readonly quoteReserve: bigint; readonly migrationProgress: number; readonly isMigrated: boolean }
interface SweepRow { readonly trader: string; readonly lamports: string; readonly signature: string | null; readonly error?: string }
interface SentTx {
  readonly signature: string; readonly tick: number; readonly status: string; readonly err: string | null
  readonly markets: readonly string[]
}
type Blockhash = Awaited<ReturnType<Connection['getLatestBlockhash']>>
type JsonObject = Record<string, unknown>

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
const tokensOf = (position: PositionAccount | null | undefined): bigint => position?.tokens ?? 0n
const trader = (ctx: Ctx, i: number): Keypair => ctx.traders[i] ?? fail(`no trader ${i}`)
const lamportsOf = async (ctx: Ctx, key: PublicKey): Promise<bigint> => BigInt(await ctx.connection.getBalance(key, COMMITMENT))

/** Throws before a step that would take the payer below PAYER_FLOOR_LAMPORTS. */
async function guardPayer(ctx: Ctx, spend: bigint): Promise<void> {
  const balance = await lamportsOf(ctx, ctx.payer.publicKey)
  if (balance - spend < PAYER_FLOOR_LAMPORTS) throw new Error(`payer balance ${formatSol(balance)} SOL minus ${formatSol(spend)} would drop below the ${formatSol(PAYER_FLOOR_LAMPORTS)} SOL floor`)
}

/* ---------- output file ---------- */
function readOutput(): JsonObject {
  if (!existsSync(OUTPUT_PATH)) return {}
  const json: unknown = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'))
  return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as JsonObject) : {}
}
const writeOutput = (output: JsonObject): void => writeFileSync(OUTPUT_PATH, `${scrub(JSON.stringify(output, null, 1))}\n`)

/** This run's market accounts, from the graduate section mode 1 wrote. */
function recordedMarket(output: JsonObject): { market: PublicKey; pool: PublicKey } {
  const accounts = z.object({ market: z.string(), pool: z.string() }).safeParse((output.graduate as JsonObject | undefined)?.accounts)
  if (!accounts.success) throw new Error(`${OUTPUT_PATH} has no graduate.accounts; run without flags first`)
  return { market: new PublicKey(accounts.data.market), pool: new PublicKey(accounts.data.pool) }
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

/* ---------- traders and sweep ---------- */
const secretKeysSchema = z.array(z.array(z.number().int().min(0).max(255)).length(64)).length(TRADER_COUNT)
/** Reuses an existing traders file (never overwrites keys that may hold SOL); otherwise writes fresh keys first. */
function loadOrCreateTraders(createIfMissing: boolean): Keypair[] {
  mkdirSync(OUT_DIR, { recursive: true })
  if (existsSync(TRADERS_PATH)) {
    // The JSON.parse message would quote the key bytes, so it is dropped on purpose.
    const json: unknown = ((): unknown => { try { return JSON.parse(readFileSync(TRADERS_PATH, 'utf8')) } catch { return null } })()
    const parsed = secretKeysSchema.safeParse(json)
    if (!parsed.success) throw new Error(`${TRADERS_PATH} must be JSON holding ${TRADER_COUNT} 64-byte secret keys`)
    return parsed.data.map((secret) => Keypair.fromSecretKey(Uint8Array.from(secret)))
  }
  if (!createIfMissing) throw new Error(`${TRADERS_PATH} not found; nothing to sweep`)
  const traders = Array.from({ length: TRADER_COUNT }, () => Keypair.generate())
  writeFileSync(TRADERS_PATH, JSON.stringify(traders.map((t) => Array.from(t.secretKey))), { mode: TRADERS_FILE_MODE, flag: 'wx' })
  return traders
}

const wsolAtaOf = (ctx: Ctx, owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(ctx.quote.mint, owner, false, ctx.quote.tokenProgram)

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
      log.error('sweep failed, rerun --sweep to retry', { trader: keypair.publicKey.toBase58(), error })
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

/** Each trader's position in the market, null when it has none. */
async function readPositions(ctx: Ctx, market: PublicKey): Promise<(PositionAccount | null)[]> {
  const addresses = ctx.traders.map((t) => findPositionPda(market, t.publicKey, ctx.cluster.routerProgramId))
  const infos = await ctx.connection.getMultipleAccountsInfo(addresses, COMMITMENT)
  return addresses.map((address, i) => {
    const info = infos[i]
    return info === null || info === undefined ? null : decodePosition(address, info.data)
  })
}

/** Every router position of the market (any owner, current layout). */
async function marketPositionCount(ctx: Ctx, market: PublicKey): Promise<number> {
  const filters = [
    { memcmp: { offset: 0, bytes: POSITION_DISCRIMINATOR.toString('base64'), encoding: 'base64' as const } }, { dataSize: POSITION_ACCOUNT_SIZE_V2 },
    { memcmp: { offset: POSITION_MARKET_OFFSET, bytes: market.toBase58() } }]
  return (await ctx.connection.getProgramAccounts(ctx.cluster.routerProgramId, { commitment: COMMITMENT, filters, dataSlice: { offset: 0, length: 0 } })).length
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
async function buy(ctx: Ctx, live: Live, i: number, before: PositionAccount | null, amount: bigint): Promise<string> {
  const keypair = trader(ctx, i)
  const quote = await quoteBuy(ctx.connection, live.market, amount)
  const after = tokensOf(before) + quote.tokensOut
  if (after > live.cap) throw new Error(`buy by trader ${i} would pass the Anti-Whale cap (${after} > ${live.cap})`)
  const fund = await topUp(ctx, keypair.publicKey, amount + (before === null ? FIRST_BUY_RENT_LAMPORTS : 0n) + TRADER_FLOAT_LAMPORTS)
  const minOut = (quote.tokensOut * MIN_OUT_PERCENT) / PERCENT
  const ixs = buyInstructions({ cluster: ctx.cluster, accounts: live.accounts, user: keypair.publicKey, amountIn: amount, minOut })
  return send(ctx, `buy by trader ${i}`, [...fund, ...ixs], [keypair])
}

/** Exit at cost of `tokens`, the refund kept in the trader's wSOL ATA (swept later). */
async function exitAtCost(ctx: Ctx, live: Live, i: number, tokens: bigint): Promise<string> {
  const keypair = trader(ctx, i)
  const ixs = sellInstructions({ cluster: ctx.cluster, accounts: live.accounts, user: keypair.publicKey, tokens, unwrapSol: false })
  return send(ctx, `exit by trader ${i}`, ixs, [keypair])
}

/* ---------- mode 1: launch and graduate ---------- */
const marketAccountsRecord = (market: MarketAccount): Record<string, string> =>
  ({ market: market.address.toBase58(), ...Object.fromEntries(MARKET_FIELDS.map((field) => [field, market[field].toBase58()])) })

async function launch(ctx: Ctx): Promise<{ live: Live; signatures: string[] }> {
  const plan = await buildLaunchPlan({
    connection: ctx.connection, cluster: ctx.cluster, creator: ctx.payer.publicKey, ...TOKEN, initialBuy: 0n,
    preset: { quote: ctx.quote, migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD, feeBps: FEE_BPS, feeClaimer: ctx.payer.publicKey, leftoverReceiver: ctx.payer.publicKey },
  })
  const signatures: string[] = []
  for (const [i, tx] of plan.transactions.entries()) signatures.push(await send(ctx, `launch ${i}`, tx.instructions, plan.signers[i] ?? []))
  const market = (await fetchMarket(ctx.connection, plan.market)) ?? fail(`router market ${plan.market.toBase58()} missing after launch`)
  if (!market.quoteMint.equals(NATIVE_MINT)) throw new Error(`market ${market.address.toBase58()} is not a wSOL market`)
  const config = await readConfig(ctx, market.config)
  const threshold = toBigint(config.migrationQuoteThreshold)
  if (threshold !== MIGRATION_QUOTE_THRESHOLD) throw new Error(`market threshold ${threshold}, expected ${MIGRATION_QUOTE_THRESHOLD}`)
  const cap = (toBigint(config.swapBaseAmount) * ANTI_WHALE_BPS) / BPS
  return { live: { market, accounts: marketAccountsFor(market, ctx.quote.tokenProgram), cap }, signatures }
}

/** The trader holding the fewest tokens, so the buys spread evenly and none nears the Anti-Whale cap. */
const lightest = (positions: readonly (PositionAccount | null)[]): number =>
  positions.reduce((best, p, i) => (tokensOf(p) < tokensOf(positions[best]) ? i : best), 0)

/** Spread buys until the curve completes; returns the buy signatures. */
async function graduate(ctx: Ctx, live: Live): Promise<string[]> {
  const buys: string[] = []
  for (let n = 0; n < LIMITS.graduationBuys && !isComplete(await readCurve(ctx, live.market.pool)); n++) {
    const positions = await readPositions(ctx, live.market.address)
    const i = lightest(positions)
    buys.push(await buy(ctx, live, i, positions[i] ?? null, BUY_CHUNK))
  }
  return buys
}

/** After a failure on a live curve, exits every position at cost so the sweep can return the refunds. */
async function unwind(ctx: Ctx, live: Live | null): Promise<void> {
  if (live === null || isComplete(await readCurve(ctx, live.market.pool))) return
  for (const [i, position] of (await readPositions(ctx, live.market.address)).entries()) {
    if (tokensOf(position) === 0n) continue
    await exitAtCost(ctx, live, i, tokensOf(position)).catch((err: unknown) => log.error('unwind exit failed', { trader: i, error: scrub(errorMessage(err)) }))
  }
}

async function graduateMode(ctx: Ctx): Promise<number> {
  const before = await lamportsOf(ctx, ctx.payer.publicKey)
  await guardPayer(ctx, ESTIMATED_SPEND_LAMPORTS)
  const base: JsonObject = {
    task: 'CRK-07', cluster: 'devnet', routerProgramId: ctx.cluster.routerProgramId.toBase58(), dbcProgramId: ctx.cluster.dbcProgramId.toBase58(),
    payer: ctx.payer.publicKey.toBase58(), traders: ctx.traders.map((t) => t.publicKey.toBase58()),
    migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD.toString(), feeBps: FEE_BPS, buyChunkLamports: BUY_CHUNK.toString(),
  }
  let record: JsonObject = { startedAt: new Date().toISOString(), payerSolBefore: formatSol(before) }
  let live: Live | null = null
  let graduated = false
  try {
    const launched = await launch(ctx)
    live = launched.live
    record = { ...record, accounts: marketAccountsRecord(live.market), antiWhaleCap: live.cap.toString(), signatures: { launch: launched.signatures } }
    writeOutput({ ...base, graduate: record })
    process.stdout.write(`market: ${live.market.address.toBase58()}\npool: ${live.market.pool.toBase58()}\nbaseMint: ${live.market.baseMint.toBase58()}\n`)
    const buys = await graduate(ctx, live)
    const curve = await readCurve(ctx, live.market.pool)
    const held = (await readPositions(ctx, live.market.address)).map(tokensOf).filter((tokens) => tokens > 0n)
    const market = (await fetchMarket(ctx.connection, live.market.address)) ?? fail('market missing after graduation')
    graduated = isComplete(curve) && !market.finalized
    record = {
      ...record, signatures: { launch: launched.signatures, buys }, graduated, finalized: market.finalized,
      migrationProgress: curve.migrationProgress, quoteReserve: curve.quoteReserve.toString(), positions: held.length,
      largestPosition: held.reduce((max, tokens) => (tokens > max ? tokens : max), 0n).toString(),
    }
  } finally {
    // A graduated market keeps its traders funded: the crank's claims pay their wSOL ATAs, and --sweep runs after it.
    if (!graduated) {
      await unwind(ctx, live).catch((err: unknown) => log.error('unwind failed', { error: scrub(errorMessage(err)) }))
      record = { ...record, sweep: await sweepTraders(ctx) }
    }
    const after = await lamportsOf(ctx, ctx.payer.publicKey)
    record = { ...record, finishedAt: new Date().toISOString(), payerSolAfter: formatSol(after), spentSol: formatSol(before - after) }
    writeOutput({ ...base, graduate: record })
  }
  process.stdout.write(`graduated: ${graduated}\n`)
  return graduated ? 0 : 1
}

/* ---------- mode 2: record the crank run ---------- */
const logLineSchema = z.object({ msg: z.string(), ts: z.string().optional() })
/** A job's "crank job done" / "crank job reported errors" line (src/crank/index.ts runJob). */
const jobResultSchema = z.object({ job: z.string(), tick: z.number(), sent: z.array(z.string()), errors: z.array(z.string()) })
type JobResult = z.infer<typeof jobResultSchema>

/** The worker's JSON log lines (npm's banner lines are skipped). */
function readCrankLog(path: string): unknown[] {
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return []
    try { return [JSON.parse(line) as unknown] } catch { return [] }
  })
}
const parseAll = <T>(schema: z.ZodType<T>, values: readonly unknown[]): T[] =>
  values.flatMap((value) => { const parsed = schema.safeParse(value); return parsed.success ? [parsed.data] : [] })

/** Router Market address by Market or DBC pool address, for every router market on the cluster. */
async function routerMarketIndex(ctx: Ctx): Promise<ReadonlyMap<string, string>> {
  const markets = await fetchAllMarkets(ctx.connection, ctx.cluster.routerProgramId)
  return new Map(markets.flatMap((m) => [[m.address.toBase58(), m.address.toBase58()], [m.pool.toBase58(), m.address.toBase58()]] as const))
}

/** Each signature's cluster status and the router markets (by Market or DBC pool account) its transaction touched. */
async function describeSent(ctx: Ctx, marketOf: ReadonlyMap<string, string>, sent: readonly { signature: string; tick: number }[]): Promise<SentTx[]> {
  const rows: SentTx[] = []
  for (let start = 0; start < sent.length; start += LIMITS.statusBatch) {
    const batch = sent.slice(start, start + LIMITS.statusBatch)
    const { value } = await ctx.connection.getSignatureStatuses(batch.map((s) => s.signature), { searchTransactionHistory: true })
    for (const [i, { signature, tick }] of batch.entries()) {
      const tx = await ctx.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      const keys = tx?.transaction.message.staticAccountKeys.map((k) => k.toBase58()) ?? []
      const markets = [...new Set(keys.flatMap((k) => { const m = marketOf.get(k); return m === undefined ? [] : [m] }))]
      const status = value[i]
      rows.push({ signature, tick, status: status?.confirmationStatus ?? 'not found', err: status?.err == null ? null : JSON.stringify(status.err), markets })
    }
  }
  return rows
}

/** Signatures (with their tick) that `job` reported as sent across the run. */
const sentBy = (results: readonly JobResult[], job: string): { signature: string; tick: number }[] =>
  results.filter((l) => l.job === job).flatMap((l) => l.sent.map((signature) => ({ signature, tick: l.tick })))

async function recordMode(ctx: Ctx): Promise<number> {
  const output = readOutput()
  const ours = recordedMarket(output).market.toBase58()
  const raw = readCrankLog(resolve(expandHome(process.env.CRANK_LOG?.trim() || DEFAULT_CRANK_LOG)))
  const lines = parseAll(logLineSchema, raw)
  const results = parseAll(jobResultSchema, raw)
  const marketOf = await routerMarketIndex(ctx)
  const described: (readonly [string, SentTx[]])[] = []
  for (const job of CRANK_JOBS) described.push([job, await describeSent(ctx, marketOf, sentBy(results, job))])
  const jobs = Object.fromEntries(described)
  const ourMarket = Object.fromEntries(described.map(([job, txs]) => [job, txs.filter((t) => t.markets.includes(ours)).map((t) => t.signature)]))
  const otherMarkets = [...new Set(described.flatMap(([, txs]) => txs.flatMap((t) => t.markets)))].filter((m) => m !== ours)
  const jobErrors = Object.fromEntries(CRANK_JOBS.map((job) => [job, results.filter((l) => l.job === job).reduce((n, l) => n + l.errors.length, 0)]))
  const crank = {
    log: 'out/crank-run.log', command: 'RPC_URL="$DEVNET_RPC" CLUSTER=devnet CRANK_INTERVAL_MS=10000 npm start (stopped after 180 s)',
    guards: 'worker defaults (MIN_ATA_VALUE_LAMPORTS 250000000): every trader kept its wSOL ATA from buying, so no claim needed an ATA',
    startedAt: lines.find((l) => l.msg === 'crank started')?.ts ?? null, finishedAt: lines.at(-1)?.ts ?? null,
    ticks: lines.filter((l) => l.msg === 'crank tick').length, jobErrors, ourMarket: { market: ours, ...ourMarket }, otherMarkets, jobs,
  }
  writeOutput({ ...output, crank })
  for (const [job, txs] of described) process.stdout.write(`${job}: ${txs.length} sent, ${(ourMarket[job] ?? []).length} on ${ours}\n`)
  process.stdout.write(`other markets touched: ${otherMarkets.length}\n`)
  return 0
}

/* ---------- mode 3: sweep ---------- */
async function sweepMode(ctx: Ctx): Promise<number> {
  const output = readOutput()
  const { market } = recordedMarket(output)
  const positionsLeft = await marketPositionCount(ctx, market)
  const ownPositionsLeft = (await readPositions(ctx, market)).filter((p) => p !== null).length
  if (positionsLeft > 0) log.warn('positions of the market remain; their claims will need a new wSOL ATA', { positionsLeft })
  const rows = await sweepTraders(ctx)
  const left = await ctx.connection.getMultipleAccountsInfo(ctx.traders.flatMap((t) => [t.publicKey, wsolAtaOf(ctx, t.publicKey)]), COMMITMENT)
  const leftover = left.reduce((sum, info) => sum + BigInt(info?.lamports ?? 0), 0n)
  const swept = rows.reduce((sum, row) => sum + BigInt(row.lamports), 0n)
  const after = await lamportsOf(ctx, ctx.payer.publicKey)
  const failed = rows.filter((row) => row.error !== undefined).length
  writeOutput({ ...output, sweep: { at: new Date().toISOString(), positionsLeft, traderPositionsLeft: ownPositionsLeft, sweptSol: formatSol(swept), leftoverLamports: leftover.toString(), failed, rows, payerSolAfter: formatSol(after) } })
  process.stdout.write(`positions left: ${positionsLeft}\nswept ${formatSol(swept)} SOL, ${failed} failed, ${leftover} lamports left\npayer: ${formatSol(after)} SOL\n`)
  return failed === 0 && leftover === 0n ? 0 : 1
}

/* ---------- main ---------- */
/** Refuses any cluster but devnet (genesis hash) before a key is loaded or a transaction is built. */
async function createContext(rpc: URL, createTraders: boolean): Promise<Ctx> {
  const clusterName = process.env.CLUSTER?.trim() || 'devnet'
  if (clusterName !== 'devnet') throw new Error(`CLUSTER must be devnet, got ${clusterName}`)
  const connection = new Connection(rpc.href, COMMITMENT)
  const genesis = await connection.getGenesisHash()
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error(`RPC_URL is not devnet (genesis ${genesis}); refusing to send anything`)
  const cluster = getClusterConfig('devnet')
  const quote = cluster.quoteMints.find((q) => q.symbol === 'SOL') ?? fail('devnet has no SOL quote mint')
  const payer = loadCrankKeypair(process.env.PAYER_KEYPAIR?.trim() || DEFAULT_PAYER_KEYPAIR)
  return { connection, cluster, quote, payer, traders: loadOrCreateTraders(createTraders), dbc: createDbcProgram(connection, COMMITMENT).program }
}

async function main(): Promise<number> {
  const rpc = parseRpcUrl(process.env)
  protectRpcUrl(rpc)
  const mode = process.argv.includes('--record') ? 'record' : process.argv.includes('--sweep') ? 'sweep' : 'graduate'
  const ctx = await createContext(rpc, mode === 'graduate')
  log.info('graduate-devnet', { mode, payer: ctx.payer.publicKey.toBase58(), sol: formatSol(await lamportsOf(ctx, ctx.payer.publicKey)) })
  if (mode === 'record') return recordMode(ctx)
  if (mode === 'sweep') return sweepMode(ctx)
  return graduateMode(ctx)
}

/** Exits explicitly: an RPC websocket left open by confirmTransaction must not keep the process alive. */
main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log.error('graduate-devnet failed', { error: scrub(errorMessage(err)) })
    process.exit(1)
  },
)
