/**
 * OPS-07: seeds devnet with three Trucee demo markets on router v5, so Discover is never empty:
 *   live       a live curve with spread buys and an exit at cost (about 30% curve progress)
 *   hot        a live curve above 70% progress (about 82%)
 *   graduated  a completed curve: router finalize, every position claimed, then migrated to DAMM v2 with the DBC SDK
 * Each market uses the SDK Zero-PvP preset (SOL quote, migrationQuoteThreshold 0.3 SOL, 1% fee) and metadata uploaded
 * to the local app's POST /api/metadata (the uri on chain points at that app).
 *
 * Six throwaway traders buy and sell through the router. Their keys go to out/seed-devnet.traders.json (gitignored)
 * before any of them is funded; an existing file is reused, never overwritten. Every trader transaction is paid by the
 * payer, and a buy tops its trader up in the same transaction with only what that buy needs. Buys always go to the
 * trader holding the fewest tokens and are checked against the v5 Anti-Whale cap (20% of the config's
 * swap_base_amount) before they are sent. Trader SOL (wallet plus wSOL ATA) is swept back to the payer at the end,
 * also when a step fails. Market base-token ATAs and the positions of the live markets stay: that is the demo data.
 *
 * Known devnet bug (not handled here): sdk fetchAllMarkets and the crank jobs throw on two legacy 241-byte markets,
 * so this script reads only the markets it creates (fetchMarket) and calls the instruction builders directly.
 *
 * Usage (from worker/, with the app serving /api/metadata; the RPC URL never reaches argv or the output):
 *   RPC_URL="$DEVNET_RPC" npx tsx scripts/seed-devnet.ts
 *   node --env-file=<main checkout>/litesvm-diff/.env --import tsx scripts/seed-devnet.ts
 *
 * Env:
 *   RPC_URL            devnet RPC endpoint, falls back to DEVNET_RPC (required, never printed). The genesis hash must
 *                      be devnet's, so a mainnet URL is refused before anything is sent.
 *   PAYER_KEYPAIR      payer and creator keypair file (default ~/.config/solana/id.json)
 *   METADATA_BASE_URL  the app serving POST /api/metadata (default http://localhost:3000)
 *
 * Output: out/seed-devnet.json (markets, mints, pools, statuses, progress, signatures). Refuses to run when that file
 * already records a complete seed; delete it to seed again.
 * Exit code: 0 when the three markets end live / live (>= 7000 bps) / migrated, 1 otherwise.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  DynamicBondingCurveClient,
  createDbcProgram,
  deriveDammV2PoolAddress,
  type ConfigWithTransferHook,
  type TransferHookPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  buildLaunchPlan,
  buyInstructions,
  claimSurplusInstruction,
  decodePosition,
  decodeTxError,
  fetchMarket,
  finalizeInstruction,
  findPositionPda,
  getClusterConfig,
  marketAccountsFor,
  quoteBuy,
  sellInstructions,
  type ClusterConfig,
  type MarketAccount,
  type MarketAccounts,
  type PositionAccount,
  type QuoteMintInfo,
} from '@trucee/sdk'
import { z } from 'zod'
import { loadCrankKeypair } from '../src/config.js'
import { errorMessage, log, registerSecret } from '../src/log.js'

/* ---------- constants ---------- */

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(WORKER_DIR, 'out')
const OUTPUT_PATH = join(OUT_DIR, 'seed-devnet.json')
const TRADERS_PATH = join(OUT_DIR, 'seed-devnet.traders.json')
const TRADERS_FILE_MODE = 0o600

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const COMMITMENT = 'confirmed'
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1'])
const DEFAULT_PAYER_KEYPAIR = '~/.config/solana/id.json'
const DEFAULT_METADATA_BASE_URL = 'http://localhost:3000'
const MIN_SECRET_FRAGMENT = 8

const LAMPORTS_PER_SOL = 1_000_000_000n
const MIGRATION_QUOTE_THRESHOLD = 300_000_000n
const FEE_BPS = 100
const TRADER_COUNT = 6
const BPS = 10_000n
const FULL_PROGRESS_BPS = BPS
/** zpvp_router ANTI_WHALE_BPS: one position may hold at most 20% of the config's swap_base_amount. */
const ANTI_WHALE_BPS = 2_000n
const PERCENT = 100n
/** Buys accept at most 1% less than quoted (the payer is the only trader on these fresh markets). */
const MIN_OUT_PERCENT = 99n
/** The run stops before any step that would take the payer below 5 SOL. */
const PAYER_FLOOR_LAMPORTS = 5n * LAMPORTS_PER_SOL
/** Three curves of 0.3 SOL at most, plus rents and fees, with a margin. */
const ESTIMATED_SPEND_LAMPORTS = LAMPORTS_PER_SOL
/** A trader's first buy in a market: base ATA, position and maybe the wSOL ATA rent (~0.0058 SOL), rounded up. */
const FIRST_BUY_RENT_LAMPORTS = 7_000_000n
/** Kept on a trader after each buy so its wallet never drops below the rent-exempt minimum (0.00089 SOL). */
const TRADER_FLOAT_LAMPORTS = 2_000_000n
const MAX_SEND_ATTEMPTS = 3
const MAX_BUYS_PER_FILL = 150
const LOG_TAIL_LINES = 8

