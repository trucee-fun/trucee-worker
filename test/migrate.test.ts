import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type AccountInfo,
  type RpcResponseAndContext,
  type SimulatedTransactionResponse,
} from '@solana/web3.js'
import {
  createDbcProgram,
  deriveDammV2PoolAddress,
  type ConfigWithTransferHook,
  type MigrateToDammV2Response,
  type TransferHookPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT } from '@solana/spl-token'
import { getClusterConfig } from '@trucee/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCrankGuards } from '../src/config.js'
import type { CrankContext } from '../src/crank/index.js'
import {
  CONFIRM_TIMEOUT_MS,
  MAX_ATTEMPTS_PER_TX,
  MIGRATION_PROGRESS,
  RPC_TIMEOUT_MS,
  createMigrateJob,
  dammConfigFor,
  migrateJob,
  needsMigration,
  planMigrations,
  type ConfigSnapshot,
  type LoadResult,
  type MarketRef,
  type MigrateJobDeps,
  type MigrationTarget,
  type PoolSnapshot,
} from '../src/crank/jobs/migrate.js'
import type { LogContext, Logger, LogLevel } from '../src/log.js'

const LOCAL_RPC_URL = 'http://127.0.0.1:8899'
const CLUSTER = getClusterConfig('localnet')
/** DAMM_V2_MIGRATION_FEE_ADDRESS[0] (FixedBps25) and [6] (Customizable), from the DBC SDK. */
const DAMM_CONFIG_FEE_OPTION_0 = '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd'
const DAMM_CONFIG_FEE_OPTION_6 = 'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck'
/** migration_progress is the byte at offset 308 of a DBC pool account. */
const MIGRATION_PROGRESS_OFFSET = 308
/** ConfigWithTransferHook (DBC SDK 1.5.13 IDL): config.quote_mint and config.migration_fee_option byte offsets. */
const CONFIG_QUOTE_MINT_OFFSET = 8
const CONFIG_MIGRATION_FEE_OPTION_OFFSET = 243
const SIGNATURE = 'migration-signature'
/** sha256("account:Market")[..8], and the Market layout of @trucee/sdk. */
const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154]
const MARKET_ACCOUNT_SIZE = 274
const MARKET_POOL_OFFSET = 8
const MARKET_CONFIG_OFFSET = 40
const FUNDED_LAMPORTS = 10_000_000_000
/** The devnet demo launch's migration quote threshold (0.303 SOL). */
const DEMO_THRESHOLD_LAMPORTS = 303_000_000n
const TSLAX_MINT = CLUSTER.quoteMints.find((quote) => quote.symbol === 'TSLAx')!.mint

const { LOCKED_VESTING, CREATED_POOL, PRE_BONDING_CURVE, POST_BONDING_CURVE } = MIGRATION_PROGRESS

interface LogLine {
  readonly level: LogLevel
  readonly msg: string
  readonly ctx: LogContext
}

function recordingLogger(): { readonly logger: Logger; readonly lines: LogLine[] } {
  const lines: LogLine[] = []
  const at =
    (level: LogLevel) =>
    (msg: string, ctx: LogContext = {}): void => {
      lines.push({ level, msg, ctx })
    }
  return { logger: { info: at('info'), warn: at('warn'), error: at('error') }, lines }
}

const payer = Keypair.generate()

function testContext(overrides: { connection?: Connection; maxTx?: number; logger?: Logger } = {}): CrankContext {
  return {
    connection: overrides.connection ?? new Connection(LOCAL_RPC_URL),
    payer,
    cluster: CLUSTER,
    log: overrides.logger ?? recordingLogger().logger,
    maxTx: overrides.maxTx ?? 10,
  }
}

const newKey = (): PublicKey => Keypair.generate().publicKey

function poolSnapshot(migrationProgress: number, isMigrated: boolean, config: PublicKey = newKey()): PoolSnapshot {
  return { pool: newKey(), config, baseMint: newKey(), state: { migrationProgress, isMigrated } }
}

const ok = <T>(value: T): LoadResult<T> => ({ ok: true, value })
const failed = <T>(error: string): LoadResult<T> => ({ ok: false, error })

function configSnapshot(migrationFeeOption: number, overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return { quoteMint: NATIVE_MINT, migrationFeeOption, migrationQuoteThreshold: 0n, ...overrides }
}

