/**
 * Worker configuration from environment variables, and the crank keypair loader.
 * RPC_URL embeds a provider API key and the keypair is a signing secret: neither ever reaches an error or a log.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import type { QuoteMintInfo, QuoteSymbol } from '@trucee/sdk'
import { z } from 'zod'
import { registerSecret } from './log.js'

/** bs58 4 comes with @solana/web3.js (not a worker dependency of its own) and ships no types: only encode is used. */
const bs58 = createRequire(import.meta.url)('bs58') as { readonly encode: (bytes: Uint8Array) => string }

const CLUSTERS = ['devnet', 'mainnet-beta', 'localnet'] as const
export type WorkerCluster = (typeof CLUSTERS)[number]

/**
 * Spending guards of the crank jobs. The crank pays the rent (~0.002 SOL) of every owner quote ATA it creates,
 * and an owner can close that ATA and keep the rent, so ATA creation is capped by value and per tick.
 */
export interface CrankGuards {
  /**
   * wSOL quotes: a missing owner quote ATA is created only when the payout (auto-exit refund, surplus share) is at least
   * this many lamports. Smaller payouts are left to the owner. Other quote mints use quoteMinimums.
   */
  readonly minAtaValueLamports: bigint
  /** Owner quote ATAs each job (auto-exit, claims) may create per tick. */
  readonly maxAtaCreatesPerTick: number
  /** A job plans nothing while the crank payer holds fewer lamports than this. */
  readonly crankMinSolLamports: bigint
  /** The migrate job skips wSOL pools whose DBC migration quote threshold is below this many lamports. */
  readonly minMigrateThresholdSolLamports: bigint
}

/** The crank minimums of one quote mint, in its raw units (lamports for wSOL, raw base units for xStocks). */
export interface QuoteMinimums {
  /** Least payout (auto-exit refund, surplus share) for which the crank creates a missing owner quote ATA. */
  readonly ataValue: bigint
  /** Least DBC migration quote threshold of a pool the crank migrates. */
  readonly migrateThreshold: bigint
}

export interface WorkerConfig extends CrankGuards {
  cluster: WorkerCluster
  rpcUrl: string
  /**
   * What loadCrankKeypair reads the crank keypair from: a solana-keygen file path (~ expanded), or the 64-byte JSON array
   * itself when CRANK_KEYPAIR holds the keypair (ECS injects it from SSM). loadConfig registers the value, path or array,
   * with the log redaction.
   */
  crankKeypairPath: string
  crankIntervalMs: number
  maxTxPerTick: number
}

const DEFAULT_CRANK_KEYPAIR = '~/.config/solana/id.json'
const DEFAULT_CRANK_INTERVAL_MS = 15_000
const DEFAULT_MAX_TX_PER_TICK = 10
/**
 * 0.25 SOL. Farming the rent (~0.00204 SOL) of an ATA the crank creates costs an attacker about 2 x the ~1% router fee
 * x the payout (buy, then exit at cost), so it pays only below a ~0.1 SOL payout; 0.25 SOL keeps a margin above that.
 */
export const DEFAULT_MIN_ATA_VALUE_LAMPORTS = 250_000_000n
export const DEFAULT_MAX_ATA_CREATES_PER_TICK = 2
export const DEFAULT_CRANK_MIN_SOL_LAMPORTS = 50_000_000n
/** Mainnet-beta default of MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS (1 SOL); a migration costs the crank ~0.02 SOL. */
const MAINNET_MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS = 1_000_000_000n
/** Devnet and localnet migrate every wSOL pool, so small demo launches (0.303 SOL) still graduate. */
const TEST_CLUSTER_MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS = 0n
/** xStocks (8 decimals): an ATA for a payout of at least 0.1 share, a migration for a threshold of at least 1 share. */
const XSTOCK_MINIMUMS: QuoteMinimums = Object.freeze({ ataValue: 10_000_000n, migrateThreshold: 100_000_000n })
/** Floor on the tick interval so a typo cannot hammer the RPC provider. */
const MIN_CRANK_INTERVAL_MS = 100
/** solana-keygen files hold the 64-byte ed25519 secret key as a JSON array of numbers. */
const SECRET_KEY_BYTES = 64
/** The only error an inline CRANK_KEYPAIR ever produces: it must never echo the value. */
const INLINE_KEYPAIR_INVALID = 'is not a valid 64-byte keypair array'
/** The error for a CRANK_KEYPAIR that fails to load and does not look like a path (e.g. a key pasted in another form). */
const NOT_A_KEYPAIR = 'CRANK_KEYPAIR is neither a readable file path nor a 64-byte JSON array'
/** Longest CRANK_KEYPAIR an error may name as a path: a longer value is more likely a pasted key. */
const MAX_ECHOED_PATH_LENGTH = 256
/** A value naming a path starts with ~ or . or contains a separator (which covers a leading / or \). */
const PATH_PREFIXES = ['~', '.'] as const
const PATH_SEPARATOR = /[/\\]/