/** DBC MigrationProgress (worker/src/crank/jobs/migrate.ts). */
const PRE_BONDING_CURVE = 0
const LOCKED_VESTING = 2
const CREATED_POOL = 3
/** Position: discriminator 8 | owner 32 | market 32 | ... */
const POSITION_MARKET_OFFSET = 40
const ANCHOR_DISCRIMINATOR_BYTES = 8
const POSITION_DISCRIMINATOR = createHash('sha256').update('account:Position').digest().subarray(0, ANCHOR_DISCRIMINATOR_BYTES)

const PNG_SIDE = 64
const PNG_STRIPE = 8
const PNG_BIT_DEPTH = 8
const PNG_COLOR_TYPE_RGB = 2
const PNG_FILTER_NONE = 0
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BACKGROUND: Rgb = [16, 18, 24]
const HTTP_CREATED = 201
const HTTP_OK = 200

/* ---------- market specs ---------- */

type Rgb = readonly [number, number, number]
type MarketLabel = 'live' | 'hot' | 'graduated'
type Phase = { readonly kind: 'fill'; readonly targetBps: bigint } | { readonly kind: 'sell'; readonly percent: bigint }

interface MarketSpec {
  readonly label: MarketLabel
  readonly name: string
  readonly symbol: string
  readonly description: string
  readonly color: Rgb
  /** Lamports per spread buy. */
  readonly chunk: bigint
  readonly phases: readonly Phase[]
  readonly graduate: boolean
}

const fill = (targetBps: bigint): Phase => ({ kind: 'fill', targetBps })
const sell = (percent: bigint): Phase => ({ kind: 'sell', percent })

const SPECS: readonly MarketSpec[] = [
  {
    label: 'live', name: 'Trucee Demo Live', symbol: 'DEMO1', color: [46, 196, 140],
    description: 'Trucee devnet demo: a live Zero-PvP curve with buys and an exit at cost. Test token, no value.',
    chunk: MIGRATION_QUOTE_THRESHOLD / 30n, phases: [fill(2_000n), sell(50n), fill(3_000n)], graduate: false,
  },
  {
    label: 'hot', name: 'Trucee Demo Hot', symbol: 'DEMO2', color: [255, 140, 50],
    description: 'Trucee devnet demo: a live Zero-PvP curve close to graduation. Test token, no value.',
    chunk: MIGRATION_QUOTE_THRESHOLD / 40n, phases: [fill(5_000n), sell(30n), fill(8_200n)], graduate: false,
  },
  {
    label: 'graduated', name: 'Trucee Demo Graduated', symbol: 'DEMO3', color: [120, 110, 255],
    description: 'Trucee devnet demo: a graduated Zero-PvP curve, surplus claimed and migrated to DAMM v2. Test token, no value.',
    chunk: MIGRATION_QUOTE_THRESHOLD / 40n,
    phases: [fill(4_000n), sell(50n), fill(7_000n), sell(30n), fill(FULL_PROGRESS_BPS)], graduate: true,
  },
]

/* ---------- types ---------- */

type DbcProgram = ReturnType<typeof createDbcProgram>['program']

interface Ctx {
  readonly connection: Connection
  readonly cluster: ClusterConfig
  readonly quote: QuoteMintInfo
  readonly payer: Keypair
  readonly traders: readonly Keypair[]
  readonly dbc: DbcProgram
}

interface LiveMarket {
  readonly market: MarketAccount
  readonly accounts: MarketAccounts
  readonly cap: bigint
  readonly threshold: bigint
}

interface CurveState {
  readonly quoteReserve: bigint
  readonly migrationProgress: number
  readonly isMigrated: boolean
}

interface Trade {
  readonly kind: 'buy' | 'sell'
  readonly trader: string
  /** Lamports in for a buy, raw base tokens out of the position for a sell. */
  readonly amount: string
  readonly signature: string
}

interface Metadata {
  readonly uri: string
  readonly image: string
}

interface Graduation {
  readonly finalize: string
  readonly claims: readonly { readonly owner: string; readonly signature: string }[]
  readonly migrate: string
  readonly dammConfig: string
  readonly dammPool: string
}