/** A migrate_damm_v2 stand-in whose instruction needs the payer and both position-NFT mints as signers. */
function fakeMigration(payerKey: PublicKey, dataBytes = 8): MigrateToDammV2Response {
  const firstPositionNftKeypair = Keypair.generate()
  const secondPositionNftKeypair = Keypair.generate()
  const ix = new TransactionInstruction({
    programId: CLUSTER.dbcProgramId,
    keys: [
      { pubkey: firstPositionNftKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: secondPositionNftKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: payerKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.alloc(dataBytes),
  })
  return { transaction: new Transaction().add(ix), firstPositionNftKeypair, secondPositionNftKeypair }
}

interface StubOptions {
  readonly configs?: ReadonlyMap<string, ConfigSnapshot>
  readonly overrides?: Partial<MigrateJobDeps>
}

function stubDeps(pools: readonly PoolSnapshot[], options: StubOptions = {}): MigrateJobDeps {
  const byPool = new Map(pools.map((pool) => [pool.pool.toBase58(), pool]))
  const configs = options.configs ?? new Map<string, ConfigSnapshot>()
  return {
    listMarkets: async () => pools.map((pool) => ({ pool: pool.pool, config: pool.config })),
    fetchPools: async (_ctx, addresses) =>
      addresses.map((address) => {
        const pool = byPool.get(address.toBase58())
        return pool === undefined ? failed<PoolSnapshot>('pool account not found') : ok(pool)
      }),
    fetchConfigs: async (_ctx, addresses) =>
      addresses.map((address) => {
        const config = configs.get(address.toBase58())
        return config === undefined ? failed<ConfigSnapshot>('config account not found') : ok(config)
      }),
    buildMigration: async (ctx) => fakeMigration(ctx.payer.publicKey),
    ...options.overrides,
  }
}

function simulation(err: SimulatedTransactionResponse['err'], logs: string[] = []): RpcResponseAndContext<SimulatedTransactionResponse> {
  return { context: { slot: 1 }, value: { err, logs } }
}

/** Mocks every RPC call of the send path; nothing reaches the network. */
function mockSendPath(connection: Connection, simulationErr: SimulatedTransactionResponse['err'] = null) {
  return {
    blockhash: vi
      .spyOn(connection, 'getLatestBlockhash')
      .mockResolvedValue({ blockhash: newKey().toBase58(), lastValidBlockHeight: 100 }),
    simulate: vi.spyOn(connection, 'simulateTransaction').mockResolvedValue(simulation(simulationErr, ['Program log: boom'])),
    send: vi.spyOn(connection, 'sendRawTransaction').mockResolvedValue(SIGNATURE),
    confirm: vi.spyOn(connection, 'confirmTransaction').mockResolvedValue({ context: { slot: 2 }, value: { err: null } }),
  }
}

function errorLines(lines: readonly LogLine[]): LogLine[] {
  return lines.filter((line) => line.level === 'error')
}

/** A promise that never settles: a hung RPC call. */
const hang = <T>(): Promise<T> => new Promise<T>(() => undefined)

/**
 * Runs `run` under fake timers: waits until `stalled` has been called (the hung call), then advances the clock by
 * `ms` so the job's timeout fires, and returns the job's result.
 */
async function runPastTimeout<T>(run: () => Promise<T>, stalled: { mock: { calls: unknown[] } }, ms: number): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = run()
    await vi.waitFor(() => expect(stalled.mock.calls.length).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(ms)
    return await pending
  } finally {
    vi.useRealTimers()
  }
}

beforeEach(() => {
  vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(FUNDED_LAMPORTS)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('needsMigration', () => {
  it.each([
    { name: 'curve still running', migrationProgress: PRE_BONDING_CURVE, isMigrated: false, expected: false },
    { name: 'waiting for a locker (no locked vesting in Trucee)', migrationProgress: POST_BONDING_CURVE, isMigrated: false, expected: false },
    { name: 'complete and not migrated', migrationProgress: LOCKED_VESTING, isMigrated: false, expected: true },
    { name: 'complete and flagged is_migrated', migrationProgress: LOCKED_VESTING, isMigrated: true, expected: false },
    { name: 'migrated (CreatedPool) and flagged', migrationProgress: CREATED_POOL, isMigrated: true, expected: false },
    { name: 'migrated (CreatedPool) without the flag', migrationProgress: CREATED_POOL, isMigrated: false, expected: false },
  ])('$name → $expected', ({ migrationProgress, isMigrated, expected }) => {
    expect(needsMigration({ migrationProgress, isMigrated })).toBe(expected)
  })
})

describe('dammConfigFor', () => {
  it('indexes DAMM_V2_MIGRATION_FEE_ADDRESS by the migration fee option', () => {
    expect(dammConfigFor(0)?.toBase58()).toBe(DAMM_CONFIG_FEE_OPTION_0)
    expect(dammConfigFor(6)?.toBase58()).toBe(DAMM_CONFIG_FEE_OPTION_6)
  })

  it('returns null for an option without a DAMM v2 config', () => {
    expect(dammConfigFor(7)).toBeNull()
    expect(dammConfigFor(-1)).toBeNull()
    expect(dammConfigFor(1.5)).toBeNull()
  })
})

describe('planMigrations', () => {
  it("chooses each pool's DAMM v2 config from its own DBC config's fee option", () => {
    const configA = newKey()
    const configB = newKey()
    const poolA = poolSnapshot(LOCKED_VESTING, false, configA)
    const poolB = poolSnapshot(LOCKED_VESTING, false, configB)
    const snapshotA = configSnapshot(0)
    const snapshotB = configSnapshot(6)
    const configs = new Map([
      [configA.toBase58(), ok(snapshotA)],
      [configB.toBase58(), ok(snapshotB)],
    ])

    const plan = planMigrations({ pools: [poolA, poolB], configs })

    expect(plan.errors).toEqual([])
    expect(plan.targets.map((t) => t.dammConfig.toBase58())).toEqual([DAMM_CONFIG_FEE_OPTION_0, DAMM_CONFIG_FEE_OPTION_6])
    const [targetA, targetB] = plan.targets
    expect(targetA?.pool.equals(poolA.pool)).toBe(true)
    expect(targetA?.quoteMint.equals(snapshotA.quoteMint)).toBe(true)
    expect(targetA?.dammPool.equals(deriveDammV2PoolAddress(new PublicKey(DAMM_CONFIG_FEE_OPTION_0), poolA.baseMint, snapshotA.quoteMint))).toBe(true)
    expect(targetB?.dammPool.equals(deriveDammV2PoolAddress(new PublicKey(DAMM_CONFIG_FEE_OPTION_6), poolB.baseMint, snapshotB.quoteMint))).toBe(true)
  })

  it('leaves out pools that are running or already migrated, without errors', () => {
    const config = newKey()
    const pools = [
      poolSnapshot(PRE_BONDING_CURVE, false, config),
      poolSnapshot(CREATED_POOL, true, config),
      poolSnapshot(CREATED_POOL, false, config),
      poolSnapshot(LOCKED_VESTING, true, config),
    ]

    const plan = planMigrations({ pools, configs: new Map([[config.toBase58(), ok(configSnapshot(0))]]) })

    expect(plan).toEqual({ targets: [], errors: [] })
  })

  it('reports a pool whose config is unavailable or has no DAMM v2 option, and still plans the others', () => {
    const missing = newKey()
    const badOption = newKey()
    const good = newKey()
    const pools = [
      poolSnapshot(LOCKED_VESTING, false, missing),
      poolSnapshot(LOCKED_VESTING, false, badOption),
      poolSnapshot(LOCKED_VESTING, false, good),
    ]
    const configs = new Map([
      [missing.toBase58(), failed<ConfigSnapshot>('config account not found')],
      [badOption.toBase58(), ok(configSnapshot(9))],
      [good.toBase58(), ok(configSnapshot(6))],
    ])

    const plan = planMigrations({ pools, configs })

    expect(plan.targets).toHaveLength(1)
    expect(plan.targets[0]?.pool.equals(pools[2]!.pool)).toBe(true)
    expect(plan.errors).toHaveLength(2)
    expect(plan.errors[0]).toContain(pools[0]!.pool.toBase58())
    expect(plan.errors[0]).toContain('config account not found')
    expect(plan.errors[1]).toContain(pools[1]!.pool.toBase58())
    expect(plan.errors[1]).toMatch(/migration fee option 9/)
  })
})

describe('migrate job run', () => {
  it('is registered under the name "migrate"', () => {
    expect(migrateJob.name).toBe('migrate')
  })

  it('simulates, then sends one migration per ready pool signed by the payer and both position-NFT mints', async () => {
    const config = newKey()
    const pool = poolSnapshot(LOCKED_VESTING, false, config)
    const configs = new Map([[config.toBase58(), configSnapshot(6)]])
    const built: MigrateToDammV2Response[] = []
    const buildMigration = vi.fn(async (ctx: CrankContext, _target: MigrationTarget) => {
      const migration = fakeMigration(ctx.payer.publicKey)
      built.push(migration)
      return migration
    })
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection)
    const { logger, lines } = recordingLogger()

    const result = await createMigrateJob(stubDeps([pool], { configs, overrides: { buildMigration } })).run(
      testContext({ connection, logger }),
    )

    expect(result).toEqual({ sent: [SIGNATURE], skipped: 0, errors: [] })
    expect(buildMigration).toHaveBeenCalledTimes(1)
    expect(buildMigration.mock.calls[0]?.[1].dammConfig.toBase58()).toBe(DAMM_CONFIG_FEE_OPTION_6)
    expect(rpc.simulate.mock.invocationCallOrder[0]).toBeLessThan(rpc.send.mock.invocationCallOrder[0] ?? 0)

    const wire = rpc.send.mock.calls[0]?.[0]
    const tx = VersionedTransaction.deserialize(Uint8Array.from(wire as Buffer))
    const signerKeys = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58())
    const migration = built[0]!
    expect(signerKeys.sort()).toEqual(
      [payer.publicKey, migration.firstPositionNftKeypair.publicKey, migration.secondPositionNftKeypair.publicKey]
        .map((k) => k.toBase58())
        .sort(),
    )
    expect(tx.signatures.every((sig) => sig.some((byte) => byte !== 0))).toBe(true)

    const dammPool = deriveDammV2PoolAddress(new PublicKey(DAMM_CONFIG_FEE_OPTION_6), pool.baseMint, configs.get(config.toBase58())!.quoteMint)
    const success = lines.find((line) => line.level === 'info' && line.ctx.signature === SIGNATURE)
    expect(success?.ctx).toMatchObject({ pool: pool.pool.toBase58(), dammPool: dammPool.toBase58() })
    expect(errorLines(lines)).toEqual([])
  })

  it('never logs the position-NFT keypairs', async () => {
    const config = newKey()
    const pools = [poolSnapshot(LOCKED_VESTING, false, config), poolSnapshot(LOCKED_VESTING, false, config)]
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const built: MigrateToDammV2Response[] = []
    const buildMigration = async (ctx: CrankContext): Promise<MigrateToDammV2Response> => {
      const migration = fakeMigration(ctx.payer.publicKey)
      built.push(migration)
      return migration
    }
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection)
    rpc.simulate.mockResolvedValueOnce(simulation({ InstructionError: [0, { Custom: 6000 }] }))
    const { logger, lines } = recordingLogger()

    await createMigrateJob(stubDeps(pools, { configs, overrides: { buildMigration } })).run(testContext({ connection, logger }))

    const logged = JSON.stringify(lines)
    for (const migration of built) {
      for (const kp of [migration.firstPositionNftKeypair, migration.secondPositionNftKeypair]) {
        expect(logged).not.toContain(Buffer.from(kp.secretKey).toString('base64'))
        expect(logged).not.toContain(Array.from(kp.secretKey.slice(0, 8)).join(','))
      }
    }
    for (const line of lines) {
      expect(Object.values(line.ctx).some((value) => value instanceof Keypair)).toBe(false)
    }
  })

  it('treats a pool already migrated by someone else as done: no tx and no error log', async () => {
    const config = newKey()
    const pools = [poolSnapshot(CREATED_POOL, false, config), poolSnapshot(CREATED_POOL, true, config), poolSnapshot(LOCKED_VESTING, true, config)]
    const buildMigration = vi.fn(async (ctx: CrankContext) => fakeMigration(ctx.payer.publicKey))
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection)
    const { logger, lines } = recordingLogger()

    const result = await createMigrateJob(stubDeps(pools, { overrides: { buildMigration } })).run(testContext({ connection, logger }))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(buildMigration).not.toHaveBeenCalled()
    expect(rpc.simulate).not.toHaveBeenCalled()
    expect(rpc.send).not.toHaveBeenCalled()
    expect(errorLines(lines)).toEqual([])
  })

  it('logs info, not an error, when a keeper migrates the pool between the read and the send', async () => {
    const config = newKey()
    const ready = poolSnapshot(LOCKED_VESTING, false, config)
    const migratedMeanwhile: PoolSnapshot = { ...ready, state: { migrationProgress: CREATED_POOL, isMigrated: true } }
    const fetchPools = vi
      .fn<MigrateJobDeps['fetchPools']>()
      .mockResolvedValueOnce([ok(ready)])
      .mockResolvedValueOnce([ok(migratedMeanwhile)])
    const configs = new Map([[config.toBase58(), configSnapshot(6)]])
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection, { InstructionError: [0, { Custom: 6011 }] })
    const { logger, lines } = recordingLogger()

    const result = await createMigrateJob(stubDeps([ready], { configs, overrides: { fetchPools } })).run(
      testContext({ connection, logger }),
    )

    expect(result).toEqual({ sent: [], skipped: 1, errors: [] })
    expect(rpc.send).not.toHaveBeenCalled()
    expect(fetchPools).toHaveBeenCalledTimes(2)
    expect(errorLines(lines)).toEqual([])
    expect(lines.some((line) => line.level === 'info' && line.ctx.pool === ready.pool.toBase58() && /already migrated/.test(line.msg))).toBe(true)
  })

  it('skips and reports a pool whose simulation fails, then migrates the next one', async () => {
    const config = newKey()
    const pools = [poolSnapshot(LOCKED_VESTING, false, config), poolSnapshot(LOCKED_VESTING, false, config)]
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection)
    rpc.simulate.mockResolvedValueOnce(simulation({ InstructionError: [0, { Custom: 6000 }] }, ['Program log: bad']))
    const { logger, lines } = recordingLogger()

    const result = await createMigrateJob(stubDeps(pools, { configs })).run(testContext({ connection, logger }))

    expect(result.sent).toEqual([SIGNATURE])
    expect(result.skipped).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(pools[0]!.pool.toBase58())
    expect(result.errors[0]).toMatch(/simulation failed/)
    expect(rpc.send).toHaveBeenCalledTimes(1)
    expect(errorLines(lines)).toHaveLength(1)
  })

  it('reports a transaction that fails on chain unless the pool turns out migrated', async () => {
    const config = newKey()
    const pool = poolSnapshot(LOCKED_VESTING, false, config)
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection)
    rpc.confirm.mockResolvedValue({ context: { slot: 2 }, value: { err: { InstructionError: [0, { Custom: 6000 }] } } })

    const result = await createMigrateJob(stubDeps([pool], { configs })).run(testContext({ connection }))

    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(SIGNATURE)
  })

  it('returns errors instead of throwing when the DBC client fails', async () => {
    const config = newKey()
    const pool = poolSnapshot(LOCKED_VESTING, false, config)
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const buildMigration = vi.fn(async () => {
      throw new Error('Pool not found: rpc down')
    })
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection)

    const result = await createMigrateJob(stubDeps([pool], { configs, overrides: { buildMigration } })).run(
      testContext({ connection }),
    )

    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(pool.pool.toBase58())
    expect(result.errors[0]).toContain('rpc down')
    expect(rpc.send).not.toHaveBeenCalled()
  })

  it('redacts RPC URLs (and the API key inside them) from every reported error', async () => {
    const fakeKey = 'FAKEKEY-0123456789abcdef'
    const rpcUrl = `https://rpc.example.invalid/v2/${fakeKey}`
    const config = newKey()
    const pool = poolSnapshot(LOCKED_VESTING, false, config)
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const buildMigration = vi.fn(async () => {
      throw new Error(`failed to get info about account: request to ${rpcUrl} failed`)
    })
    const listMarkets = vi.fn(async (): Promise<readonly MarketRef[]> => {
      throw new Error(`429 from ${rpcUrl}?api-key=${fakeKey}`)
    })

    const clientError = await createMigrateJob(stubDeps([pool], { configs, overrides: { buildMigration } })).run(testContext())
    const loadError = await createMigrateJob(stubDeps([], { overrides: { listMarkets } })).run(testContext())

    expect(clientError.errors).toHaveLength(1)
    expect(loadError.errors).toHaveLength(1)
    for (const error of [...clientError.errors, ...loadError.errors]) {
      expect(error).not.toContain(fakeKey)
      expect(error).toContain('rpc.example.invalid')
    }
  })

  describe('confirmation timeout', () => {
    async function runWithHungConfirmation(stateAfterSend: PoolSnapshot['state']) {
      const config = newKey()
      const ready = poolSnapshot(LOCKED_VESTING, false, config)
      const fetchPools = vi
        .fn<MigrateJobDeps['fetchPools']>()
        .mockResolvedValueOnce([ok(ready)])
        .mockResolvedValueOnce([ok({ ...ready, state: stateAfterSend })])
      const configs = new Map([[config.toBase58(), configSnapshot(0)]])
      const connection = new Connection(LOCAL_RPC_URL)
      const rpc = mockSendPath(connection)
      rpc.confirm.mockReturnValue(hang())
      const { logger, lines } = recordingLogger()
      const job = createMigrateJob(stubDeps([ready], { configs, overrides: { fetchPools } }))

      const result = await runPastTimeout(() => job.run(testContext({ connection, logger })), rpc.confirm, CONFIRM_TIMEOUT_MS)
      return { result, rpc, lines, fetchPools }
    }

    it('reports an unknown outcome in errors (not sent) and does not resend in the same tick', async () => {
      const { result, rpc, lines } = await runWithHungConfirmation({ migrationProgress: LOCKED_VESTING, isMigrated: false })

      expect(result.sent).toEqual([])
      expect(result.skipped).toBe(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain(SIGNATURE)
      expect(result.errors[0]).toContain('outcome unknown, will re-check next tick')
      expect(rpc.send).toHaveBeenCalledTimes(1)
      expect(errorLines(lines)).toEqual([])
      expect(lines.some((line) => line.level === 'warn' && /unknown/.test(line.msg) && line.ctx.signature === SIGNATURE)).toBe(true)
    })

    it('treats the pool as migrated when the re-read shows CreatedPool', async () => {
      const { result, lines, fetchPools } = await runWithHungConfirmation({ migrationProgress: CREATED_POOL, isMigrated: false })

      expect(result).toEqual({ sent: [], skipped: 1, errors: [] })
      expect(fetchPools).toHaveBeenCalledTimes(2)
      expect(lines.filter((line) => line.level !== 'info')).toEqual([])
    })
  })

  describe('hung RPC calls', () => {
    function readyJob(overrides: Partial<MigrateJobDeps> = {}) {
      const config = newKey()
      const pool = poolSnapshot(LOCKED_VESTING, false, config)
      const configs = new Map([[config.toBase58(), configSnapshot(0)]])
      return { pool, job: createMigrateJob(stubDeps([pool], { configs, overrides })) }
    }

    it('gives up on a hung simulateTransaction after RPC_TIMEOUT_MS and sends nothing', async () => {
      const { pool, job } = readyJob()
      const connection = new Connection(LOCAL_RPC_URL)
      const rpc = mockSendPath(connection)
      rpc.simulate.mockReturnValue(hang())

      const result = await runPastTimeout(() => job.run(testContext({ connection })), rpc.simulate, RPC_TIMEOUT_MS)

      expect(result.sent).toEqual([])
      expect(result.errors).toEqual([expect.stringContaining(`simulateTransaction timed out after ${RPC_TIMEOUT_MS} ms`)])
      expect(result.errors[0]).toContain(pool.pool.toBase58())
      expect(rpc.send).not.toHaveBeenCalled()
    })

    it('gives up on a hung sendRawTransaction and does not retry it in the same tick', async () => {
      const { job } = readyJob()
      const connection = new Connection(LOCAL_RPC_URL)
      const rpc = mockSendPath(connection)
      rpc.send.mockReturnValue(hang())

      const result = await runPastTimeout(() => job.run(testContext({ connection })), rpc.send, RPC_TIMEOUT_MS)

      expect(result.sent).toEqual([])
      expect(result.errors).toEqual([expect.stringContaining('sendRawTransaction timed out')])
      expect(rpc.send).toHaveBeenCalledTimes(1)
      expect(rpc.confirm).not.toHaveBeenCalled()
    })

    it('gives up on a hung DBC client build', async () => {
      const buildMigration = vi.fn((): Promise<MigrateToDammV2Response> => hang())
      const { job } = readyJob({ buildMigration })
      const connection = new Connection(LOCAL_RPC_URL)
      const rpc = mockSendPath(connection)

      const result = await runPastTimeout(() => job.run(testContext({ connection })), buildMigration, RPC_TIMEOUT_MS)

      expect(result.errors).toEqual([expect.stringContaining('building the migration timed out')])
      expect(rpc.simulate).not.toHaveBeenCalled()
    })

    it('gives up on a hung re-read after a failed simulation', async () => {
      const config = newKey()
      const ready = poolSnapshot(LOCKED_VESTING, false, config)
      const fetchPools = vi
        .fn<MigrateJobDeps['fetchPools']>()
        .mockResolvedValueOnce([ok(ready)])
        .mockReturnValueOnce(hang())
      const configs = new Map([[config.toBase58(), configSnapshot(0)]])
      const job = createMigrateJob(stubDeps([ready], { configs, overrides: { fetchPools } }))
      const connection = new Connection(LOCAL_RPC_URL)
      const rpc = mockSendPath(connection, { InstructionError: [0, { Custom: 6000 }] })
      const { logger, lines } = recordingLogger()

      const result = await runPastTimeout(() => job.run(testContext({ connection, logger })), rpc.simulate, RPC_TIMEOUT_MS)

      expect(result.errors).toEqual([expect.stringContaining('simulation failed')])
      expect(errorLines(lines)[0]?.ctx.recheck).toMatch(/re-reading the pool timed out/)
    })
  })

  it('caps attempts per tick at ctx.maxTx * MAX_ATTEMPTS_PER_TX, counting failed attempts, and skips the rest', async () => {
    const config = newKey()
    const pools = Array.from({ length: 5 }, () => poolSnapshot(LOCKED_VESTING, false, config))
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const buildMigration = vi.fn(async (ctx: CrankContext) => fakeMigration(ctx.payer.publicKey))
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection, { InstructionError: [0, { Custom: 6000 }] })

    const result = await createMigrateJob(stubDeps(pools, { configs, overrides: { buildMigration } })).run(
      testContext({ connection, maxTx: 1 }),
    )

    expect(MAX_ATTEMPTS_PER_TX).toBe(3)
    expect(buildMigration).toHaveBeenCalledTimes(3)
    expect(rpc.simulate).toHaveBeenCalledTimes(3)
    expect(rpc.send).not.toHaveBeenCalled()
    expect(result.errors).toHaveLength(3)
    expect(result.skipped).toBe(2)
  })

  it('counts a failed build as an attempt', async () => {
    const config = newKey()
    const pools = Array.from({ length: 4 }, () => poolSnapshot(LOCKED_VESTING, false, config))
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const buildMigration = vi.fn(async (): Promise<MigrateToDammV2Response> => {
      throw new Error('rpc down')
    })

    const result = await createMigrateJob(stubDeps(pools, { configs, overrides: { buildMigration } })).run(testContext({ maxTx: 1 }))

    expect(buildMigration).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ sent: [], skipped: 1 })
    expect(result.errors).toHaveLength(3)
  })

  it('skips with a warning a pool whose config differs from its router market config', async () => {
    const pool = poolSnapshot(LOCKED_VESTING, false)
    const listMarkets = vi.fn(async (): Promise<readonly MarketRef[]> => [{ pool: pool.pool, config: newKey() }])
    const buildMigration = vi.fn(async (ctx: CrankContext) => fakeMigration(ctx.payer.publicKey))
    const configs = new Map([[pool.config.toBase58(), configSnapshot(0)]])
    const { logger, lines } = recordingLogger()

    const result = await createMigrateJob(stubDeps([pool], { configs, overrides: { listMarkets, buildMigration } })).run(
      testContext({ logger }),
    )

    expect(result).toEqual({ sent: [], skipped: 1, errors: [] })
    expect(buildMigration).not.toHaveBeenCalled()
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1)
    expect(lines[0]?.ctx).toMatchObject({ pool: pool.pool.toBase58(), poolConfig: pool.config.toBase58() })
  })

  it.each([
    { name: 'signed transaction over the packet size', dataBytes: 900 },
    { name: 'message that overflows while serializing', dataBytes: 4000 },
  ])('reports an oversized migration ($name) clearly and sends nothing', async ({ dataBytes }) => {
    const config = newKey()
    const pool = poolSnapshot(LOCKED_VESTING, false, config)
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const buildMigration = async (ctx: CrankContext): Promise<MigrateToDammV2Response> =>
      fakeMigration(ctx.payer.publicKey, dataBytes)
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection)

    const result = await createMigrateJob(stubDeps([pool], { configs, overrides: { buildMigration } })).run(
      testContext({ connection }),
    )

    expect(result.errors).toEqual([expect.stringMatching(/migration transaction is too large to send .*limit is 1232 bytes/)])
    expect(rpc.simulate).not.toHaveBeenCalled()
    expect(rpc.send).not.toHaveBeenCalled()
  })

  it('returns errors instead of throwing when loading the pools fails', async () => {
    const listMarkets = vi.fn(async (): Promise<readonly MarketRef[]> => {
      throw new Error('getProgramAccounts failed')
    })

    const result = await createMigrateJob(stubDeps([], { overrides: { listMarkets } })).run(testContext())

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining('getProgramAccounts failed')] })
  })

  it('reports a pool whose account cannot be read', async () => {
    const pool = poolSnapshot(LOCKED_VESTING, false)
    const fetchPools = vi.fn<MigrateJobDeps['fetchPools']>().mockResolvedValue([failed('pool account not found')])

    const result = await createMigrateJob(stubDeps([pool], { overrides: { fetchPools } })).run(testContext())

    expect(result.errors).toEqual([`${pool.pool.toBase58()}: pool account not found`])
  })

  it('sends at most ctx.maxTx transactions and counts the rest as skipped', async () => {
    const config = newKey()
    const pools = [0, 1, 2].map(() => poolSnapshot(LOCKED_VESTING, false, config))
    const configs = new Map([[config.toBase58(), configSnapshot(0)]])
    const buildMigration = vi.fn(async (ctx: CrankContext) => fakeMigration(ctx.payer.publicKey))
    const connection = new Connection(LOCAL_RPC_URL)
    const rpc = mockSendPath(connection)

    const one = await createMigrateJob(stubDeps(pools, { configs, overrides: { buildMigration } })).run(
      testContext({ connection, maxTx: 1 }),
    )
    const none = await createMigrateJob(stubDeps(pools, { configs, overrides: { buildMigration } })).run(
      testContext({ connection, maxTx: 0 }),
    )

    expect(one).toEqual({ sent: [SIGNATURE], skipped: 2, errors: [] })
    expect(none).toEqual({ sent: [], skipped: 3, errors: [] })
    expect(buildMigration).toHaveBeenCalledTimes(1)
    expect(rpc.send).toHaveBeenCalledTimes(1)
  })

  describe('crank guards (CRK-10)', () => {
    /** One ready pool per [quote mint, migration quote threshold]. */
    function demoPools(rows: readonly (readonly [PublicKey, bigint])[]) {
      const pools = rows.map(() => poolSnapshot(LOCKED_VESTING, false))
      const snapshots = rows.map(([quoteMint, migrationQuoteThreshold]) => configSnapshot(0, { quoteMint, migrationQuoteThreshold }))
      const configs = new Map(pools.map((pool, i) => [pool.config.toBase58(), snapshots[i]!]))
      const buildMigration = vi.fn(async (ctx: CrankContext, _target: MigrationTarget) => fakeMigration(ctx.payer.publicKey))
      return { pools, deps: stubDeps(pools, { configs, overrides: { buildMigration } }), buildMigration }
    }

    it('migrates the 0.303 SOL demo threshold under the devnet default MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS (0)', async () => {
      const { deps } = demoPools([[NATIVE_MINT, DEMO_THRESHOLD_LAMPORTS]])
      const connection = new Connection(LOCAL_RPC_URL)
      mockSendPath(connection)

      const result = await createMigrateJob(deps, defaultCrankGuards('devnet')).run(testContext({ connection }))

      expect(result).toEqual({ sent: [SIGNATURE], skipped: 0, errors: [] })
    })

    it('skips, one log line each, pools below their quote minimum (wSOL 1 SOL on mainnet-beta, xStock 1 share)', async () => {
      const rows = [[NATIVE_MINT, DEMO_THRESHOLD_LAMPORTS], [TSLAX_MINT, 90_000_000n], [TSLAX_MINT, 100_000_000n]] as const
      const { pools, deps, buildMigration } = demoPools(rows)
      const connection = new Connection(LOCAL_RPC_URL)
      mockSendPath(connection)
      const { logger, lines } = recordingLogger()

      const result = await createMigrateJob(deps, defaultCrankGuards('mainnet-beta')).run(testContext({ connection, logger }))

      expect(result).toEqual({ sent: [SIGNATURE], skipped: 2, errors: [] })
      expect(buildMigration.mock.calls.map(([, target]) => target.pool.toBase58())).toEqual([pools[2]!.pool.toBase58()])
      const linesOf = (i: number) => lines.filter((line) => line.ctx.pool === pools[i]!.pool.toBase58())
      expect(linesOf(0).map((line) => line.ctx)).toEqual([expect.objectContaining({ migrationQuoteThreshold: DEMO_THRESHOLD_LAMPORTS, minThreshold: 1_000_000_000n })])
      expect(linesOf(1).map((line) => line.ctx)).toEqual([expect.objectContaining({ migrationQuoteThreshold: 90_000_000n, minThreshold: 100_000_000n })])
    })

    it('skips a pool whose quote mint has no crank minimums, warning once per mint for the job instance', async () => {
      const unknownMint = newKey()
      const { deps, buildMigration } = demoPools([[unknownMint, 10_000_000_000n]])
      const { logger, lines } = recordingLogger()
      const job = createMigrateJob(deps, defaultCrankGuards('mainnet-beta'))

      const results = [await job.run(testContext({ logger })), await job.run(testContext({ logger }))]

      expect(results).toEqual([{ sent: [], skipped: 1, errors: [] }, { sent: [], skipped: 1, errors: [] }])
      expect(buildMigration).not.toHaveBeenCalled()
      expect(lines.map((line) => [line.level, line.ctx.quoteMint])).toEqual([['warn', unknownMint.toBase58()]])
    })

    it('sends no migration while the payer holds less than CRANK_MIN_SOL_LAMPORTS, with one log line', async () => {
      vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(49_999_999)
      const { deps, buildMigration } = demoPools([[NATIVE_MINT, DEMO_THRESHOLD_LAMPORTS]])
      const listMarkets = vi.fn(deps.listMarkets)
      const { logger, lines } = recordingLogger()

      const result = await createMigrateJob({ ...deps, listMarkets }, defaultCrankGuards('devnet')).run(testContext({ logger }))

      expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
      expect(listMarkets).not.toHaveBeenCalled()
      expect(buildMigration).not.toHaveBeenCalled()
      expect(lines.map((line) => line.level)).toEqual(['warn'])
    })
  })
})

