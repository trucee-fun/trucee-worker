import { Keypair } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { runMigrateStep, type CurveState, type MigrateStepDeps } from '../scripts/seed-devnet.js'

/** DBC MigrationProgress values (worker/src/crank/jobs/migrate.ts). */
const PRE_BONDING_CURVE = 0
const LOCKED_VESTING = 2
const CREATED_POOL = 3
const QUOTE_RESERVE = 300_000_000n
const POOL = Keypair.generate().publicKey
const OWN_SIGNATURE = 'own-migrate-signature'
const OTHER_SIGNATURE = 'other-key-migrate-signature'
const MIGRATE_ERROR = 'migrate: DBC PoolIsIncompleted: Pool is not completed'

const curve = (migrationProgress: number, isMigrated: boolean): CurveState => ({ quoteReserve: QUOTE_RESERVE, migrationProgress, isMigrated })
const READY = curve(LOCKED_VESTING, false)
const MIGRATED_BY_OTHER_KEY = curve(CREATED_POOL, true)

interface LogLine {
  readonly level: string
  readonly msg: string
  readonly [key: string]: unknown
}

let stdout: string[] = []
let stdoutSpy: MockInstance<typeof process.stdout.write>

beforeEach(() => {
  stdout = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
})

afterEach(() => {
  stdoutSpy.mockRestore()
})

function logLines(): LogLine[] {
  return stdout.join('').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as LogLine)
}

/** Deps whose pool reads return `curves` in order (the last one repeats). */
function deps(curves: readonly CurveState[], overrides: Partial<MigrateStepDeps> = {}): MigrateStepDeps {
  let reads = 0
  return {
    readCurve: vi.fn(async () => curves[Math.min(reads++, curves.length - 1)]!),
    sendMigration: vi.fn(async () => OWN_SIGNATURE),
    findMigration: vi.fn(async () => OTHER_SIGNATURE),
    ...overrides,
  }
}

describe('seed-devnet migrate step', () => {
  it('treats a pool already migrated by another key as done: logs "already migrated" and continues without sending', async () => {
    const d = deps([MIGRATED_BY_OTHER_KEY])

    const result = await runMigrateStep(POOL, d)

    expect(result).toEqual({ migrate: OTHER_SIGNATURE, migratedByOtherKey: true })
    expect(d.sendMigration).not.toHaveBeenCalled()
    const line = logLines().find((l) => l.msg === 'already migrated')
    expect(line).toMatchObject({ level: 'info', pool: POOL.toBase58(), migrationProgress: CREATED_POOL, migrate: OTHER_SIGNATURE })
  })

  it('continues with no migrate signature when the lookup of the other key\'s transaction fails', async () => {
    const d = deps([MIGRATED_BY_OTHER_KEY], { findMigration: vi.fn(async () => Promise.reject(new Error('rpc down'))) })

    const result = await runMigrateStep(POOL, d)

    expect(result).toEqual({ migrate: null, migratedByOtherKey: true })
    expect(logLines().map((l) => l.msg)).toContain('already migrated')
    expect(logLines().find((l) => l.level === 'warn')?.error).toBe('rpc down')
  })

  it('migrates a ready pool itself and records its own signature', async () => {
    const d = deps([READY])

    const result = await runMigrateStep(POOL, d)

    expect(result).toEqual({ migrate: OWN_SIGNATURE, migratedByOtherKey: false })
    expect(d.sendMigration).toHaveBeenCalledTimes(1)
    expect(d.findMigration).not.toHaveBeenCalled()
    expect(logLines().map((l) => l.msg)).not.toContain('already migrated')
  })

  it('treats a send that lost the race to another key as done when the re-read pool is migrated', async () => {
    const d = deps([READY, MIGRATED_BY_OTHER_KEY], { sendMigration: vi.fn(async () => Promise.reject(new Error(MIGRATE_ERROR))) })

    const result = await runMigrateStep(POOL, d)

    expect(result).toEqual({ migrate: OTHER_SIGNATURE, migratedByOtherKey: true })
    expect(logLines().map((l) => l.msg)).toContain('already migrated')
  })

  it('still fails on a real migrate error while the pool stays unmigrated', async () => {
    const d = deps([READY, READY], { sendMigration: vi.fn(async () => Promise.reject(new Error(MIGRATE_ERROR))) })

    await expect(runMigrateStep(POOL, d)).rejects.toThrow(MIGRATE_ERROR)

    expect(d.readCurve).toHaveBeenCalledTimes(2)
    expect(logLines().map((l) => l.msg)).not.toContain('already migrated')
  })

  it('still fails with the migrate error when the re-read after it fails too', async () => {
    let reads = 0
    const readCurve = vi.fn(async () => (reads++ === 0 ? READY : Promise.reject(new Error('rpc down'))))
    const d = deps([READY], { readCurve, sendMigration: vi.fn(async () => Promise.reject(new Error(MIGRATE_ERROR))) })

    await expect(runMigrateStep(POOL, d)).rejects.toThrow(MIGRATE_ERROR)
  })

  it('still fails when the curve is not complete, without sending', async () => {
    const d = deps([curve(PRE_BONDING_CURVE, false)])

    await expect(runMigrateStep(POOL, d)).rejects.toThrow('pool is not ready to migrate (migrationProgress 0, isMigrated false)')
    expect(d.sendMigration).not.toHaveBeenCalled()
  })
})

describe('seed-devnet module', () => {
  const exitCodeBefore = process.exitCode

  afterEach(() => {
    process.exitCode = exitCodeBefore
    vi.unstubAllEnvs()
  })

  it('does not start a seed run when imported', async () => {
    // Without an RPC URL a started run fails at once (logs "seed-devnet failed", exit code 1) and never reaches the network.
    vi.stubEnv('RPC_URL', '')
    vi.stubEnv('DEVNET_RPC', '')
    vi.resetModules()

    await import('../scripts/seed-devnet.js')
    await new Promise((resolve) => setImmediate(resolve))

    expect(logLines()).toEqual([])
    expect(process.exitCode).toBe(exitCodeBefore)
  })
})
