/**
 * Worker entrypoint: validates config and the crank keypair, starts the crank loop, stops it on SIGINT/SIGTERM.
 * Jobs are registered by CRK-07; until then the loop ticks with no jobs.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadCrankKeypair } from './config.js'
import { startCrank, type CrankJob } from './crank/index.js'
import { errorMessage, log } from './log.js'

/** worker/.env, if present. Variables already set in the shell take precedence over the file. */
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url))
/** If something keeps the event loop alive after a clean stop, exit anyway after this long. */
const FORCE_EXIT_AFTER_MS = 5_000
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const JOBS: readonly CrankJob[] = []

function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}

function forceExitLater(code: number): void {
  setTimeout(() => process.exit(code), FORCE_EXIT_AFTER_MS).unref()
}

async function main(): Promise<void> {
  loadEnvFile()
  const cfg = loadConfig(process.env)
  // Loaded here first so a bad keypair fails fast with a clear message before anything starts.
  const payer = loadCrankKeypair(cfg.crankKeypairPath)
  log.info('worker starting', { cluster: cfg.cluster, rpc: cfg.rpcUrl, payer: payer.publicKey.toBase58() })

  const crank = await startCrank(cfg, [...JOBS])

  let stopping = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    log.info('worker stopping', { signal })
    crank.stop().then(
      () => {
        log.info('worker stopped', { signal })
        process.exitCode = 0
        forceExitLater(0)
      },
      (err: unknown) => {
        log.error('worker failed to stop cleanly', { error: errorMessage(err) })
        process.exitCode = 1
        forceExitLater(1)
      },
    )
  }
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, shutdown)
}

main().catch((err: unknown) => {
  log.error('worker failed to start', { error: errorMessage(err) })
  process.exitCode = 1
})
