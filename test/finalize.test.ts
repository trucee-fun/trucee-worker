import { Connection, Keypair, PublicKey, type AccountInfo, type TransactionError } from '@solana/web3.js'
import {
  MARKET_ACCOUNT_SIZE,
  ROUTER_PROGRAM_ID,
  finalizeInstruction,
  getClusterConfig,
  type ClusterConfig,
  type MarketAccount,
} from '@trucee/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CRANK_MIN_SOL_LAMPORTS, defaultCrankGuards, type CrankGuards } from '../src/config.js'
import type { CrankContext } from '../src/crank/index.js'
import {
  CONFIRM_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  createFinalizeJob,
  finalizeJob,
  planFinalize,
} from '../src/crank/jobs/finalize.js'
import type { Logger } from '../src/log.js'

const LOCAL_RPC_URL = 'http://127.0.0.1:8899'
const CLUSTER: ClusterConfig = getClusterConfig('localnet')

/** sha256("account:Market")[..8], copied from sdk/src/accounts.ts so markets can be encoded as raw account data. */
const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154]
const MARKET_POOL_OFFSET = 8
const MARKET_BUFFER_VAULT_OFFSET = 200
const MARKET_FINALIZED_OFFSET = 249

/** DBC VirtualPool: migration_progress byte (0 = PreBondingCurve). */
const POOL_PROGRESS_OFFSET = 308
const POOL_SIZE = 424
const PROGRESS_PRE_BONDING = 0
const PROGRESS_COMPLETE = 3
const POOL_BATCH_SIZE = 100

const BLOCKHASH = Keypair.generate().publicKey.toBase58()
const LAST_VALID_BLOCK_HEIGHT = 1_000
const SIGNATURE = '5'.repeat(88)
/** AlreadyFinalized (6010) as the router logs it. */
const ALREADY_FINALIZED_LOGS = [
  `Program ${ROUTER_PROGRAM_ID.toBase58()} invoke [1]`,
  `Program ${ROUTER_PROGRAM_ID.toBase58()} failed: custom program error: 0x177a`,
]
const ALREADY_FINALIZED_ERR: TransactionError = { InstructionError: [0, { Custom: 6010 }] }
/** A fake provider key inside an RPC URL, as raw web3.js errors embed it. */
const FAKE_API_KEY = 'fake-api-key-0123456789'
const KEYED_RPC_URL = `https://rpc.example.invalid/v1/?api-key=${FAKE_API_KEY}`
/** Payer balance of every mocked connection unless a test sets one: 1 SOL, above any floor these tests use. */
const FUNDED_LAMPORTS = 1_000_000_000

const randomKey = (): PublicKey => Keypair.generate().publicKey

function makeMarket(overrides: Partial<MarketAccount> = {}): MarketAccount {
  return {
    address: randomKey(),
    pool: randomKey(),
    config: randomKey(),
    baseMint: randomKey(),
    quoteMint: randomKey(),
    baseVault: randomKey(),
    quoteVault: randomKey(),
    bufferVault: randomKey(),
    feeNumerator: 10_000_000n,
    bump: 255,
    totalBasis: 0n,
    finalized: false,
    surplusSnapshot: 0n,
    basisSnapshot: 0n,
    surplusClaimed: 0n,
    ...overrides,
  }
}

function progressOf(entries: ReadonlyArray<readonly [MarketAccount, number]>): Map<string, number> {
  return new Map(entries.map(([market, progress]) => [market.pool.toBase58(), progress]))
}

function encodeMarket(market: MarketAccount): Buffer {
  const data = Buffer.alloc(MARKET_ACCOUNT_SIZE)
  Buffer.from(MARKET_DISCRIMINATOR).copy(data, 0)
  market.pool.toBuffer().copy(data, MARKET_POOL_OFFSET)
  market.bufferVault.toBuffer().copy(data, MARKET_BUFFER_VAULT_OFFSET)
  data.writeUInt8(market.finalized ? 1 : 0, MARKET_FINALIZED_OFFSET)
  return data
}

function accountInfo(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1_000_000, owner, rentEpoch: 0 }
}

function poolData(progress: number, size = POOL_SIZE): Buffer {
  const data = Buffer.alloc(size)
  if (size > POOL_PROGRESS_OFFSET) data.writeUInt8(progress, POOL_PROGRESS_OFFSET)
  return data
}

