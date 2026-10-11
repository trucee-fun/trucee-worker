/**
 * Worker entrypoint: validates config and the crank keypair, starts the crank loop with every job (CRK-07), stops it
 * on SIGINT/SIGTERM. Each tick runs finalize, migrate, claims and auto-exit in that order, so a graduated market can be
 * finalized, migrated and claimed in one tick (within MAX_TX_PER_TICK). Library output on stderr is scrubbed of the RPC
 * URL like a log line (CRK-13). Importing this module (tests) starts nothing unless CRANK_FORCE_START=1.
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
import { errorMessage, log, redactUrls, registerSecret } from './log.js'

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
/** What a scrubbed RPC URL part becomes, as in log.ts. */
const REDACTED = '[redacted]'

type WriteCallback = (err?: Error | null) => void

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

/** `text` with every URL reduced to its host, then every part of the RPC URL (its host among them) replaced. */
function scrubText(text: string, secrets: readonly string[]): string {
  return secrets.reduce((scrubbed, secret) => scrubbed.split(secret).join(REDACTED), redactUrls(text))
}

/**
 * Scrubs every stderr line of the RPC URL, as the logger scrubs a log line: process.stderr.write, console.error and
 * console.warn (which @solana/web3.js uses for connection and retry errors, and which can quote the URL with its key).
 * Every URL is reduced to its host, then the RPC URL's host, key and other parts become [redacted]. A Buffer chunk is
 * decoded as UTF-8. A URL split across two writes is not matched; console writes each line whole. Install it once at
 * startup; the returned function puts the original writers back.
 */
export function scrubStderr(rpcUrl: string): () => void {
  const secrets = rpcUrlSecrets(rpcUrl)
  const scrub = (text: string): string => scrubText(text, secrets)
  const stderr = process.stderr
  const original = { write: stderr.write, error: console.error, warn: console.warn }

  function write(chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
    const isText = typeof chunk === 'string'
    const encoding = isText && typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8'
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    const text = isText ? chunk : Buffer.from(chunk).toString('utf8')
    return original.write.call(stderr, scrub(text), encoding, done)
  }

  stderr.write = write as typeof stderr.write
  console.error = (...data: unknown[]) => original.error.call(console, scrub(format(...data)))
  console.warn = (...data: unknown[]) => original.warn.call(console, scrub(format(...data)))
  return () => {
    stderr.write = original.write
    console.error = original.error
    console.warn = original.warn
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
  loadEnvFile()
  const cfg = loadConfig(process.env)
  protectRpcUrl(cfg.rpcUrl)
  scrubStderr(cfg.rpcUrl)
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