interface MarketRecord {
  readonly label: MarketLabel
  readonly name: string
  readonly symbol: string
  readonly uri: string
  readonly image: string
  readonly market: string
  readonly pool: string
  readonly config: string
  readonly baseMint: string
  readonly quoteMint: string
  readonly bufferVault: string
  readonly launch: readonly string[]
  readonly trades: readonly Trade[]
  readonly graduation: Graduation | null
}

interface SweepRow {
  readonly trader: string
  readonly lamports: string
  readonly signature: string | null
  readonly error?: string
}

/* ---------- RPC URL and secrets ---------- */

function parseRpcUrl(env: NodeJS.ProcessEnv): URL {
  const raw = [env.RPC_URL, env.DEVNET_RPC].map((v) => v?.trim()).find((v) => v !== undefined && v !== '')
  if (raw === undefined) throw new Error('RPC_URL is required (load DEVNET_RPC from litesvm-diff/.env)')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('RPC_URL must be an https URL')
  }
  const isLocalHttp = url.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !isLocalHttp) throw new Error('RPC_URL must be an https URL')
  return url
}

/** Registers every part of the RPC URL that could identify the provider or carry its key, so no log line shows it. */
function registerRpcSecrets(url: URL): void {
  const parts = [url.href, url.origin, url.host, url.hostname, url.pathname, url.search, ...url.pathname.split('/'), ...url.searchParams.values()]
  parts.filter((part) => part.length >= MIN_SECRET_FRAGMENT).forEach(registerSecret)
}

let scrubList: readonly string[] = []
/** Removes the RPC URL parts from text bound for the output file (log lines are scrubbed by the logger). */
const scrub = (text: string): string => scrubList.reduce((acc, part) => acc.split(part).join('[redacted]'), text)

async function assertDevnet(connection: Connection): Promise<void> {
  const genesis = await connection.getGenesisHash()
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error(`RPC_URL is not devnet (genesis ${genesis}); refusing to send anything`)
}

/* ---------- small helpers ---------- */

const formatSol = (lamports: bigint): string =>
  `${lamports / LAMPORTS_PER_SOL}.${(lamports % LAMPORTS_PER_SOL).toString().padStart(9, '0')}`

const toBigint = (value: { toString(): string }): bigint => BigInt(value.toString())

async function lamportsOf(ctx: Ctx, key: PublicKey): Promise<bigint> {
  return BigInt(await ctx.connection.getBalance(key, COMMITMENT))
}

/** Throws before a step that would take the payer below PAYER_FLOOR_LAMPORTS. */
async function guardPayer(ctx: Ctx, spend: bigint): Promise<void> {
  const balance = await lamportsOf(ctx, ctx.payer.publicKey)
  if (balance - spend < PAYER_FLOOR_LAMPORTS) {
    throw new Error(`payer balance ${formatSol(balance)} SOL minus ${formatSol(spend)} would drop below the ${formatSol(PAYER_FLOOR_LAMPORTS)} SOL floor`)
  }
}

function describeSendError(err: unknown): string {
  const decoded = decodeTxError(err)
  const logs = err instanceof SendTransactionError ? (err.logs ?? []) : []
  const name = decoded === null ? errorMessage(err) : `${decoded.program} ${decoded.name}: ${decoded.message}`
  const tail = logs.slice(-LOG_TAIL_LINES).join(' | ')
  return scrub(tail === '' ? name : `${name} (logs: ${tail})`)
}

/* ---------- sending ---------- */

function uniqueSigners(signers: readonly Keypair[]): Keypair[] {
  return signers.filter((s, i) => signers.findIndex((t) => t.publicKey.equals(s.publicKey)) === i)
}

type Blockhash = Awaited<ReturnType<Connection['getLatestBlockhash']>>

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
  if (value === null) return true
  if (value.err !== null) throw new Error(`${label}: transaction ${signature} failed: ${JSON.stringify(value.err)}`)
  return false
}

/**
 * Sends `instructions` with the payer as fee payer and a fresh blockhash, signed by the payer and `signers`. Resends
 * only when the blockhash expired and the signature never landed; any other failure throws with the program logs.
 */
async function send(ctx: Ctx, label: string, instructions: readonly TransactionInstruction[], signers: readonly Keypair[]): Promise<string> {
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const latest = await ctx.connection.getLatestBlockhash(COMMITMENT)
    const tx = new Transaction({ feePayer: ctx.payer.publicKey, ...latest }).add(...instructions)
    tx.sign(...uniqueSigners([ctx.payer, ...signers]))
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
  throw new Error(`${label}: not confirmed after ${MAX_SEND_ATTEMPTS} attempts`)
}

/* ---------- traders ---------- */

const secretKeysSchema = z.array(z.array(z.number().int().min(0).max(255)).length(64)).length(TRADER_COUNT)

