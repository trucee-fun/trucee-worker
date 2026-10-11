/**
 * Worker entrypoint: validates config and the crank keypair, starts the crank loop with every job (CRK-07), stops it
 * on SIGINT/SIGTERM. Each tick runs finalize, migrate, claims and auto-exit in that order, so a graduated market can be
 * finalized, migrated and claimed in one tick (within MAX_TX_PER_TICK). Importing this module (tests) starts nothing.
 */
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadCrankKeypair, type WorkerConfig } from './config.js'
import { startCrank, type CrankHandle, type CrankJob } from './crank/index.js'
import { createAutoExitJob } from './crank/jobs/auto-exit.js'
import { createClaimsJob } from './crank/jobs/claims.js'
import { finalizeJob } from './crank/jobs/finalize.js'
import { createMigrateJob } from './crank/jobs/migrate.js'
import { errorMessage, log, registerSecret } from './log.js'

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

/**
 * The crank jobs in tick order, each spending within the guards of `cfg` (MIN_ATA_VALUE_LAMPORTS,
 * MAX_ATA_CREATES_PER_TICK, CRANK_MIN_SOL_LAMPORTS, MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS). finalize has no factory and
 * takes no guards: it creates no ATA and its only spend is the fee of each finalize, capped by MAX_TX_PER_TICK.
 */
export function buildJobs(cfg: WorkerConfig): CrankJob[] {
  return [finalizeJob, createMigrateJob({}, cfg), createClaimsJob(cfg), createAutoExitJob(cfg)]
}

function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}

/**
 * Registers the RPC URL, its host, path and query as log secrets. The host names the provider, and the logger reduces
 * any URL in an RPC error to its host, so the host is scrubbed too and never logged.
 */
function protectRpcUrl(rpcUrl: string): void {
  const url = new URL(rpcUrl)
  // registerSecret ignores values under 8 chars, so a bare "/" path or an empty query is skipped.
  for (const secret of [rpcUrl, url.href, url.host, url.hostname, url.pathname, url.search]) registerSecret(secret)
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
  // Loaded here first so a bad keypair fails fast with a clear message before anything starts.
  const payer = loadCrankKeypair(cfg.crankKeypairPath)
  log.info('worker starting', { cluster: cfg.cluster, payer: payer.publicKey.toBase58() })

  const crank = await startCrank(cfg, buildJobs(cfg))
  installShutdown(crank)
}

/** True when this file is the script node was started with (npm start), false when it is imported. */
function isEntrypoint(): boolean {
  const script = process.argv[1]
  if (script === undefined) return false
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  process.on('uncaughtException', exitOnFatal('uncaughtException'))
  process.on('unhandledRejection', exitOnFatal('unhandledRejection'))

  main().catch((err: unknown) => {
    log.error('worker failed to start', { error: errorMessage(err) })
    process.exitCode = EXIT_FAILURE
  })
}