describe('migrate job default loaders (decoded DBC accounts)', () => {
  const { program } = createDbcProgram(new Connection(LOCAL_RPC_URL))
  const coder = program.coder.accounts

  /** Discriminator followed by zeros: every field decodes as zero / the default key. */
  function zeroAccountData(name: 'transferHookPool' | 'configWithTransferHook'): Buffer {
    const idlAccount = program.idl.accounts.find((account) => account.name === name)
    if (idlAccount === undefined) throw new Error(`DBC IDL has no ${name} account`)
    const discriminator = Buffer.from(idlAccount.discriminator)
    return Buffer.concat([discriminator, Buffer.alloc(coder.size(name) - discriminator.length)])
  }

  function zeroAccount<T>(name: 'transferHookPool' | 'configWithTransferHook'): T {
    return coder.decode<T>(name, zeroAccountData(name))
  }

  async function encodePool(config: PublicKey, baseMint: PublicKey, migrationProgress: number, isMigrated: number): Promise<Buffer> {
    const zero = zeroAccount<TransferHookPool>('transferHookPool')
    return coder.encode('transferHookPool', { ...zero, poolState: { ...zero.poolState, config, baseMint, migrationProgress, isMigrated } })
  }

  /** Raw bytes: the account is larger than the 1000-byte buffer Anchor's encode() allocates. */
  function encodeConfig(quoteMint: PublicKey, migrationFeeOption: number): Buffer {
    const data = zeroAccountData('configWithTransferHook')
    quoteMint.toBuffer().copy(data, CONFIG_QUOTE_MINT_OFFSET)
    data.writeUInt8(migrationFeeOption, CONFIG_MIGRATION_FEE_OPTION_OFFSET)
    const decoded = coder.decode<ConfigWithTransferHook>('configWithTransferHook', data)
    if (!decoded.config.quoteMint.equals(quoteMint) || decoded.config.migrationFeeOption !== migrationFeeOption) {
      throw new Error('ConfigWithTransferHook offsets do not match the DBC IDL')
    }
    return data
  }

  function encodeMarket(pool: PublicKey, config: PublicKey): Buffer {
    const data = Buffer.alloc(MARKET_ACCOUNT_SIZE)
    Buffer.from(MARKET_DISCRIMINATOR).copy(data, 0)
    pool.toBuffer().copy(data, MARKET_POOL_OFFSET)
    config.toBuffer().copy(data, MARKET_CONFIG_OFFSET)
    return data
  }

  function accountInfo(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
    return { data, owner, executable: false, lamports: 1_000_000, rentEpoch: 0 }
  }

  /** Serves the given router markets and DBC accounts; every other address is missing. */
  function mockChain(connection: Connection, markets: readonly MarketRef[], dbcAccounts: ReadonlyMap<string, Buffer>) {
    vi.spyOn(connection, 'getProgramAccounts').mockResolvedValue(
      markets.map((market) => ({
        pubkey: newKey(),
        account: accountInfo(encodeMarket(market.pool, market.config), CLUSTER.routerProgramId),
      })),
    )
    return vi.spyOn(connection, 'getMultipleAccountsInfo').mockImplementation(async (keys) =>
      keys.map((key) => {
        const data = dbcAccounts.get(key.toBase58())
        return data === undefined ? null : accountInfo(data, CLUSTER.dbcProgramId)
      }),
    )
  }

  it('encodes migration_progress at byte 308 (RSC-03 layout)', async () => {
    const data = await encodePool(newKey(), newKey(), CREATED_POOL, 0)

    expect(data[MIGRATION_PROGRESS_OFFSET]).toBe(CREATED_POOL)
  })

  it('sends nothing for a pool whose progress byte is CreatedPool, even with is_migrated unset', async () => {
    const pool = newKey()
    const config = newKey()
    const connection = new Connection(LOCAL_RPC_URL)
    const accounts = new Map([[pool.toBase58(), await encodePool(config, newKey(), CREATED_POOL, 0)]])
    mockChain(connection, [{ pool, config }], accounts)
    const rpc = mockSendPath(connection)
    const { logger, lines } = recordingLogger()

    const result = await migrateJob.run(testContext({ connection, logger }))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(rpc.simulate).not.toHaveBeenCalled()
    expect(errorLines(lines)).toEqual([])
  })

  it("reads each pool's own config and passes the matching DAMM v2 config to the migration", async () => {
    const poolA = newKey()
    const poolB = newKey()
    const configA = newKey()
    const configB = newKey()
    const quoteMint = NATIVE_MINT
    const connection = new Connection(LOCAL_RPC_URL)
    const accounts = new Map([
      [poolA.toBase58(), await encodePool(configA, newKey(), LOCKED_VESTING, 0)],
      [poolB.toBase58(), await encodePool(configB, newKey(), LOCKED_VESTING, 0)],
      [configA.toBase58(), encodeConfig(quoteMint, 0)],
      [configB.toBase58(), encodeConfig(quoteMint, 6)],
    ])
    mockChain(
      connection,
      [
        { pool: poolA, config: configA },
        { pool: poolB, config: configB },
      ],
      accounts,
    )
    mockSendPath(connection)
    const buildMigration = vi.fn(async (ctx: CrankContext, _target: MigrationTarget) => fakeMigration(ctx.payer.publicKey))

    const result = await createMigrateJob({ buildMigration }).run(testContext({ connection }))

    expect(result).toEqual({ sent: [SIGNATURE, SIGNATURE], skipped: 0, errors: [] })
    const chosen = new Map(buildMigration.mock.calls.map(([, target]) => [target.pool.toBase58(), target.dammConfig.toBase58()]))
    expect(chosen.get(poolA.toBase58())).toBe(DAMM_CONFIG_FEE_OPTION_0)
    expect(chosen.get(poolB.toBase58())).toBe(DAMM_CONFIG_FEE_OPTION_6)
  })

  it('reports a pool account owned by another program instead of decoding it', async () => {
    const pool = newKey()
    const connection = new Connection(LOCAL_RPC_URL)
    vi.spyOn(connection, 'getProgramAccounts').mockResolvedValue([
      { pubkey: newKey(), account: accountInfo(encodeMarket(pool, newKey()), CLUSTER.routerProgramId) },
    ])
    const poolData = await encodePool(newKey(), newKey(), LOCKED_VESTING, 0)
    vi.spyOn(connection, 'getMultipleAccountsInfo').mockResolvedValue([accountInfo(poolData, newKey())])

    const result = await migrateJob.run(testContext({ connection }))

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(pool.toBase58())
    expect(result.errors[0]).toMatch(/not owned by the DBC program/)
  })

  it('returns errors instead of throwing when the RPC fails', async () => {
    const connection = new Connection(LOCAL_RPC_URL)
    vi.spyOn(connection, 'getProgramAccounts').mockRejectedValue(new Error('429 Too Many Requests'))

    const result = await migrateJob.run(testContext({ connection }))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining('429 Too Many Requests')] })
  })

  it('gives up on a hung market scan after RPC_TIMEOUT_MS', async () => {
    const connection = new Connection(LOCAL_RPC_URL)
    const scan = vi.spyOn(connection, 'getProgramAccounts').mockReturnValue(hang())

    const result = await runPastTimeout(() => migrateJob.run(testContext({ connection })), scan, RPC_TIMEOUT_MS)

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining('fetching router markets timed out')] })
  })

  it('gives up on a hung pool read after RPC_TIMEOUT_MS', async () => {
    const pool = newKey()
    const connection = new Connection(LOCAL_RPC_URL)
    mockChain(connection, [{ pool, config: newKey() }], new Map())
    const read = vi.spyOn(connection, 'getMultipleAccountsInfo').mockReturnValue(hang())

    const result = await runPastTimeout(() => migrateJob.run(testContext({ connection })), read, RPC_TIMEOUT_MS)

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining('getMultipleAccountsInfo timed out')] })
  })
})