/** Reuses an existing traders file (never overwrites keys that may hold positions); otherwise writes fresh keys. */
function loadOrCreateTraders(): Keypair[] {
  mkdirSync(OUT_DIR, { recursive: true })
  if (existsSync(TRADERS_PATH)) {
    let json: unknown
    try {
      json = JSON.parse(readFileSync(TRADERS_PATH, 'utf8'))
    } catch {
      throw new Error(`${TRADERS_PATH} is not valid JSON`)
    }
    const parsed = secretKeysSchema.safeParse(json)
    if (!parsed.success) throw new Error(`${TRADERS_PATH} must hold ${TRADER_COUNT} 64-byte secret keys`)
    return parsed.data.map((secret) => Keypair.fromSecretKey(Uint8Array.from(secret)))
  }
  const traders = Array.from({ length: TRADER_COUNT }, () => Keypair.generate())
  writeFileSync(TRADERS_PATH, JSON.stringify(traders.map((t) => Array.from(t.secretKey))), { mode: TRADERS_FILE_MODE, flag: 'wx' })
  return traders
}

/** Closes the trader's wSOL ATA and sends every lamport to the payer (the payer pays the fee). */
async function sweepTrader(ctx: Ctx, trader: Keypair): Promise<SweepRow> {
  const wsolAta = getAssociatedTokenAddressSync(ctx.quote.mint, trader.publicKey, false, ctx.quote.tokenProgram)
  const [wallet, ata] = await ctx.connection.getMultipleAccountsInfo([trader.publicKey, wsolAta], COMMITMENT)
  const lamports = BigInt((wallet?.lamports ?? 0) + (ata?.lamports ?? 0))
  if (lamports === 0n) return { trader: trader.publicKey.toBase58(), lamports: '0', signature: null }
  const close = ata === null ? [] : [createCloseAccountInstruction(wsolAta, trader.publicKey, trader.publicKey, [], ctx.quote.tokenProgram)]
  const transfer = SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: ctx.payer.publicKey, lamports })
  const signature = await send(ctx, 'sweep', [...close, transfer], [trader])
  return { trader: trader.publicKey.toBase58(), lamports: lamports.toString(), signature }
}

async function sweepTraders(ctx: Ctx): Promise<readonly SweepRow[]> {
  const rows: SweepRow[] = []
  for (const trader of ctx.traders) {
    try {
      const row = await sweepTrader(ctx, trader)
      log.info('swept trader', { trader: row.trader, sol: formatSol(BigInt(row.lamports)) })
      rows.push(row)
    } catch (err) {
      const error = scrub(errorMessage(err))
      log.error('sweep failed, rerun to retry', { trader: trader.publicKey.toBase58(), error })
      rows.push({ trader: trader.publicKey.toBase58(), lamports: '0', signature: null, error })
    }
  }
  return rows
}

/* ---------- metadata ---------- */

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

/** A 64x64 RGB PNG with diagonal stripes of `color`, a few hundred bytes. */
function demoPng(color: Rgb): Uint8Array<ArrayBuffer> {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(PNG_SIDE, 0)
  header.writeUInt32BE(PNG_SIDE, 4)
  header.set([PNG_BIT_DEPTH, PNG_COLOR_TYPE_RGB], 8)
  const pixel = (x: number, y: number): Rgb => (Math.floor((x + y) / PNG_STRIPE) % 2 === 0 ? color : PNG_BACKGROUND)
  const row = (y: number): number[] => [PNG_FILTER_NONE, ...Array.from({ length: PNG_SIDE }, (_, x) => [...pixel(x, y)]).flat()]
  const raw = Buffer.from(Array.from({ length: PNG_SIDE }, (_, y) => row(y)).flat())
  const png = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
  return new Uint8Array(png)
}

const savedMetadataSchema = z.object({ id: z.string(), uri: z.url(), image: z.url() })

async function expectOk(url: string, what: string): Promise<void> {
  const response = await fetch(url)
  if (response.status !== HTTP_OK) throw new Error(`${what} ${url} returned HTTP ${response.status}`)
}

async function uploadMetadata(baseUrl: URL, spec: MarketSpec): Promise<Metadata> {
  const form = new FormData()
  form.set('name', spec.name)
  form.set('symbol', spec.symbol)
  form.set('description', spec.description)
  form.set('image', new Blob([demoPng(spec.color)], { type: 'image/png' }), `${spec.symbol.toLowerCase()}.png`)
  const response = await fetch(new URL('/api/metadata', baseUrl), { method: 'POST', body: form })
  const body: unknown = await response.json().catch(() => null)
  if (response.status !== HTTP_CREATED) throw new Error(`metadata upload for ${spec.symbol} failed: HTTP ${response.status} ${JSON.stringify(body)}`)
  const saved = savedMetadataSchema.parse(body)
  await expectOk(saved.uri, 'metadata uri')
  await expectOk(saved.image, 'metadata image')
  log.info('metadata uploaded', { symbol: spec.symbol, id: saved.id })
  return { uri: saved.uri, image: saved.image }
}