interface ChainState {
  readonly markets: readonly MarketAccount[]
  /** Pool account data by pool address; absent or null means the account does not exist. */
  readonly pools: ReadonlyMap<string, Buffer | null>
  readonly simulationErr?: TransactionError | null
  readonly simulationLogs?: string[]
  /** Owner of every pool account; defaults to the cluster's DBC program. */
  readonly poolOwner?: PublicKey
  /** The crank payer's balance in lamports; defaults to FUNDED_LAMPORTS. */
  readonly payerBalance?: number
}

/** A real Connection whose RPC methods are all stubbed, so nothing touches the network. */
function mockConnection(state: ChainState) {
  const connection = new Connection(LOCAL_RPC_URL)
  const getBalance = vi.spyOn(connection, 'getBalance').mockResolvedValue(state.payerBalance ?? FUNDED_LAMPORTS)
  const getProgramAccounts = vi.spyOn(connection, 'getProgramAccounts').mockResolvedValue(
    state.markets.map((market) => ({
      pubkey: market.address,
      account: accountInfo(encodeMarket(market), ROUTER_PROGRAM_ID),
    })),
  )
  const getMultipleAccountsInfo = vi
    .spyOn(connection, 'getMultipleAccountsInfo')
    .mockImplementation(async (keys: PublicKey[]) =>
      keys.map((key) => {
        const data = state.pools.get(key.toBase58())
        return data === undefined || data === null ? null : accountInfo(data, state.poolOwner ?? CLUSTER.dbcProgramId)
      }),
    )
  const getLatestBlockhash = vi
    .spyOn(connection, 'getLatestBlockhash')
    .mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT })
  const simulateTransaction = vi.spyOn(connection, 'simulateTransaction').mockResolvedValue({
    context: { slot: 1 },
    value: { err: state.simulationErr ?? null, logs: state.simulationLogs ?? [], accounts: null, unitsConsumed: 5_000 },
  })
  const sendRawTransaction = vi.spyOn(connection, 'sendRawTransaction').mockResolvedValue(SIGNATURE)
  const confirmTransaction = vi
    .spyOn(connection, 'confirmTransaction')
    .mockResolvedValue({ context: { slot: 2 }, value: { err: null } })
  return {
    connection,
    getBalance,
    getProgramAccounts,
    getMultipleAccountsInfo,
    getLatestBlockhash,
    simulateTransaction,
    sendRawTransaction,
    confirmTransaction,
  }
}

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function contextFor(connection: Connection, maxTx: number, logger: Logger = silentLogger()): CrankContext {
  return { connection, payer: Keypair.generate(), cluster: CLUSTER, log: logger, maxTx }
}