const ENV_KEYS = [
  'CLUSTER',
  'RPC_URL',
  'CRANK_KEYPAIR',
  'CRANK_INTERVAL_MS',
  'MAX_TX_PER_TICK',
  'MIN_ATA_VALUE_LAMPORTS',
  'MAX_ATA_CREATES_PER_TICK',
  'CRANK_MIN_SOL_LAMPORTS',
  'MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS',
] as const

const NON_NEGATIVE_INTEGER = 'must be a non-negative integer'
/** Plain decimal digits only: Number() would also read " " as 0, "0x10" as 16 and "1e3" as 1000. */
const DECIMAL_DIGITS = /^\d+$/

/** A non-negative safe integer written in decimal digits (surrounding whitespace trimmed); unset means the default. */
const nonNegativeInteger = () =>
  z
    .string({ error: NON_NEGATIVE_INTEGER })
    .trim()
    .regex(DECIMAL_DIGITS, NON_NEGATIVE_INTEGER)
    .transform(Number)
    .refine(Number.isSafeInteger, NON_NEGATIVE_INTEGER)
    .optional()

const secretKeySchema = z.array(z.number().int().min(0).max(255)).length(SECRET_KEY_BYTES)

/**
 * CRANK_KEYPAIR holds the keypair itself (a JSON array, as ECS injects it from SSM) rather than a file path. A relative
 * path starting with `[` is therefore read as an inline array and fails closed with the inline error; prefix it with ./
 */
function isInlineKeypair(value: string): boolean {
  return value.trimStart().startsWith('[')
}

/** The keypair in an inline CRANK_KEYPAIR, or undefined unless it is 64 integers 0..255 forming an ed25519 secret key. */
function parseInlineKeypair(value: string): Keypair | undefined {
  try {
    const secret = secretKeySchema.safeParse(JSON.parse(value))
    return secret.success ? Keypair.fromSecretKey(Uint8Array.from(secret.data)) : undefined
  } catch {
    // The JSON.parse message quotes the input, so no message is kept.
    return undefined
  }
}

/** Registers a loaded secret key with the log redaction as JSON.stringify and base58 (wallet exports) write it. */
function protectSecretKey(keypair: Keypair): Keypair {
  registerSecret(JSON.stringify(Array.from(keypair.secretKey)))
  registerSecret(bs58.encode(keypair.secretKey))
  return keypair
}

/**
 * Registers a CRANK_KEYPAIR value with the log redaction, as given and trimmed, before anything validates or reads it:
 * an inline array or a key pasted in another form is never logged, valid or not (a real path is redacted too). Returns
 * the keypair of a valid inline array, whose secret key forms are registered as well.
 */
function protectKeypairSource(value: string): Keypair | undefined {
  registerSecret(value)
  registerSecret(value.trim())
  const keypair = isInlineKeypair(value) ? parseInlineKeypair(value) : undefined
  return keypair === undefined ? undefined : protectSecretKey(keypair)
}