/* ---------- chain reads ---------- */

async function readCurve(ctx: Ctx, pool: PublicKey): Promise<CurveState> {
  const info = await ctx.connection.getAccountInfo(pool, COMMITMENT)
  if (info === null) throw new Error(`DBC pool ${pool.toBase58()} not found`)
  const { poolState } = ctx.dbc.coder.accounts.decode<TransferHookPool>('transferHookPool', info.data)
  const migrationProgress = Number(poolState.migrationProgress)
  return {
    quoteReserve: toBigint(poolState.quoteReserve),
    migrationProgress,
    isMigrated: Number(poolState.isMigrated) !== 0 || migrationProgress === CREATED_POOL,
  }
}

async function readConfig(ctx: Ctx, config: PublicKey): Promise<ConfigWithTransferHook['config']> {
  const info = await ctx.connection.getAccountInfo(config, COMMITMENT)
  if (info === null) throw new Error(`DBC config ${config.toBase58()} not found`)
  return ctx.dbc.coder.accounts.decode<ConfigWithTransferHook>('configWithTransferHook', info.data).config
}

const isComplete = (curve: CurveState): boolean => curve.isMigrated || curve.migrationProgress !== PRE_BONDING_CURVE

/** As app/src/lib/server/markets.ts: quoteReserve / threshold in bps, floored and capped; 10000 once complete. */
function progressBps(curve: CurveState, threshold: bigint): bigint {
  if (isComplete(curve)) return FULL_PROGRESS_BPS
  const bps = (curve.quoteReserve * BPS) / threshold
  return bps > FULL_PROGRESS_BPS ? FULL_PROGRESS_BPS : bps
}

/** Each trader's position in `market`, null when it has none. */
async function readPositions(ctx: Ctx, market: PublicKey): Promise<(PositionAccount | null)[]> {
  const addresses = ctx.traders.map((t) => findPositionPda(market, t.publicKey, ctx.cluster.routerProgramId))
  const infos = await ctx.connection.getMultipleAccountsInfo(addresses, COMMITMENT)
  return addresses.map((address, i) => {
    const info = infos[i]
    return info === null || info === undefined ? null : decodePosition(address, info.data)
  })
}

const tokensOf = (position: PositionAccount | null): bigint => position?.tokens ?? 0n

function indexBy(positions: readonly (PositionAccount | null)[], better: (a: bigint, b: bigint) => boolean): number {
  return positions.reduce((best, p, i) => (better(tokensOf(p), tokensOf(positions[best] ?? null)) ? i : best), 0)
}

/* ---------- launch and trades ---------- */

async function launchMarket(ctx: Ctx, spec: MarketSpec, metadata: Metadata): Promise<{ live: LiveMarket; launch: string[] }> {
  const plan = await buildLaunchPlan({
    connection: ctx.connection, cluster: ctx.cluster, creator: ctx.payer.publicKey,
    name: spec.name, symbol: spec.symbol, uri: metadata.uri, initialBuy: 0n,
    preset: {
      quote: ctx.quote, migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD, feeBps: FEE_BPS,
      feeClaimer: ctx.payer.publicKey, leftoverReceiver: ctx.payer.publicKey,
    },
  })
  const launch: string[] = []
  for (const [i, tx] of plan.transactions.entries()) {
    launch.push(await send(ctx, `${spec.label} launch ${i}`, tx.instructions, plan.signers[i] ?? []))
  }
  const market = await fetchMarket(ctx.connection, plan.market)
  if (market === null) throw new Error(`${spec.label}: router market ${plan.market.toBase58()} missing after launch`)
  const config = await readConfig(ctx, market.config)
  const live: LiveMarket = {
    market,
    accounts: marketAccountsFor(market, ctx.quote.tokenProgram),
    cap: (toBigint(config.swapBaseAmount) * ANTI_WHALE_BPS) / BPS,
    threshold: toBigint(config.migrationQuoteThreshold),
  }
  log.info('market launched', { label: spec.label, market: market.address.toBase58(), baseMint: market.baseMint.toBase58() })
  return { live, launch }
}

