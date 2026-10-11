/**
 * Worker entrypoint: validates config and the crank keypair, starts the crank loop, stops it on SIGINT/SIGTERM.
 * Jobs are registered by CRK-07; until then the loop ticks with no jobs.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadCrankKeypair } from './config.js'
import { startCrank, type CrankHandle, type CrankJob } from './crank/index.js'
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

const JOBS: readonly CrankJob[] = []

function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}

/** Registers the RPC URL and its path and query as log secrets; returns the host, the only part safe to log. */
function protectRpcUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl)
  // registerSecret ignores values under 8 chars, so a bare "/" path or an empty query is skipped.
  for (const secret of [rpcUrl, url.href, url.pathname, url.search]) registerSecret(secret)
  return url.host
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
  const rpcHost = protectRpcUrl(cfg.rpcUrl)
  // Loaded here first so a bad keypair fails fast with a clear message before anything starts.
  const payer = loadCrankKeypair(cfg.crankKeypairPath)
  log.info('worker starting', { cluster: cfg.cluster, rpcHost, payer: payer.publicKey.toBase58() })

  const crank = await startCrank(cfg, [...JOBS])
  installShutdown(crank)
}

process.on('uncaughtException', exitOnFatal('uncaughtException'))
process.on('unhandledRejection', exitOnFatal('unhandledRejection'))

main().catch((err: unknown) => {
  log.error('worker failed to start', { error: errorMessage(err) })
  process.exitCode = EXIT_FAILURE
})
