/**
 * Worker entrypoint: validates config and the crank keypair, starts the crank loop with every job (CRK-07), stops it
 * on SIGINT/SIGTERM. Each tick runs finalize, migrate, claims and auto-exit in that order, so a graduated market can be
 * finalized, migrated and claimed in one tick (within MAX_TX_PER_TICK). Everything printed on stdout, stderr or the
 * console is scrubbed of the RPC URL and the crank keypair like a log line, from before the config loads (CRK-13,
 * CRK-14). Importing this module (tests) starts nothing unless CRANK_FORCE_START=1.
 */
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import { loadConfig, loadCrankKeypair, type WorkerConfig } from './config.js'
import { startCrank, type CrankHandle, type CrankJob } from './crank/index.js'
import { createAutoExitJob } from './crank/jobs/auto-exit.js'
import { createClaimsJob } from './crank/jobs/claims.js'
import { createFinalizeJob } from './crank/jobs/finalize.js'
import { createMigrateJob } from './crank/jobs/migrate.js'
import { errorMessage, log, redactUrls, registerSecret, scrubSecrets } from './log.js'

/** worker/.env, if present. Variables already set in the shell take precedence over the file. */
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url))
/** Upper bound on a graceful stop: a hung job cannot hold the process open longer than this after a signal. */
const FORCE_EXIT_AFTER_MS = 5_000
/**
 * npx/npm and tsx relay a signal the worker already got from its process group about 30 ms later.
 * A repeat inside this window is that echo; a later repeat is a deliberate second request and exits at once.
 */
const SIGNAL_ECHO_WINDOW_MS = 1_000
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const
const EXIT_OK = 0
const EXIT_FAILURE = 1
/** Set to "1" to start the worker when this module is not node's start script (e.g. loaded by another runner). */
const FORCE_START_ENV = 'CRANK_FORCE_START'
/** Shorter RPC URL parts are never scrubbed ("/", "v2", an empty query), as in log.ts registerSecret. */
const MIN_SECRET_LENGTH = 8
/** The console methods installOutputScrub wraps; any other console output still reaches a scrubbed stream. */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const
/** String encodings that spell bytes rather than text: the scrub reads the bytes such a string writes. */
const BYTE_ENCODINGS: ReadonlySet<string> = new Set(['hex', 'base64', 'base64url'])

type WriteCallback = (err?: Error | null) => void
type StreamWrite = (
  chunk: unknown,
  encodingOrCallback?: BufferEncoding | WriteCallback,
  callback?: WriteCallback,
) => boolean

/**
 * The crank jobs in tick order, each spending within the guards of `cfg` (MIN_ATA_VALUE_LAMPORTS,
 * MAX_ATA_CREATES_PER_TICK, CRANK_MIN_SOL_LAMPORTS, MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS). Every job stops at the
 * CRANK_MIN_SOL_LAMPORTS payer floor; finalize creates no ATA and uses no other guard.
 */
export function buildJobs(cfg: WorkerConfig): CrankJob[] {
  return [createFinalizeJob(cfg), createMigrateJob({}, cfg), createClaimsJob(cfg), createAutoExitJob(cfg)]
}

function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}

/**
 * The RPC URL and every part of it that could name the provider or carry its API key: origin, host, path and query,
 * each path segment and each query value. Parts under 8 characters are left out. Longest first, so a whole part is
 * replaced before any fragment of it.
 */
function rpcUrlSecrets(rpcUrl: string): string[] {
  const url = new URL(rpcUrl)
  const parts = [rpcUrl, url.href, url.origin, url.host, url.hostname, url.pathname, url.search]
  const all = [...parts, ...url.pathname.split('/'), ...url.searchParams.values()]
  return [...new Set(all)].filter((part) => part.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)
}

/**
 * Registers the RPC URL and every part of it that could name the provider or carry its API key as log secrets. An RPC
 * error can quote the bare key without the URL around it, and the logger reduces any URL in an error to its host, so the
 * host is scrubbed too and never logged.
 */