/** One router buy of `amount` lamports by trader `i`, topped up by the payer in the same transaction. */
async function buy(ctx: Ctx, m: LiveMarket, i: number, amount: bigint, position: PositionAccount | null): Promise<Trade> {
  const trader = ctx.traders[i]!
  const quoted = await quoteBuy(ctx.connection, m.market, amount)
  if (tokensOf(position) + quoted.tokensOut > m.cap) {
    throw new Error(`buy by trader ${i} would pass the Anti-Whale cap (${tokensOf(position) + quoted.tokensOut} > ${m.cap})`)
  }
  const need = amount + (position === null ? FIRST_BUY_RENT_LAMPORTS : 0n) + TRADER_FLOAT_LAMPORTS
  const balance = await lamportsOf(ctx, trader.publicKey)
  const topUp = need > balance ? need - balance : 0n
  await guardPayer(ctx, topUp)
  const fund = topUp > 0n ? [SystemProgram.transfer({ fromPubkey: ctx.payer.publicKey, toPubkey: trader.publicKey, lamports: topUp })] : []
  const minOut = (quoted.tokensOut * MIN_OUT_PERCENT) / PERCENT
  const ixs = buyInstructions({ cluster: ctx.cluster, accounts: m.accounts, user: trader.publicKey, amountIn: amount, minOut })
  const signature = await send(ctx, 'buy', [...fund, ...ixs], [trader])
  return { kind: 'buy', trader: trader.publicKey.toBase58(), amount: amount.toString(), signature }
}

/** Spread buys of `chunk`, each by the trader holding the fewest tokens, until the progress target (or completion). */
async function fillTo(ctx: Ctx, m: LiveMarket, targetBps: bigint, chunk: bigint): Promise<Trade[]> {
  const trades: Trade[] = []
  for (let n = 0; n < MAX_BUYS_PER_FILL; n++) {
    const curve = await readCurve(ctx, m.market.pool)
    if (isComplete(curve) || progressBps(curve, m.threshold) >= targetBps) return trades
    const positions = await readPositions(ctx, m.market.address)
    const i = indexBy(positions, (a, b) => a < b)
    trades.push(await buy(ctx, m, i, chunk, positions[i] ?? null))
  }
  throw new Error(`fill to ${targetBps} bps did not finish within ${MAX_BUYS_PER_FILL} buys`)
}

/** Exit at cost of `percent` of the largest position. */
async function sellShare(ctx: Ctx, m: LiveMarket, percent: bigint): Promise<Trade> {
  const positions = await readPositions(ctx, m.market.address)
  const i = indexBy(positions, (a, b) => a > b)
  const tokens = (tokensOf(positions[i] ?? null) * percent) / PERCENT
  if (tokens === 0n) throw new Error('sell: no position to sell from')
  const trader = ctx.traders[i]!
  const ixs = sellInstructions({ cluster: ctx.cluster, accounts: m.accounts, user: trader.publicKey, tokens, unwrapSol: false })
  const signature = await send(ctx, 'sell', ixs, [trader])
  return { kind: 'sell', trader: trader.publicKey.toBase58(), amount: tokens.toString(), signature }
}

async function runPhases(ctx: Ctx, spec: MarketSpec, m: LiveMarket): Promise<Trade[]> {
  const trades: Trade[] = []
  for (const phase of spec.phases) {
    const done = phase.kind === 'fill' ? await fillTo(ctx, m, phase.targetBps, spec.chunk) : [await sellShare(ctx, m, phase.percent)]
    trades.push(...done)
    const bps = progressBps(await readCurve(ctx, m.market.pool), m.threshold)
    log.info('phase done', { label: spec.label, phase: phase.kind, trades: done.length, progressBps: Number(bps) })
  }
  return trades
}

/* ---------- graduation: finalize, claims, migration ---------- */

/** Every router position of `market` (any owner), by discriminator and market memcmp. */
async function marketPositions(ctx: Ctx, market: PublicKey): Promise<PositionAccount[]> {
  const accounts = await ctx.connection.getProgramAccounts(ctx.cluster.routerProgramId, {
    commitment: COMMITMENT,
    filters: [
      { memcmp: { offset: 0, bytes: POSITION_DISCRIMINATOR.toString('base64'), encoding: 'base64' } },
      { memcmp: { offset: POSITION_MARKET_OFFSET, bytes: market.toBase58() } },
    ],
  })
  return accounts.map(({ pubkey, account }) => decodePosition(pubkey, account.data))
}

async function claimAll(ctx: Ctx, m: LiveMarket): Promise<Graduation['claims']> {
  const claims: { owner: string; signature: string }[] = []
  for (const position of await marketPositions(ctx, m.market.address)) {
    const ownerQuote = getAssociatedTokenAddressSync(m.accounts.quoteMint, position.owner, true, m.accounts.quoteTokenProgram)
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(ctx.payer.publicKey, ownerQuote, position.owner, m.accounts.quoteMint, m.accounts.quoteTokenProgram),
      claimSurplusInstruction({ cluster: ctx.cluster, accounts: m.accounts, cranker: ctx.payer.publicKey, owner: position.owner }),
    ]
    claims.push({ owner: position.owner.toBase58(), signature: await send(ctx, 'claim_surplus', ixs, []) })
  }
  const left = await marketPositions(ctx, m.market.address)
  if (left.length > 0) throw new Error(`${left.length} positions still open after claims`)
  return claims
}