const envSchema = z.object({
  CLUSTER: z.enum(CLUSTERS, {
    error: (issue) => (issue.input === undefined ? 'is required' : `must be one of ${CLUSTERS.join(', ')}`),
  }),
  // Custom messages only: the value must never be echoed back.
  RPC_URL: z.url({
    protocol: /^https?$/,
    error: (issue) => (issue.input === undefined ? 'is required' : 'must be an http(s) URL'),
  }),
  // Blank means unset (the default file). An inline keypair array is validated here, and the message never echoes it.
  CRANK_KEYPAIR: z
    .string()
    .trim()
    .transform((value) => (value === '' ? DEFAULT_CRANK_KEYPAIR : value))
    .refine((value) => !isInlineKeypair(value) || parseInlineKeypair(value) !== undefined, INLINE_KEYPAIR_INVALID)
    .default(DEFAULT_CRANK_KEYPAIR),
  CRANK_INTERVAL_MS: z.coerce
    .number({ error: 'must be an integer number of milliseconds' })
    .int('must be an integer number of milliseconds')
    .min(MIN_CRANK_INTERVAL_MS, `must be at least ${MIN_CRANK_INTERVAL_MS}`)
    .default(DEFAULT_CRANK_INTERVAL_MS),
  MAX_TX_PER_TICK: z.coerce
    .number({ error: 'must be a positive integer' })
    .int('must be a positive integer')
    .positive('must be a positive integer')
    .default(DEFAULT_MAX_TX_PER_TICK),
  MIN_ATA_VALUE_LAMPORTS: nonNegativeInteger(),
  MAX_ATA_CREATES_PER_TICK: nonNegativeInteger(),
  CRANK_MIN_SOL_LAMPORTS: nonNegativeInteger(),
  MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS: nonNegativeInteger(),
})

/** The guards a job uses when it is created without explicit ones; only the migrate minimum depends on the cluster. */
export function defaultCrankGuards(cluster: WorkerCluster): CrankGuards {
  return Object.freeze({
    minAtaValueLamports: DEFAULT_MIN_ATA_VALUE_LAMPORTS,
    maxAtaCreatesPerTick: DEFAULT_MAX_ATA_CREATES_PER_TICK,
    crankMinSolLamports: DEFAULT_CRANK_MIN_SOL_LAMPORTS,
    minMigrateThresholdSolLamports:
      cluster === 'mainnet-beta' ? MAINNET_MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS : TEST_CLUSTER_MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS,
  })
}

/**
 * The crank minimums of each quote mint in `quoteMints` (the cluster's, from getClusterConfig), keyed by mint (base58).
 * The wSOL row comes from the guards (MIN_ATA_VALUE_LAMPORTS, MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS); xStocks have fixed
 * raw-unit minimums. A mint absent from the table is unknown: the crank creates no ATA and migrates no pool for it.
 */
export function quoteMinimums(guards: CrankGuards, quoteMints: readonly QuoteMintInfo[]): ReadonlyMap<string, QuoteMinimums> {
  const wsol: QuoteMinimums = Object.freeze({
    ataValue: guards.minAtaValueLamports,
    migrateThreshold: guards.minMigrateThresholdSolLamports,
  })
  const bySymbol: Readonly<Record<QuoteSymbol, QuoteMinimums>> = { SOL: wsol, TSLAx: XSTOCK_MINIMUMS, NVDAx: XSTOCK_MINIMUMS }
  return new Map(quoteMints.map((quote) => [quote.mint.toBase58(), bySymbol[quote.symbol]]))
}

const lamportsOr = (value: number | undefined, fallback: bigint): bigint => (value === undefined ? fallback : BigInt(value))

/** Expands a leading `~` to the user's home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Picks the worker's keys from the env; empty strings count as unset so `KEY=` in a .env file means "use the default". */
function pickEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, env[key] === '' ? undefined : env[key]]))
}

function scrub(text: string, secret: string | undefined): string {
  return secret === undefined || secret === '' ? text : text.split(secret).join('[redacted]')
}