export function protectRpcUrl(rpcUrl: string): void {
  for (const secret of rpcUrlSecrets(rpcUrl)) registerSecret(secret)
}

/**
 * Registers RPC_URL from `env`, when set, as protectRpcUrl does. A value that is not a URL is registered whole: the
 * config error that rejects it later must not be what keeps it out of the output.
 */
function protectEnvRpcUrl(env: NodeJS.ProcessEnv): void {
  const rpcUrl = env.RPC_URL
  if (rpcUrl === undefined || rpcUrl === '') return
  try {
    protectRpcUrl(rpcUrl)
  } catch {
    registerSecret(rpcUrl)
  }
}

/** What any output prints of `text`: as in a log line, every URL reduced to its host, then every secret replaced. */
function scrubOutput(text: string): string {
  return scrubSecrets(redactUrls(text))
}

function isByteEncoding(encoding: string | undefined): encoding is BufferEncoding {
  return encoding !== undefined && BYTE_ENCODINGS.has(encoding)
}

/**
 * The text a stream write prints: a string chunk as is, a byte chunk decoded as UTF-8, a string in a byte encoding
 * (hex, base64) as the bytes it spells, decoded as UTF-8. Undefined for anything else, which the stream itself rejects.
 */
function writtenText(chunk: unknown, encoding: string | undefined): string | undefined {
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8')
  if (typeof chunk !== 'string') return undefined
  return isByteEncoding(encoding) ? Buffer.from(chunk, encoding).toString('utf8') : chunk
}

/**
 * `stream.write` through scrubOutput. A chunk with nothing to scrub reaches the stream exactly as given. A scrubbed
 * chunk is written as text: a string chunk in its own text encoding, anything else as UTF-8. The callback and the
 * return value are the stream's own.
 */
function scrubbedWrite(stream: NodeJS.WriteStream, original: StreamWrite): StreamWrite {
  return (...args) => {
    const [chunk, encodingOrCallback, callback] = args
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
    const text = writtenText(chunk, encoding)
    const scrubbed = text === undefined ? text : scrubOutput(text)
    if (scrubbed === text) return original.apply(stream, args)
    const isTextChunk = typeof chunk === 'string' && !isByteEncoding(encoding)
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    return original.call(stream, scrubbed, isTextChunk ? (encoding ?? 'utf8') : 'utf8', done)
  }
}

/**
 * Scrubs everything the worker prints, as the logger scrubs a log line: process.stdout.write, process.stderr.write and
 * console.log/info/warn/error/debug (@solana/web3.js reports connection and retry errors on the console, quoting the
 * URL with its key). Every URL is reduced to its host, then every registered secret (the RPC URL's parts, the crank
 * keypair forms of config.ts) becomes [redacted]. RPC_URL from the process env is registered here, so a library
 * printing during config load is scrubbed too. A secret split across two writes is not matched; the console writes each
 * line whole. Log lines pass the scrub twice, which changes nothing more. Install it first thing at startup; the
 * returned function puts the original writers back.
 */
export function installOutputScrub(): () => void {
  protectEnvRpcUrl(process.env)
  const streams = [process.stdout, process.stderr].map((stream) => ({ stream, write: stream.write }))
  const consoles = CONSOLE_METHODS.map((method) => ({ method, fn: console[method] }))

  for (const { stream, write } of streams) {
    stream.write = scrubbedWrite(stream, write as StreamWrite) as typeof stream.write
  }
  for (const { method, fn } of consoles) {
    console[method] = (...data: unknown[]) => fn.call(console, scrubOutput(format(...data)))
  }
  return () => {
    for (const { stream, write } of streams) stream.write = write
    for (const { method, fn } of consoles) console[method] = fn
  }
}

function exitOnFatal(kind: 'uncaughtException' | 'unhandledRejection'): (err: unknown) => void {
  return (err) => {
    log.error('worker crashed', { kind, error: errorMessage(err) })
    process.exit(EXIT_FAILURE)
  }
}