/** migration_damm_v2 through the DBC SDK, as litesvm-diff/src/migrate_devnet.ts (ONC-10). */
async function migrateToDammV2(ctx: Ctx, m: LiveMarket): Promise<Pick<Graduation, 'migrate' | 'dammConfig' | 'dammPool'>> {
  const config = await readConfig(ctx, m.market.config)
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption]
  if (dammConfig === undefined) throw new Error(`migration fee option ${config.migrationFeeOption} has no DAMM v2 config`)
  const curve = await readCurve(ctx, m.market.pool)
  if (curve.migrationProgress !== LOCKED_VESTING || curve.isMigrated) {
    throw new Error(`pool is not ready to migrate (migrationProgress ${curve.migrationProgress}, isMigrated ${curve.isMigrated})`)
  }
  const client = new DynamicBondingCurveClient(ctx.connection, COMMITMENT)
  const migration = await client.migration.migrateToDammV2({ payer: ctx.payer.publicKey, pool: m.market.pool, dammConfig })
  const ixs = migration.transaction.instructions
  const isSigner = (key: PublicKey): boolean => ixs.some((ix) => ix.keys.some((meta) => meta.isSigner && meta.pubkey.equals(key)))
  const nftSigners = [migration.firstPositionNftKeypair, migration.secondPositionNftKeypair].filter((kp) => isSigner(kp.publicKey))
  const signature = await send(ctx, 'migrate', ixs, nftSigners)
  const dammPool = deriveDammV2PoolAddress(dammConfig, m.market.baseMint, m.market.quoteMint)
  const info = await ctx.connection.getAccountInfo(dammPool, COMMITMENT)
  if (info === null || !info.owner.equals(DAMM_V2_PROGRAM_ID)) throw new Error(`DAMM v2 pool ${dammPool.toBase58()} missing after migration`)
  return { migrate: signature, dammConfig: dammConfig.toBase58(), dammPool: dammPool.toBase58() }
}

async function graduate(ctx: Ctx, m: LiveMarket): Promise<Graduation> {
  const finalize = await send(ctx, 'finalize', [finalizeInstruction({
    cluster: ctx.cluster, market: m.market.address, pool: m.market.pool, bufferVault: m.market.bufferVault,
  })], [])
  const claims = await claimAll(ctx, m)
  log.info('finalized and claimed', { market: m.market.address.toBase58(), claims: claims.length })
  const migration = await migrateToDammV2(ctx, m)
  log.info('migrated to DAMM v2', { market: m.market.address.toBase58(), dammPool: migration.dammPool })
  return { finalize, claims, ...migration }
}

async function seedMarket(ctx: Ctx, spec: MarketSpec, metadata: Metadata): Promise<MarketRecord> {
  const { live, launch } = await launchMarket(ctx, spec, metadata)
  const trades = await runPhases(ctx, spec, live)
  const graduation = spec.graduate ? await graduate(ctx, live) : null
  const { market } = live
  return {
    label: spec.label, name: spec.name, symbol: spec.symbol, uri: metadata.uri, image: metadata.image,
    market: market.address.toBase58(), pool: market.pool.toBase58(), config: market.config.toBase58(),
    baseMint: market.baseMint.toBase58(), quoteMint: market.quoteMint.toBase58(), bufferVault: market.bufferVault.toBase58(),
    launch, trades, graduation,
  }
}

/* ---------- final state and output ---------- */

interface MarketStatus {
  readonly status: 'live' | 'graduated' | 'migrated'
  readonly curveProgressBps: number
  readonly finalized: boolean
  readonly ownedByRouter: boolean
  readonly openPositions: number
}

async function readStatus(ctx: Ctx, record: MarketRecord): Promise<MarketStatus> {
  const address = new PublicKey(record.market)
  const [info, market, curve, positions] = await Promise.all([
    ctx.connection.getAccountInfo(address, COMMITMENT),
    fetchMarket(ctx.connection, address),
    readCurve(ctx, new PublicKey(record.pool)),
    marketPositions(ctx, address),
  ])
  const threshold = toBigint((await readConfig(ctx, new PublicKey(record.config))).migrationQuoteThreshold)
  const bps = progressBps(curve, threshold)
  const status = curve.isMigrated ? 'migrated' : bps >= FULL_PROGRESS_BPS ? 'graduated' : 'live'
  return {
    status, curveProgressBps: Number(bps), finalized: market?.finalized ?? false,
    ownedByRouter: info?.owner.equals(ctx.cluster.routerProgramId) ?? false, openPositions: positions.length,
  }
}

const EXPECTATIONS: Readonly<Record<MarketLabel, (s: MarketStatus) => boolean>> = {
  live: (s) => s.status === 'live' && s.openPositions > 0,
  hot: (s) => s.status === 'live' && s.curveProgressBps >= 7_000,
  graduated: (s) => s.status === 'migrated' && s.finalized && s.openPositions === 0,
}

