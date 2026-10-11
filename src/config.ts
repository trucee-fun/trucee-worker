/**
 * Worker configuration from environment variables, and the crank keypair loader.
 * RPC_URL embeds a provider API key and the keypair is a signing secret: neither ever reaches an error or a log.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { z } from 'zod'

export interface WorkerConfig {
  cluster: 'devnet' | 'mainnet-beta' | 'localnet'
  rpcUrl: string
  crankKeypairPath: string
  crankIntervalMs: number
  maxTxPerTick: number
}

const CLUSTERS = ['devnet', 'mainnet-beta', 'localnet'] as const
const DEFAULT_CRANK_KEYPAIR = '~/.config/solana/id.json'
const DEFAULT_CRANK_INTERVAL_MS = 15_000
const DEFAULT_MAX_TX_PER_TICK = 10
/** Floor on the tick interval so a typo cannot hammer the RPC provider. */
const MIN_CRANK_INTERVAL_MS = 100
/** solana-keygen files hold the 64-byte ed25519 secret key as a JSON array of numbers. */
const SECRET_KEY_BYTES = 64

const ENV_KEYS = ['CLUSTER', 'RPC_URL', 'CRANK_KEYPAIR', 'CRANK_INTERVAL_MS', 'MAX_TX_PER_TICK'] as const

const envSchema = z.object({
  CLUSTER: z.enum(CLUSTERS, {
    error: (issue) => (issue.input === undefined ? 'is required' : `must be one of ${CLUSTERS.join(', ')}`),
  }),
  // Custom messages only: the value must never be echoed back.
  RPC_URL: z.url({
    protocol: /^https?$/,
    error: (issue) => (issue.input === undefined ? 'is required' : 'must be an http(s) URL'),
  }),
  CRANK_KEYPAIR: z.string().default(DEFAULT_CRANK_KEYPAIR),
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
})

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

/** Validates the worker env. Throws an Error naming each bad variable, never including the RPC_URL value. */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = envSchema.safeParse(pickEnv(env))
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')
    throw new Error(scrub(`Invalid worker config: ${problems}`, env.RPC_URL))
  }
  const data = parsed.data
  return Object.freeze({
    cluster: data.CLUSTER,
    rpcUrl: data.RPC_URL,
    crankKeypairPath: expandHome(data.CRANK_KEYPAIR),
    crankIntervalMs: data.CRANK_INTERVAL_MS,
    maxTxPerTick: data.MAX_TX_PER_TICK,
  })
}

const secretKeySchema = z.array(z.number().int().min(0).max(255)).length(SECRET_KEY_BYTES)

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

/** Reads a solana-keygen JSON keypair file. Errors name the path only, never the file contents. */
export function loadCrankKeypair(path: string): Keypair {
  const resolved = expandHome(path)
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