/**
 * Validates the worker env. Throws an Error naming each bad variable, never including the RPC_URL value or an inline
 * CRANK_KEYPAIR. A CRANK_KEYPAIR value is registered with the log redaction first, valid or not.
 */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const picked = pickEnv(env)
  if (picked.CRANK_KEYPAIR !== undefined) protectKeypairSource(picked.CRANK_KEYPAIR)
  const parsed = envSchema.safeParse(picked)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')
    throw new Error(scrub(`Invalid worker config: ${problems}`, env.RPC_URL))
  }
  const data = parsed.data
  const defaults = defaultCrankGuards(data.CLUSTER)
  return Object.freeze({
    cluster: data.CLUSTER,
    rpcUrl: data.RPC_URL,
    crankKeypairPath: isInlineKeypair(data.CRANK_KEYPAIR) ? data.CRANK_KEYPAIR : expandHome(data.CRANK_KEYPAIR),
    crankIntervalMs: data.CRANK_INTERVAL_MS,
    maxTxPerTick: data.MAX_TX_PER_TICK,
    minAtaValueLamports: lamportsOr(data.MIN_ATA_VALUE_LAMPORTS, defaults.minAtaValueLamports),
    maxAtaCreatesPerTick: data.MAX_ATA_CREATES_PER_TICK ?? defaults.maxAtaCreatesPerTick,
    crankMinSolLamports: lamportsOr(data.CRANK_MIN_SOL_LAMPORTS, defaults.crankMinSolLamports),
    minMigrateThresholdSolLamports: lamportsOr(data.MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS, defaults.minMigrateThresholdSolLamports),
  })
}

function readKeypairFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'read error'
    throw new Error(`Cannot read crank keypair file ${path} (${code})`)
  }
}

function parseKeypairJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // The JSON.parse message quotes the input, so it is dropped on purpose.
    throw new Error(`Crank keypair file ${path} is not valid JSON`)
  }
}

/** An inline keypair array, registered with the log redaction. The error never echoes the value. */
function loadInlineKeypair(value: string): Keypair {
  const keypair = protectKeypairSource(value)
  if (keypair === undefined) throw new Error(`CRANK_KEYPAIR ${INLINE_KEYPAIR_INVALID}`)
  return keypair
}

/**
 * Whether an error may name `source`: only a value that looks like a path (starts with ~ / . or \, or contains a
 * separator) of at most 256 characters. A key pasted in another form (base58, a quoted array, {"secretKey":[...]},
 * hex) does not, so it is never echoed.
 */
function looksLikePath(source: string): boolean {
  if (source.length > MAX_ECHOED_PATH_LENGTH) return false
  return PATH_PREFIXES.some((prefix) => source.startsWith(prefix)) || PATH_SEPARATOR.test(source)
}

/** A solana-keygen JSON keypair file. Errors name the path only, never the file contents. */
function loadKeypairFile(resolved: string): Keypair {
  const json = parseKeypairJson(readKeypairFile(resolved), resolved)
  const secret = secretKeySchema.safeParse(json)
  if (!secret.success) {
    throw new Error(`Crank keypair file ${resolved} must be a JSON array of ${SECRET_KEY_BYTES} bytes`)
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(secret.data))
  } catch {
    throw new Error(`Crank keypair file ${resolved} does not hold a valid ed25519 secret key`)
  }
}

/**
 * Loads the crank keypair from `source`: the 64-byte JSON array itself when it starts with `[` (CRANK_KEYPAIR injected
 * from SSM), otherwise a solana-keygen JSON keypair file. A relative path starting with `[` is read as an array and
 * fails closed. The value is registered with the log redaction before it is read, and so is the loaded secret key.
 * Errors never include the array or the file contents, and name the path only when the value looks like one.
 */
export function loadCrankKeypair(source: string): Keypair {
  if (isInlineKeypair(source)) return loadInlineKeypair(source)
  protectKeypairSource(source)
  try {
    return protectSecretKey(loadKeypairFile(expandHome(source)))
  } catch (err) {
    if (looksLikePath(source)) throw err
    throw new Error(NOT_A_KEYPAIR)
  }
}