function writeOutput(output: unknown): void {
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 1)}\n`)
}

function assertNotSeeded(): void {
  if (!existsSync(OUTPUT_PATH)) return
  const previous: unknown = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'))
  if (z.object({ complete: z.literal(true) }).safeParse(previous).success) {
    throw new Error(`${OUTPUT_PATH} already records a complete seed; delete it to seed again`)
  }
}

async function uploadAll(baseUrl: URL): Promise<Map<MarketLabel, Metadata>> {
  const entries: [MarketLabel, Metadata][] = []
  for (const spec of SPECS) entries.push([spec.label, await uploadMetadata(baseUrl, spec)])
  return new Map(entries)
}

async function seedAll(ctx: Ctx, metadata: ReadonlyMap<MarketLabel, Metadata>, save: (records: readonly MarketRecord[]) => void): Promise<MarketRecord[]> {
  const records: MarketRecord[] = []
  for (const spec of SPECS) {
    const meta = metadata.get(spec.label)
    if (meta === undefined) throw new Error(`no metadata for ${spec.label}`)
    records.push(await seedMarket(ctx, spec, meta))
    save(records)
  }
  return records
}

async function createContext(rpc: URL): Promise<Ctx> {
  const connection = new Connection(rpc.href, COMMITMENT)
  await assertDevnet(connection)
  const cluster = getClusterConfig('devnet')
  const quote = cluster.quoteMints.find((q) => q.symbol === 'SOL')
  if (quote === undefined) throw new Error('devnet has no SOL quote mint')
  const payer = loadCrankKeypair(process.env.PAYER_KEYPAIR?.trim() || DEFAULT_PAYER_KEYPAIR)
  return { connection, cluster, quote, payer, traders: loadOrCreateTraders(), dbc: createDbcProgram(connection, COMMITMENT).program }
}

async function main(): Promise<number> {
  const rpc = parseRpcUrl(process.env)
  registerRpcSecrets(rpc)
  scrubList = [rpc.href, rpc.origin, rpc.host, rpc.pathname, rpc.search].filter((p) => p.length >= MIN_SECRET_FRAGMENT)
  assertNotSeeded()
  const metadataBaseUrl = new URL(process.env.METADATA_BASE_URL?.trim() || DEFAULT_METADATA_BASE_URL)
  const ctx = await createContext(rpc)
  const before = await lamportsOf(ctx, ctx.payer.publicKey)
  log.info('payer balance before', { payer: ctx.payer.publicKey.toBase58(), sol: formatSol(before) })
  await guardPayer(ctx, ESTIMATED_SPEND_LAMPORTS)

  const base = {
    task: 'OPS-07', cluster: 'devnet', routerProgramId: ctx.cluster.routerProgramId.toBase58(),
    hookProgramId: ctx.cluster.hookProgramId.toBase58(), dbcProgramId: ctx.cluster.dbcProgramId.toBase58(),
    payer: ctx.payer.publicKey.toBase58(), metadataBaseUrl: metadataBaseUrl.origin,
    migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD.toString(), feeBps: FEE_BPS,
    traders: ctx.traders.map((t) => t.publicKey.toBase58()), payerSolBefore: formatSol(before),
  }
  const save = (records: readonly MarketRecord[]): void => writeOutput({ ...base, complete: false, markets: records })
  let records: MarketRecord[] = []
  let sweep: readonly SweepRow[] = []
  try {
    records = await seedAll(ctx, await uploadAll(metadataBaseUrl), save)
  } finally {
    sweep = await sweepTraders(ctx)
  }

  const statuses = await Promise.all(records.map((r) => readStatus(ctx, r)))
  const markets = records.map((r, i) => ({ ...r, ...statuses[i]! }))
  const failed = markets.filter((m, i) => !EXPECTATIONS[m.label](statuses[i]!) || !m.ownedByRouter).map((m) => m.label)
  const after = await lamportsOf(ctx, ctx.payer.publicKey)
  log.info('payer balance after', { sol: formatSol(after), spentSol: formatSol(before - after) })
  markets.forEach((m) => log.info('market', { label: m.label, status: m.status, progressBps: m.curveProgressBps, market: m.market, baseMint: m.baseMint }))
  writeOutput({
    ...base, complete: failed.length === 0, generatedAt: new Date().toISOString(),
    payerSolAfter: formatSol(after), spentSol: formatSol(before - after), markets, sweep,
  })
  if (failed.length > 0) log.error('markets not in the expected state', { failed })
  return failed.length === 0 && sweep.every((row) => row.error === undefined) ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    log.error('seed-devnet failed', { error: scrub(errorMessage(err)) })
    process.exitCode = 1
  },
)