function installShutdown(crank: CrankHandle): void {
  let firstSignalAt: number | undefined
  let stoppedCleanly = false

  const beginShutdown = (signal: NodeJS.Signals): void => {
    log.info('worker stopping', { signal })
    // Armed before awaiting stop() so a hung job cannot block the exit; unref'd so a clean stop exits at once.
    setTimeout(() => {
      const msg = stoppedCleanly ? 'event loop still busy after stop; forcing exit' : 'crank did not stop in time; forcing exit'
      log.error(msg, { afterMs: FORCE_EXIT_AFTER_MS })
      process.exit(stoppedCleanly ? EXIT_OK : EXIT_FAILURE)
    }, FORCE_EXIT_AFTER_MS).unref()
    crank.stop().then(
      () => {
        stoppedCleanly = true
        process.exitCode = EXIT_OK
        log.info('worker stopped', { signal })
      },
      (err: unknown) => {
        process.exitCode = EXIT_FAILURE
        log.error('worker failed to stop cleanly', { error: errorMessage(err) })
      },
    )
  }

  const onSignal = (signal: NodeJS.Signals): void => {
    const now = Date.now()
    if (firstSignalAt === undefined) {
      firstSignalAt = now
      beginShutdown(signal)
      return
    }
    if (now - firstSignalAt < SIGNAL_ECHO_WINDOW_MS) return
    log.warn('second shutdown signal; exiting now', { signal })
    process.exit(EXIT_FAILURE)
  }

  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal)
}

async function main(): Promise<void> {
  installOutputScrub()
  loadEnvFile()
  // An RPC_URL set only in worker/.env: registered before anything (loadConfig among them) can print it.
  protectEnvRpcUrl(process.env)
  const cfg = loadConfig(process.env)
  protectRpcUrl(cfg.rpcUrl)
  // Loaded here first so a bad keypair fails fast with a clear message before anything starts.
  const payer = loadCrankKeypair(cfg.crankKeypairPath)
  log.info('worker starting', { cluster: cfg.cluster, payer: payer.publicKey.toBase58() })

  const crank = await startCrank(cfg, buildJobs(cfg))
  installShutdown(crank)
}

/** How this module was loaded: as node's start script, imported (tests, `node -e`), or from an unresolvable script. */
type LoadedAs = 'entrypoint' | 'imported' | 'unresolved'

function loadedAs(script: string | undefined, self: string): LoadedAs {
  if (script === undefined) return 'imported'
  try {
    return realpathSync(script) === realpathSync(self) ? 'entrypoint' : 'imported'
  } catch {
    return 'unresolved'
  }
}

/**
 * Whether the worker starts: when this file is node's start script (npm start, the Docker CMD), or when
 * CRANK_FORCE_START=1 is set in the process env (read before worker/.env is loaded). A start script whose path cannot
 * be resolved logs one warning (no path: it may sit under a secret directory) instead of passing as a silent no-op.
 *
 * @param script process.argv[1], the script node was started with
 * @param self this module's file path
 */
export function shouldStartWorker(script: string | undefined, env: NodeJS.ProcessEnv, self: string): boolean {
  const as = loadedAs(script, self)
  const forced = env[FORCE_START_ENV] === '1'
  if (as === 'unresolved') {
    log.warn(`cannot resolve the start script; the worker starts only with ${FORCE_START_ENV}=1`, { forced })
  }
  return as === 'entrypoint' || forced
}

if (shouldStartWorker(process.argv[1], process.env, fileURLToPath(import.meta.url))) {
  process.on('uncaughtException', exitOnFatal('uncaughtException'))
  process.on('unhandledRejection', exitOnFatal('unhandledRejection'))

  main().catch((err: unknown) => {
    log.error('worker failed to start', { error: errorMessage(err) })
    process.exitCode = EXIT_FAILURE
  })
}