/** One complete, unfinalized market and its pool data. */
function dueMarket(): { market: MarketAccount; pools: Map<string, Buffer | null> } {
  const market = makeMarket()
  return { market, pools: new Map([[market.pool.toBase58(), poolData(PROGRESS_COMPLETE)]]) }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('planFinalize', () => {
  it('skips markets that are already finalized', () => {
    const market = makeMarket({ finalized: true })

    const plan = planFinalize([market], progressOf([[market, PROGRESS_COMPLETE]]))

    expect(plan).toEqual([])
  })

  it('skips markets whose curve is still in PreBondingCurve (progress 0)', () => {
    const market = makeMarket()

    const plan = planFinalize([market], progressOf([[market, PROGRESS_PRE_BONDING]]))

    expect(plan).toEqual([])
  })

  it('skips markets with no known pool progress', () => {
    const plan = planFinalize([makeMarket()], new Map())

    expect(plan).toEqual([])
  })

  it('yields exactly one finalize ix with accounts [market (w), pool, buffer] for a complete, unfinalized market', () => {
    const market = makeMarket()

    const plan = planFinalize([market], progressOf([[market, PROGRESS_COMPLETE]]))

    expect(plan).toHaveLength(1)
    const [tx] = plan
    expect(tx).toHaveLength(1)
    const ix = tx?.[0]
    expect(ix?.programId.equals(ROUTER_PROGRAM_ID)).toBe(true)
    expect(ix?.keys.map((meta) => [meta.pubkey.toBase58(), meta.isWritable, meta.isSigner])).toEqual([
      [market.address.toBase58(), true, false],
      [market.pool.toBase58(), false, false],
      [market.bufferVault.toBase58(), false, false],
    ])
    const expected = finalizeInstruction({
      cluster: CLUSTER,
      market: market.address,
      pool: market.pool,
      bufferVault: market.bufferVault,
    })
    expect(ix?.data.equals(expected.data)).toBe(true)
  })

  it('treats any non-zero migration progress as complete', () => {
    const markets = [1, 2, 3].map(() => makeMarket())

    const plan = planFinalize(markets, progressOf(markets.map((market, i) => [market, i + 1] as const)))

    expect(plan).toHaveLength(3)
  })

  it('returns one transaction per due market, in input order', () => {
    const finalized = makeMarket({ finalized: true })
    const pending = makeMarket()
    const dueA = makeMarket()
    const dueB = makeMarket()
    const progress = progressOf([
      [finalized, PROGRESS_COMPLETE],
      [pending, PROGRESS_PRE_BONDING],
      [dueA, PROGRESS_COMPLETE],
      [dueB, PROGRESS_COMPLETE],
    ])

    const plan = planFinalize([finalized, dueA, pending, dueB], progress)

    expect(plan.map((tx) => tx[0]?.keys[0]?.pubkey.toBase58())).toEqual([
      dueA.address.toBase58(),
      dueB.address.toBase58(),
    ])
  })

  it('uses the router program id of the given cluster', () => {
    const market = makeMarket()
    const routerProgramId = randomKey()
    const cluster: ClusterConfig = { ...CLUSTER, routerProgramId }

    const plan = planFinalize([market], progressOf([[market, PROGRESS_COMPLETE]]), cluster)

    expect(plan[0]?.[0]?.programId.equals(routerProgramId)).toBe(true)
  })
})

describe('finalizeJob', () => {
  it('is named finalize', () => {
    expect(finalizeJob.name).toBe('finalize')
  })

  it('returns errors[] and does not throw when simulation fails, without sending', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({
      markets: [market],
      pools,
      simulationErr: ALREADY_FINALIZED_ERR,
      simulationLogs: ALREADY_FINALIZED_LOGS,
    })
    const logger = silentLogger()

    const result = await finalizeJob.run(contextFor(rpc.connection, 5, logger))

    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(market.address.toBase58())
    expect(result.errors[0]).toContain('AlreadyFinalized')
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1)
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('simulates, sends and confirms finalize for a complete, unfinalized market', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result).toEqual({ sent: [SIGNATURE], skipped: 0, errors: [] })
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1)
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(1)
    expect(rpc.confirmTransaction).toHaveBeenCalledWith(
      { signature: SIGNATURE, blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT },
      'confirmed',
    )
  })

  it('reads markets from the cluster router program', async () => {
    const rpc = mockConnection({ markets: [], pools: new Map() })

    await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(rpc.getProgramAccounts.mock.calls[0]?.[0]).toEqual(CLUSTER.routerProgramId)
  })

  it('sends nothing and fetches no pools when every market is finalized', async () => {
    const market = makeMarket({ finalized: true })
    const rpc = mockConnection({ markets: [market], pools: new Map([[market.pool.toBase58(), poolData(PROGRESS_COMPLETE)]]) })

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(rpc.getMultipleAccountsInfo).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
  })

  it('sends nothing for markets whose curve is not complete', async () => {
    const market = makeMarket()
    const rpc = mockConnection({ markets: [market], pools: new Map([[market.pool.toBase58(), poolData(PROGRESS_PRE_BONDING)]]) })

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
  })

  it('sends at most ctx.maxTx transactions and counts the rest as skipped', async () => {
    const markets = [makeMarket(), makeMarket(), makeMarket()]
    const pools = new Map(markets.map((market) => [market.pool.toBase58(), poolData(PROGRESS_COMPLETE)]))
    const rpc = mockConnection({ markets, pools })

    const result = await finalizeJob.run(contextFor(rpc.connection, 1))

    expect(result.sent).toHaveLength(1)
    expect(result.skipped).toBe(2)
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(1)
  })

  it('skips and logs a market whose pool account is missing', async () => {
    const market = makeMarket()
    const rpc = mockConnection({ markets: [market], pools: new Map() })
    const logger = silentLogger()

    const result = await finalizeJob.run(contextFor(rpc.connection, 5, logger))

    expect(result).toEqual({ sent: [], skipped: 1, errors: [] })
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pool'), expect.objectContaining({ pool: market.pool.toBase58() }))
  })

  it('skips and logs a market whose pool account is too short to hold migration_progress', async () => {
    const market = makeMarket()
    const rpc = mockConnection({
      markets: [market],
      pools: new Map([[market.pool.toBase58(), poolData(PROGRESS_COMPLETE, POOL_PROGRESS_OFFSET)]]),
    })
    const logger = silentLogger()

    const result = await finalizeJob.run(contextFor(rpc.connection, 5, logger))

    expect(result).toEqual({ sent: [], skipped: 1, errors: [] })
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('skips and logs a market whose pool account is not owned by the DBC program', async () => {
    const { market, pools } = dueMarket()
    const owner = randomKey()
    const rpc = mockConnection({ markets: [market], pools, poolOwner: owner })
    const logger = silentLogger()

    const result = await finalizeJob.run(contextFor(rpc.connection, 5, logger))

    expect(result).toEqual({ sent: [], skipped: 1, errors: [] })
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not owned by DBC'),
      expect.objectContaining({ pool: market.pool.toBase58(), owner: owner.toBase58() }),
    )
  })

  it('fetches pool accounts in batches of 100', async () => {
    const markets = Array.from({ length: POOL_BATCH_SIZE + 50 }, () => makeMarket())
    const pools = new Map(markets.map((market) => [market.pool.toBase58(), poolData(PROGRESS_PRE_BONDING)]))
    const rpc = mockConnection({ markets, pools })

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(rpc.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.length)).toEqual([POOL_BATCH_SIZE, 50])
  })

  it('records an error and keeps going when sending one transaction fails', async () => {
    const first = dueMarket()
    const second = dueMarket()
    const rpc = mockConnection({ markets: [first.market, second.market], pools: new Map([...first.pools, ...second.pools]) })
    rpc.sendRawTransaction.mockRejectedValueOnce(new Error('blockhash not found'))

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result.sent).toEqual([SIGNATURE])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('blockhash not found')
  })

  it('records an error when the transaction fails on chain', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })
    rpc.confirmTransaction.mockResolvedValueOnce({ context: { slot: 2 }, value: { err: ALREADY_FINALIZED_ERR } })

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(market.address.toBase58())
  })

  it('returns errors[] and does not throw when fetching markets fails', async () => {
    const rpc = mockConnection({ markets: [], pools: new Map() })
    rpc.getProgramAccounts.mockRejectedValueOnce(new Error(`failed to get accounts from ${LOCAL_RPC_URL}`))
    const logger = silentLogger()

    const result = await finalizeJob.run(contextFor(rpc.connection, 5, logger))

    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(logger.error).toHaveBeenCalled()
  })

  it('returns errors[] and does not throw when fetching pools fails', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })
    rpc.getMultipleAccountsInfo.mockRejectedValueOnce(new Error('429 Too Many Requests'))

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result.sent).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('429')])
  })

  it('keeps the RPC URL and its key out of errors[] when sending rejects', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })
    rpc.sendRawTransaction.mockRejectedValueOnce(new Error(`failed to send transaction: request to ${KEYED_RPC_URL} failed`))

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('rpc.example.invalid')
    expect(result.errors.join('\n')).not.toContain(FAKE_API_KEY)
    expect(result.errors.join('\n')).not.toContain(KEYED_RPC_URL)
  })

  it('keeps the RPC URL and its key out of errors[] when fetching markets rejects', async () => {
    const rpc = mockConnection({ markets: [], pools: new Map() })
    rpc.getProgramAccounts.mockRejectedValueOnce(new Error(`failed to get accounts from ${KEYED_RPC_URL}`))

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result.errors).toHaveLength(1)
    expect(result.errors.join('\n')).not.toContain(FAKE_API_KEY)
  })

  it('reports an unknown outcome and does not resend when confirmation outlasts the timeout', async () => {
    vi.useFakeTimers()
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })
    // Confirmation stalls past the timeout, then rejects: that late rejection must stay handled.
    const lateRejection = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('block height exceeded')), CONFIRM_TIMEOUT_MS * 2)
    })
    rpc.confirmTransaction.mockReturnValueOnce(lateRejection)
    const logger = silentLogger()

    const pending = finalizeJob.run(contextFor(rpc.connection, 5, logger))
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS)
    const result = await pending
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS)

    expect(result.sent).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('outcome unknown')])
    expect(result.errors[0]).toContain(market.address.toBase58())
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('finalize outcome unknown, will re-check next tick', expect.anything())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the confirmation timer when confirmation settles in time', async () => {
    vi.useFakeTimers()
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result.sent).toEqual([SIGNATURE])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not throw when ctx.cluster cannot be resolved', async () => {
    const rpc = mockConnection({ markets: [], pools: new Map() })
    const ctx: CrankContext = {
      connection: rpc.connection,
      payer: Keypair.generate(),
      log: silentLogger(),
      maxTx: 5,
      get cluster(): ClusterConfig {
        throw new Error('unknown cluster')
      },
    }

    const result = await finalizeJob.run(ctx)

    expect(result.errors).toEqual([expect.stringContaining('unknown cluster')])
  })
})

