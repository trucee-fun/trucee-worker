/**
 * CRK-07: the worker entrypoint registers every crank job, in tick order, with the guards of its env config.
 */
import { Keypair, type Connection } from '@solana/web3.js'
import { getClusterConfig } from '@trucee/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CRANK_MIN_SOL_LAMPORTS, DEFAULT_MIN_ATA_VALUE_LAMPORTS, loadConfig, type WorkerConfig } from '../src/config.js'
import type { CrankContext, CrankJob } from '../src/crank/index.js'
import { createAutoExitJob } from '../src/crank/jobs/auto-exit.js'
import { createClaimsJob } from '../src/crank/jobs/claims.js'
import { finalizeJob } from '../src/crank/jobs/finalize.js'
import { createMigrateJob } from '../src/crank/jobs/migrate.js'
import type { Logger } from '../src/log.js'
import { buildJobs } from '../src/index.js'

vi.mock('../src/crank/jobs/claims.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/crank/jobs/claims.js')>()
  return { ...actual, createClaimsJob: vi.fn(actual.createClaimsJob) }
})
vi.mock('../src/crank/jobs/migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/crank/jobs/migrate.js')>()
  return { ...actual, createMigrateJob: vi.fn(actual.createMigrateJob) }
})
vi.mock('../src/crank/jobs/auto-exit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/crank/jobs/auto-exit.js')>()
  return { ...actual, createAutoExitJob: vi.fn(actual.createAutoExitJob) }
})

const ENV_MIN_ATA_VALUE_LAMPORTS = 123_456_789n
const ENV_CRANK_MIN_SOL_LAMPORTS = 987_654_321n
const JOB_ORDER = ['finalize', 'migrate', 'claims', 'auto-exit']
const GUARDED_JOBS = ['migrate', 'claims', 'auto-exit']

/** The worker config read from process.env, with both guards set to non-default values. */
function configFromEnv(): WorkerConfig {
  vi.stubEnv('CLUSTER', 'devnet')
  vi.stubEnv('RPC_URL', 'http://127.0.0.1:8899')
  vi.stubEnv('MIN_ATA_VALUE_LAMPORTS', ENV_MIN_ATA_VALUE_LAMPORTS.toString())
  vi.stubEnv('CRANK_MIN_SOL_LAMPORTS', ENV_CRANK_MIN_SOL_LAMPORTS.toString())
  return loadConfig(process.env)
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** A context whose payer holds `balance` lamports; any chain scan resolves empty and is recorded. */
function contextWithBalance(balance: bigint): { ctx: CrankContext; getProgramAccounts: ReturnType<typeof vi.fn>; log: Logger } {
  const getProgramAccounts = vi.fn(async () => [])
  const unexpected = vi.fn(async () => {
    throw new Error('not expected in this test')
  })
  const connection = {
    getBalance: vi.fn(async () => Number(balance)),
    getProgramAccounts,
    getMultipleAccountsInfo: unexpected,
    getAccountInfo: unexpected,
  } as unknown as Connection
  const log = fakeLogger()
  const ctx: CrankContext = { connection, payer: Keypair.generate(), cluster: getClusterConfig('devnet'), log, maxTx: 10 }
  return { ctx, getProgramAccounts, log }
}

function guarded(jobs: readonly CrankJob[]): CrankJob[] {
  return jobs.filter((job) => GUARDED_JOBS.includes(job.name))
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('buildJobs', () => {
  it('registers finalize, migrate, claims and auto-exit in that order', () => {
    const jobs = buildJobs(configFromEnv())

    expect(jobs.map((job) => job.name)).toEqual(JOB_ORDER)
    expect(jobs[0]).toBe(finalizeJob)
  })

  it('builds migrate, claims and auto-exit from the cfg-aware factories with MIN_ATA_VALUE_LAMPORTS and CRANK_MIN_SOL_LAMPORTS from the env', () => {
    const cfg = configFromEnv()
    expect(ENV_MIN_ATA_VALUE_LAMPORTS).not.toBe(DEFAULT_MIN_ATA_VALUE_LAMPORTS)
    expect(ENV_CRANK_MIN_SOL_LAMPORTS).not.toBe(DEFAULT_CRANK_MIN_SOL_LAMPORTS)
    const envGuards = expect.objectContaining({
      minAtaValueLamports: ENV_MIN_ATA_VALUE_LAMPORTS,
      crankMinSolLamports: ENV_CRANK_MIN_SOL_LAMPORTS,
    })

    buildJobs(cfg)

    expect(createMigrateJob).toHaveBeenCalledTimes(1)
    expect(createMigrateJob).toHaveBeenCalledWith({}, envGuards)
    expect(createClaimsJob).toHaveBeenCalledTimes(1)
    expect(createClaimsJob).toHaveBeenCalledWith(envGuards)
    expect(createAutoExitJob).toHaveBeenCalledTimes(1)
    expect(createAutoExitJob).toHaveBeenCalledWith(envGuards)
  })

  it('every guarded job plans nothing while the payer holds less than CRANK_MIN_SOL_LAMPORTS from the env', async () => {
    // Above the 0.05 SOL default floor, below the env floor: only the env value can stop the scans.
    const balance = ENV_CRANK_MIN_SOL_LAMPORTS - 1n
    expect(balance).toBeGreaterThan(DEFAULT_CRANK_MIN_SOL_LAMPORTS)

    for (const job of guarded(buildJobs(configFromEnv()))) {
      const { ctx, getProgramAccounts, log } = contextWithBalance(balance)

      const result = await job.run(ctx)

      expect(result, job.name).toEqual({ sent: [], skipped: 0, errors: [] })
      expect(getProgramAccounts, job.name).not.toHaveBeenCalled()
      expect(log.warn, job.name).toHaveBeenCalledWith(
        expect.stringContaining('CRANK_MIN_SOL_LAMPORTS'),
        expect.objectContaining({ minLamports: ENV_CRANK_MIN_SOL_LAMPORTS }),
      )
    }
  })

  it('every guarded job scans the chain once the payer holds CRANK_MIN_SOL_LAMPORTS from the env', async () => {
    for (const job of guarded(buildJobs(configFromEnv()))) {
      const { ctx, getProgramAccounts } = contextWithBalance(ENV_CRANK_MIN_SOL_LAMPORTS)

      await job.run(ctx)

      expect(getProgramAccounts, job.name).toHaveBeenCalled()
    }
  })
})