/** Log calls per level: [info, warn, error]. */
function logCounts(logger: Logger): number[] {
  return [logger.info, logger.warn, logger.error].map((fn) => vi.mocked(fn).mock.calls.length)
}

describe('finalize payer floor (CRK-13)', () => {
  const BELOW_DEFAULT_FLOOR = Number(DEFAULT_CRANK_MIN_SOL_LAMPORTS) - 1
  /** A floor above FUNDED_LAMPORTS, so only guards passed to createFinalizeJob can stop a funded payer. */
  const ENV_FLOOR = 2_000_000_000n
  const envGuards: CrankGuards = { ...defaultCrankGuards('localnet'), crankMinSolLamports: ENV_FLOOR }

  it('plans nothing and logs one line while the payer holds less than CRANK_MIN_SOL_LAMPORTS (default 0.05 SOL)', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools, payerBalance: BELOW_DEFAULT_FLOOR })
    const logger = silentLogger()
    const ctx = contextFor(rpc.connection, 5, logger)

    const result = await finalizeJob.run(ctx)

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(rpc.getBalance).toHaveBeenCalledWith(ctx.payer.publicKey, 'confirmed')
    expect(rpc.getProgramAccounts).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled()
    expect(logCounts(logger)).toEqual([0, 1, 0])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('CRANK_MIN_SOL_LAMPORTS'),
      expect.objectContaining({
        job: 'finalize',
        payer: ctx.payer.publicKey.toBase58(),
        balanceLamports: BigInt(BELOW_DEFAULT_FLOOR),
        minLamports: DEFAULT_CRANK_MIN_SOL_LAMPORTS,
      }),
    )
  })

  it('finalizes once the payer holds exactly CRANK_MIN_SOL_LAMPORTS', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools, payerBalance: Number(DEFAULT_CRANK_MIN_SOL_LAMPORTS) })

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result).toEqual({ sent: [SIGNATURE], skipped: 0, errors: [] })
  })

  it('createFinalizeJob plans nothing below the CRANK_MIN_SOL_LAMPORTS of its guards, with one log line', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })
    const logger = silentLogger()

    const result = await createFinalizeJob(envGuards).run(contextFor(rpc.connection, 5, logger))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(rpc.getProgramAccounts).not.toHaveBeenCalled()
    expect(logCounts(logger)).toEqual([0, 1, 0])
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ minLamports: ENV_FLOOR }))
  })

  it('createFinalizeJob finalizes once the payer holds the CRANK_MIN_SOL_LAMPORTS of its guards', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools, payerBalance: Number(ENV_FLOOR) })

    const result = await createFinalizeJob(envGuards).run(contextFor(rpc.connection, 5))

    expect(result).toEqual({ sent: [SIGNATURE], skipped: 0, errors: [] })
  })

  it('keeps the RPC URL and its key out of errors[] when reading the payer balance rejects', async () => {
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })
    rpc.getBalance.mockRejectedValueOnce(new Error(`failed to get balance: request to ${KEYED_RPC_URL} failed`))

    const result = await finalizeJob.run(contextFor(rpc.connection, 5))

    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors.join('\n')).not.toContain(FAKE_API_KEY)
    expect(rpc.getProgramAccounts).not.toHaveBeenCalled()
  })

  it('gives up on a payer balance read that does not answer within RPC_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const { market, pools } = dueMarket()
    const rpc = mockConnection({ markets: [market], pools })
    rpc.getBalance.mockReturnValueOnce(new Promise<number>(() => undefined))

    const pending = finalizeJob.run(contextFor(rpc.connection, 5))
    await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS)
    const result = await pending

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining('getBalance')] })
    expect(rpc.getProgramAccounts).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
