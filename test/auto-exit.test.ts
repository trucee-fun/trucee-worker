/**
 * CRK-05: the auto-exit crank job. planAutoExits is tested with synthetic decoded accounts; autoExitJob.run with an
 * in-memory Connection fake that serves raw account bytes (Position, Market, DBC pool, Clock sysvar); timeouts run on
 * fake timers.
 */
import { Buffer } from 'node:buffer'
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionError,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  DBC_PROGRAM_ID,
  HAIRCUT_PER_EXIT,
  ROUTER_PROGRAM_ID,
  autoExitInstruction,
  decodeMarket,
  decodePosition,
  findBufferPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
  marketAccountsFor,
  refundFor,
  type MarketAccount,
  type PositionAccount,
  type QuoteMintInfo,
} from '@trucee/sdk'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MIN_ATA_VALUE_LAMPORTS, defaultCrankGuards, quoteMinimums, type CrankGuards, type QuoteMinimums } from '../src/config.js'
import type { CrankContext, CrankJobResult } from '../src/crank/index.js'
import {
  CONFIRM_TIMEOUT_MS,
  MAX_ATTEMPTS_PER_TX,
  RPC_TIMEOUT_MS,
  autoExitJob as defaultAutoExitJob,
  createAutoExitJob,
  planAutoExits,
  type AtaRule,
} from '../src/crank/jobs/auto-exit.js'

const cluster = getClusterConfig('localnet')
const NOW = 1_800_000_000n
const TOKENS = 5_000_000n
const BASIS = 1_000_000_000n
/** A basis whose refund is far below MIN_ATA_VALUE_LAMPORTS (0.25 SOL). */
const DUST_BASIS = 1_000_000n
const FUNDED_LAMPORTS = 10_000_000_000
/** No ATA rent guard: the CRK-05 tests are about exits; the CRK-10 tests pass their own guards. */
const OPEN_GUARDS: CrankGuards = Object.freeze({
  minAtaValueLamports: 0n,
  maxAtaCreatesPerTick: Number.MAX_SAFE_INTEGER,
  crankMinSolLamports: 0n,
  minMigrateThresholdSolLamports: 0n,
})
/** The same ATA minimum for every quote mint of the test cluster. */
const minimumsOf = (ataValue: bigint): ReadonlyMap<string, QuoteMinimums> =>
  new Map(cluster.quoteMints.map((quote) => [quote.mint.toBase58(), { ataValue, migrateThreshold: 0n }]))
const NO_ATAS: AtaRule = Object.freeze({ ownerQuoteAtaExists: new Map<string, boolean>(), quoteMinimums: minimumsOf(0n) })
const autoExitJob = createAutoExitJob(OPEN_GUARDS)
const LIVE = 0
/** DBC MigrationProgress: PostBondingCurve, LockedVesting, CreatedPool. */
const COMPLETE_STAGES = [1, 2, 3] as const

function quoteBy(symbol: QuoteMintInfo['symbol']): QuoteMintInfo {
  const quote = cluster.quoteMints.find((q) => q.symbol === symbol)
  if (quote === undefined) throw new Error(`no ${symbol} quote on localnet`)
  return quote
}

const SOL = quoteBy('SOL')
const TSLAX = quoteBy('TSLAx')

const randomKey = (): PublicKey => Keypair.generate().publicKey

function makeMarket(quote: QuoteMintInfo = SOL, overrides: Partial<MarketAccount> = {}): MarketAccount {
  const pool = randomKey()
  const address = findMarketPda(pool)
  return Object.freeze({
    address,
    pool,
    config: randomKey(),
    baseMint: randomKey(),
    quoteMint: quote.mint,
    baseVault: randomKey(),
    quoteVault: randomKey(),
    bufferVault: findBufferPda(address),
    feeNumerator: 10_000_000n,
    bump: 255,
    totalBasis: BASIS,
    finalized: false,
    surplusSnapshot: 0n,
    basisSnapshot: 0n,
    surplusClaimed: 0n,
    ...overrides,
  })
}

function makePosition(market: MarketAccount, overrides: Partial<PositionAccount> = {}): PositionAccount {
  const owner = overrides.owner ?? randomKey()
  return Object.freeze({
    address: findPositionPda(market.address, owner),
    owner,
    market: market.address,
    tokens: TOKENS,
    basis: BASIS,
    bump: 254,
    autoExitDeadline: NOW - 60n,
    ...overrides,
  })
}

interface Scenario {
  readonly positions: PositionAccount[]
  readonly markets: Map<string, MarketAccount>
  readonly poolProgress: Map<string, number>
}

function scenario(entries: readonly { market: MarketAccount; position: PositionAccount; progress?: number }[]): Scenario {
  return {
    positions: entries.map((e) => e.position),
    markets: new Map(entries.map((e) => [e.market.address.toBase58(), e.market])),
    poolProgress: new Map(entries.map((e) => [e.market.pool.toBase58(), e.progress ?? LIVE])),
  }
}

function plan(s: Scenario, payer: PublicKey, now: bigint = NOW, ata: AtaRule = NO_ATAS): TransactionInstruction[][] {
  return planAutoExits(s.positions, s.markets, s.poolProgress, now, payer, ata)
}

const normalize = (ix: TransactionInstruction) => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString('hex'),
})

function expectedExit(market: MarketAccount, quote: QuoteMintInfo, owner: PublicKey, payer: PublicKey): TransactionInstruction[] {
  const ownerQuote = getAssociatedTokenAddressSync(quote.mint, owner, false, quote.tokenProgram)
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, ownerQuote, owner, quote.mint, quote.tokenProgram),
    autoExitInstruction({ cluster, accounts: marketAccountsFor(market, quote.tokenProgram), cranker: payer, owner }),
  ]
}

describe('planAutoExits', () => {
  const payer = randomKey()

  it('skips a position whose deadline is 0 (Auto-Exit disabled)', () => {
    const market = makeMarket()
    const s = scenario([{ market, position: makePosition(market, { autoExitDeadline: 0n }) }])

    expect(plan(s, payer)).toEqual([])
  })

  it('skips a position in the old 89-byte layout (no deadline field)', () => {
    const market = makeMarket()
    const s = scenario([{ market, position: makePosition(market, { autoExitDeadline: null }) }])

    expect(plan(s, payer)).toEqual([])
  })

  it('skips a deadline still in the future of the chain clock', () => {
    const market = makeMarket()
    const s = scenario([{ market, position: makePosition(market, { autoExitDeadline: NOW + 1n }) }])

    expect(plan(s, payer)).toEqual([])
  })

  it('treats a deadline equal to now as due, like the router (now >= deadline)', () => {
    const market = makeMarket()
    const s = scenario([{ market, position: makePosition(market, { autoExitDeadline: NOW }) }])

    expect(plan(s, payer)).toHaveLength(1)
  })

  it('gives one transaction for a due deadline on a live curve: create quote ATA, then auto_exit', () => {
    const market = makeMarket()
    const position = makePosition(market)
    const s = scenario([{ market, position }])

    const txs = plan(s, payer)

    expect(txs).toHaveLength(1)
    expect(txs[0]?.map(normalize)).toEqual(expectedExit(market, SOL, position.owner, payer).map(normalize))
  })

  it.each(COMPLETE_STAGES)('skips a due deadline on a complete curve (migration progress %i)', (progress) => {
    const market = makeMarket()
    const s = scenario([{ market, position: makePosition(market), progress }])

    expect(plan(s, payer)).toEqual([])
  })

  it('skips a position with 0 tokens', () => {
    const market = makeMarket()
    const s = scenario([{ market, position: makePosition(market, { tokens: 0n }) }])

    expect(plan(s, payer)).toEqual([])
  })

  it("creates the owner's missing quote ATA, paid by the crank payer, before auto_exit refunds into it", () => {
    const market = makeMarket(SOL)
    const owner = randomKey() // a fresh owner: no quote ATA exists for it
    const position = makePosition(market, { owner })
    const ownerQuote = getAssociatedTokenAddressSync(SOL.mint, owner, false, TOKEN_PROGRAM_ID)

    const [createAta, exit] = plan(scenario([{ market, position }]), payer)[0] ?? []

    expect(createAta?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true)
    expect(Buffer.from(createAta?.data ?? []).toString('hex')).toBe('01') // CreateIdempotent
    expect(normalize(createAta!).keys).toEqual([
      { pubkey: payer.toBase58(), isSigner: true, isWritable: true },
      { pubkey: ownerQuote.toBase58(), isSigner: false, isWritable: true },
      { pubkey: owner.toBase58(), isSigner: false, isWritable: false },
      { pubkey: SOL.mint.toBase58(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
    ])
    expect(exit?.programId.equals(ROUTER_PROGRAM_ID)).toBe(true)
    expect(exit?.keys[0]?.pubkey.equals(payer)).toBe(true) // cranker signs, the owner does not
    expect(exit?.keys.some((k) => k.isSigner && k.pubkey.equals(owner))).toBe(false)
    expect(exit?.keys[4]?.pubkey.equals(ownerQuote)).toBe(true) // owner_quote is that same canonical ATA
  })

  it('derives the quote ATA under Token-2022 for an xStock quote', () => {
    const market = makeMarket(TSLAX)
    const position = makePosition(market)
    const s = scenario([{ market, position }])

    const txs = plan(s, payer)

    expect(txs[0]?.map(normalize)).toEqual(expectedExit(market, TSLAX, position.owner, payer).map(normalize))
    expect(txs[0]?.[0]?.keys[5]?.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
  })

  it('skips a position whose market or pool progress was not fetched', () => {
    const market = makeMarket()
    const position = makePosition(market)
    const noMarket: Scenario = { ...scenario([{ market, position }]), markets: new Map() }
    const noProgress: Scenario = { ...scenario([{ market, position }]), poolProgress: new Map() }

    expect(plan(noMarket, payer)).toEqual([])
    expect(plan(noProgress, payer)).toEqual([])
  })

  it('skips a finalized market and a market whose quote mint the router does not allow', () => {
    const finalized = makeMarket(SOL, { finalized: true })
    const unknownQuote = makeMarket(SOL, { quoteMint: randomKey() })
    const s = scenario([
      { market: finalized, position: makePosition(finalized) },
      { market: unknownQuote, position: makePosition(unknownQuote) },
    ])

    expect(plan(s, payer)).toEqual([])
  })

  it('gives one transaction per due position, the most overdue first', () => {
    const [a, b, c] = [makeMarket(), makeMarket(TSLAX), makeMarket()] as const
    const late = makePosition(a, { autoExitDeadline: NOW - 10n })
    const latest = makePosition(b, { autoExitDeadline: NOW - 1_000n })
    const notYet = makePosition(c, { autoExitDeadline: NOW + 10n })
    const s = scenario([
      { market: a, position: late },
      { market: b, position: latest },
      { market: c, position: notYet },
    ])

    const txs = plan(s, payer)

    expect(txs).toHaveLength(2)
    expect(txs.map((tx) => tx[1]?.keys[3]?.pubkey.toBase58())).toEqual([latest.address.toBase58(), late.address.toBase58()])
  })

  it('does not mutate its inputs', () => {
    const market = makeMarket()
    const s = scenario([{ market, position: makePosition(market, { autoExitDeadline: NOW - 1n }) }, { market, position: makePosition(market, { autoExitDeadline: NOW - 9n }) }])
    const positions = Object.freeze([...s.positions]) as PositionAccount[]

    expect(() => planAutoExits(positions, s.markets, s.poolProgress, NOW, payer, NO_ATAS)).not.toThrow()
    expect(positions).toEqual(s.positions)
  })

  describe('owner quote ATA rent (CRK-10)', () => {
    const ataOf = (position: PositionAccount): string =>
      getAssociatedTokenAddressSync(SOL.mint, position.owner, false, SOL.tokenProgram).toBase58()
    const rule = (minAtaValue: bigint, existing: readonly PositionAccount[] = []): AtaRule => ({
      ownerQuoteAtaExists: new Map(existing.map((position) => [ataOf(position), true])),
      quoteMinimums: minimumsOf(minAtaValue),
    })
    /** feeNumerator 0, so refund = basis - HAIRCUT_PER_EXIT: the payout is set exactly. */
    const payoutEntry = (quote: QuoteMintInfo, payout: bigint) => {
      const market = makeMarket(quote, { feeNumerator: 0n })
      return { market, position: makePosition(market, { basis: payout + HAIRCUT_PER_EXIT }) }
    }

    it.each([
      ['wSOL, the 0.25 SOL default', SOL, 249_999_999n, 250_000_000n],
      ['xStock, 0.1 share (raw units)', TSLAX, 9_000_000n, 10_000_000n],
    ])('with the default minimums (%s), skips a missing ATA just below the minimum and creates it at the minimum', (_, quote, below, atMin) => {
      const ata: AtaRule = { ownerQuoteAtaExists: new Map(), quoteMinimums: quoteMinimums(defaultCrankGuards('localnet'), cluster.quoteMints) }
      const [skipped, created] = [below, atMin].map((payout) => payoutEntry(quote, payout))

      expect(refundFor(created!.position.basis, 0n)).toBe(atMin)
      expect(plan(scenario([skipped!]), payer, NOW, ata)).toEqual([])
      expect(plan(scenario([created!]), payer, NOW, ata).map((tx) => tx.map(normalize))).toEqual([
        expectedExit(created!.market, quote, created!.position.owner, payer).map(normalize),
      ])
    })

    it('plans no instructions for a missing ATA whose refund is below MIN_ATA_VALUE_LAMPORTS', () => {
      const market = makeMarket()
      const s = scenario([{ market, position: makePosition(market, { basis: DUST_BASIS }) }])

      expect(plan(s, payer, NOW, rule(DEFAULT_MIN_ATA_VALUE_LAMPORTS))).toEqual([])
    })

    it('creates a missing ATA, then exits, once refundFor(basis, fee) reaches MIN_ATA_VALUE_LAMPORTS', () => {
      const market = makeMarket()
      const position = makePosition(market)
      const s = scenario([{ market, position }])
      const refund = refundFor(position.basis, market.feeNumerator)

      expect(plan(s, payer, NOW, rule(refund)).map((tx) => tx.map(normalize))).toEqual([
        expectedExit(market, SOL, position.owner, payer).map(normalize),
      ])
      expect(plan(s, payer, NOW, rule(refund + 1n))).toEqual([])
    })

    it('exits a dust position with no ATA create when its quote ATA exists (no threshold)', () => {
      const market = makeMarket()
      const position = makePosition(market, { basis: 1n })

      const txs = plan(scenario([{ market, position }]), payer, NOW, rule(DEFAULT_MIN_ATA_VALUE_LAMPORTS, [position]))

      expect(txs.map((tx) => tx.map(normalize))).toEqual([expectedExit(market, SOL, position.owner, payer).slice(1).map(normalize)])
    })

    it('skips, without throwing, an owner off the ed25519 curve (it has no canonical ATA)', () => {
      const market = makeMarket()
      const s = scenario([{ market, position: makePosition(market, { owner: findMarketPda(randomKey()) }) }])

      expect(plan(s, payer)).toEqual([])
    })
  })
})

/* ---------- autoExitJob.run against an in-memory chain ---------- */

const POSITION_DISCRIMINATOR = [170, 188, 143, 228, 122, 64, 247, 208]
const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154]
const POSITION_SIZE = 97
const MARKET_SIZE = 274
const POOL_SIZE = 416
const POOL_PROGRESS_OFFSET = 308
const CLOCK_SIZE = 40
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32
const INVALID_EXIT_AMOUNT = 6007
const AUTO_EXIT_NOT_DUE = 6020
const AUTO_EXIT_CURVE_COMPLETE = 6021
const BUFFER_INSUFFICIENT = 6015
const RPC_KEY = 'FAKEKEY0123456789abcdef'
const RPC_ERROR = `failed to get info: request to https://rpc.example.invalid/v2/${RPC_KEY}?api-key=${RPC_KEY} failed, reason: ECONNRESET`
/** Far past the wall clock, so only a job that reads the chain clock sees these deadlines as due. */
const CHAIN_NOW = 4_000_000_000n

function encodePosition(p: PositionAccount): Buffer {
  const data = Buffer.alloc(POSITION_SIZE)
  Buffer.from(POSITION_DISCRIMINATOR).copy(data, 0)
  p.owner.toBuffer().copy(data, 8)
  p.market.toBuffer().copy(data, 40)
  data.writeBigUInt64LE(p.tokens, 72)
  data.writeBigUInt64LE(p.basis, 80)
  data.writeUInt8(p.bump, 88)
  data.writeBigInt64LE(p.autoExitDeadline ?? 0n, 89)
  return data
}

function encodeMarket(m: MarketAccount): Buffer {
  const data = Buffer.alloc(MARKET_SIZE)
  Buffer.from(MARKET_DISCRIMINATOR).copy(data, 0)
  const keys = [m.pool, m.config, m.baseMint, m.quoteMint, m.baseVault, m.quoteVault, m.bufferVault]
  keys.forEach((key, i) => key.toBuffer().copy(data, 8 + 32 * i))
  data.writeBigUInt64LE(m.feeNumerator, 232)
  data.writeUInt8(m.bump, 240)
  data.writeBigUInt64LE(m.totalBasis, 241)
  data.writeUInt8(m.finalized ? 1 : 0, 249)
  return data
}

function encodePool(progress: number): Buffer {
  const data = Buffer.alloc(POOL_SIZE)
  data.writeUInt8(progress, POOL_PROGRESS_OFFSET)
  return data
}

function encodeClock(unixTimestamp: bigint): Buffer {
  const data = Buffer.alloc(CLOCK_SIZE)
  data.writeBigInt64LE(unixTimestamp, CLOCK_UNIX_TIMESTAMP_OFFSET)
  return data
}

interface SimulationValue {
  readonly err: TransactionError | null
  readonly logs: string[]
}

interface RawAccount {
  readonly data: Buffer
  readonly owner: PublicKey
}

interface Chain {
  readonly positions: readonly { address: PublicKey; data: Buffer }[]
  readonly accounts: ReadonlyMap<string, RawAccount>
  /** The Clock sysvar's data; null when the account is missing. */
  readonly clock: Buffer | null
  readonly simulate?: (tx: VersionedTransaction, index: number) => SimulationValue
  readonly confirmErr?: TransactionError | null
  /** The crank payer's lamports; FUNDED_LAMPORTS when absent. */
  readonly payerBalance?: number
}

const accountInfo = (data: Buffer, owner: PublicKey = ROUTER_PROGRAM_ID) => ({ data, owner, lamports: 1_000_000, executable: false, rentEpoch: 0 })
/** A request that never answers, for the timeout tests. */
const hang = <T>(): Promise<T> => new Promise<T>(() => undefined)

function fakeConnection(chain: Chain) {
  const simulated: VersionedTransaction[] = []
  const sent: VersionedTransaction[] = []
  const blockhashes: string[] = []
  const fake = {
    getBalance: vi.fn(async (_key: PublicKey, _commitment?: unknown) => chain.payerBalance ?? FUNDED_LAMPORTS),
    getProgramAccounts: vi.fn(async (_programId: PublicKey, _config?: unknown) =>
      chain.positions.map(({ address, data }) => ({ pubkey: address, account: accountInfo(data) })),
    ),
    getAccountInfo: vi.fn(async (key: PublicKey, _commitment?: unknown) =>
      key.equals(SYSVAR_CLOCK_PUBKEY) && chain.clock !== null ? accountInfo(chain.clock) : null,
    ),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[], _commitment?: unknown) =>
      keys.map((key) => {
        const account = chain.accounts.get(key.toBase58())
        return account === undefined ? null : accountInfo(account.data, account.owner)
      }),
    ),
    getLatestBlockhash: vi.fn(async (_commitment?: unknown) => {
      blockhashes.push(randomKey().toBase58())
      return { blockhash: blockhashes[blockhashes.length - 1] ?? '', lastValidBlockHeight: 1_000 }
    }),
    simulateTransaction: vi.fn(async (tx: VersionedTransaction, _config?: unknown) => {
      simulated.push(tx)
      const value = chain.simulate?.(tx, simulated.length - 1) ?? { err: null, logs: [] }
      return { context: { slot: 1 }, value }
    }),
    sendRawTransaction: vi.fn(async (raw: Uint8Array, _options?: unknown) => {
      sent.push(VersionedTransaction.deserialize(raw))
      return `sig-${sent.length}`
    }),
    confirmTransaction: vi.fn(async (_strategy: unknown, _commitment?: unknown) => ({
      context: { slot: 2 },
      value: { err: chain.confirmErr ?? null },
    })),
  }
  return { connection: fake as unknown as Connection, fake, simulated, sent, blockhashes }
}

const failedLine = (program: PublicKey, code: number): string =>
  `Program ${program.toBase58()} failed: custom program error: 0x${code.toString(16)}`

function routerFailure(code: number): SimulationValue {
  const router = ROUTER_PROGRAM_ID.toBase58()
  return { err: { InstructionError: [1, { Custom: code }] }, logs: [`Program ${router} invoke [1]`, failedLine(ROUTER_PROGRAM_ID, code)] }
}

/** The same code, but raised by the DBC swap CPI: the innermost failure is logged first. */
function dbcFailure(code: number): SimulationValue {
  const logs = [`Program ${ROUTER_PROGRAM_ID.toBase58()} invoke [1]`, `Program ${DBC_PROGRAM_ID.toBase58()} invoke [2]`, failedLine(DBC_PROGRAM_ID, code), failedLine(ROUTER_PROGRAM_ID, code)]
  return { err: { InstructionError: [1, { Custom: code }] }, logs }
}

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

function context(connection: Connection, payer: Keypair, maxTx = 10, log = fakeLog()): CrankContext {
  return { connection, payer, cluster, log, maxTx }
}

interface ChainEntry {
  readonly market: MarketAccount
  readonly position: PositionAccount
  readonly progress?: number
}

function chainOf(entries: readonly ChainEntry[], overrides: Partial<Chain> = {}): Chain {
  const accounts = new Map<string, RawAccount>()
  entries.forEach(({ market, progress }) => {
    accounts.set(market.address.toBase58(), { data: encodeMarket(market), owner: ROUTER_PROGRAM_ID })
    accounts.set(market.pool.toBase58(), { data: encodePool(progress ?? LIVE), owner: DBC_PROGRAM_ID })
  })
  return {
    positions: entries.map(({ position }) => ({ address: position.address, data: encodePosition(position) })),
    accounts,
    clock: encodeClock(CHAIN_NOW),
    ...overrides,
  }
}

const dueEntry = (deadline: bigint = CHAIN_NOW - 5n, quote: QuoteMintInfo = SOL): ChainEntry => {
  const market = makeMarket(quote)
  return { market, position: makePosition(market, { autoExitDeadline: deadline }) }
}

const dueEntries = (count: number): ChainEntry[] => Array.from({ length: count }, (_, i) => dueEntry(CHAIN_NOW - 100n + BigInt(i)))

const signatureOf = (tx: VersionedTransaction | undefined): string => Buffer.from(tx?.signatures[0] ?? []).toString('hex')

interface TimedRun {
  readonly result: CrankJobResult
  /** Whether the run had settled 1 ms before `ms`. */
  readonly settledEarly: boolean
  readonly timersLeft: number
}

/** Runs the job on fake timers and advances them to just before, then exactly to, `ms`. */
async function runOnFakeTimers(ms: number, start: () => Promise<CrankJobResult>): Promise<TimedRun> {
  vi.useFakeTimers()
  try {
    let settled = false
    const pending = start().finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(ms - 1)
    const settledEarly = settled
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    return { result, settledEarly, timersLeft: vi.getTimerCount() }
  } finally {
    vi.useRealTimers()
  }
}

describe('autoExitJob', () => {
  it("is named 'auto-exit'", () => {
    expect(autoExitJob.name).toBe('auto-exit')
  })

  it('the test encoders round-trip through the SDK decoders', () => {
    const { market, position } = dueEntry()

    expect(decodePosition(position.address, encodePosition(position))).toEqual(position)
    expect(decodeMarket(market.address, encodeMarket(market))).toEqual(market)
  })

  it('fetches Position accounts by discriminator, then simulates and sends one signed auto-exit transaction', async () => {
    const payer = Keypair.generate()
    const chain = fakeConnection(chainOf([dueEntry()]))

    const result = await autoExitJob.run(context(chain.connection, payer))

    expect(result).toEqual({ sent: ['sig-1'], skipped: 0, errors: [] })
    const [programId, config] = chain.fake.getProgramAccounts.mock.calls[0] as unknown as [PublicKey, { filters: unknown[] }]
    expect(programId.equals(cluster.routerProgramId)).toBe(true)
    expect(config.filters).toEqual([
      { memcmp: { offset: 0, bytes: Buffer.from(POSITION_DISCRIMINATOR).toString('base64'), encoding: 'base64' } },
    ])
    const tx = chain.sent[0]
    expect(signatureOf(tx)).toBe(signatureOf(chain.simulated[0])) // exactly the simulated transaction
    expect(tx?.message.staticAccountKeys[0]?.equals(payer.publicKey)).toBe(true) // the crank pays
    expect(tx?.signatures[0]?.some((byte) => byte !== 0)).toBe(true) // and signs
    const programs = tx?.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58())
    expect(programs).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), ROUTER_PROGRAM_ID.toBase58()])
    expect(chain.fake.sendRawTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), { skipPreflight: true })
    expect(chain.fake.confirmTransaction).toHaveBeenCalledTimes(1)
  })

  it("sends the idempotent create of a missing owner quote ATA, paid by the crank, before auto_exit", async () => {
    const payer = Keypair.generate()
    const entry = dueEntry(CHAIN_NOW - 5n, TSLAX)
    const owner = entry.position.owner // fresh owner: the fake chain has no ATA for it
    const ownerQuote = getAssociatedTokenAddressSync(TSLAX.mint, owner, false, TOKEN_2022_PROGRAM_ID)
    const chain = fakeConnection(chainOf([entry]))

    await autoExitJob.run(context(chain.connection, payer))

    const [createAta, exit] = TransactionMessage.decompile(chain.sent[0]!.message).instructions
    const expected = createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ownerQuote, owner, TSLAX.mint, TOKEN_2022_PROGRAM_ID)
    expect(normalize(createAta!)).toEqual(normalize(expected))
    expect(exit?.keys[4]?.pubkey.equals(ownerQuote)).toBe(true)
  })

  it('reads now from the chain Clock sysvar, not the wall clock', async () => {
    const notYetOnChain = fakeConnection(chainOf([dueEntry(CHAIN_NOW + 1n)]))
    const dueOnChain = fakeConnection(chainOf([dueEntry(CHAIN_NOW)]))

    const before = await autoExitJob.run(context(notYetOnChain.connection, Keypair.generate()))
    const after = await autoExitJob.run(context(dueOnChain.connection, Keypair.generate()))

    expect(before).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(notYetOnChain.fake.simulateTransaction).not.toHaveBeenCalled()
    expect(after.sent).toHaveLength(1)
    expect(dueOnChain.fake.getAccountInfo.mock.calls[0]?.[0]).toBe(SYSVAR_CLOCK_PUBKEY)
  })

  it.each([
    ['missing', null],
    ['too short', Buffer.alloc(CLOCK_SIZE - 1)],
  ])('reports a %s Clock sysvar as an error and sends nothing', async (_, clock) => {
    const chain = fakeConnection(chainOf([dueEntry()], { clock }))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining('Clock sysvar')] })
    expect(chain.fake.simulateTransaction).not.toHaveBeenCalled()
  })

  it('does not simulate a due position on a complete curve', async () => {
    const chain = fakeConnection(chainOf([{ ...dueEntry(), progress: 2 }]))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(chain.fake.simulateTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['InvalidExitAmount', INVALID_EXIT_AMOUNT],
    ['AutoExitNotDue', AUTO_EXIT_NOT_DUE],
    ['AutoExitCurveComplete', AUTO_EXIT_CURVE_COMPLETE],
  ])('counts a router %s simulation failure as skipped (info), not an error', async (name, code) => {
    const log = fakeLog()
    const chain = fakeConnection(chainOf([dueEntry()], { simulate: () => routerFailure(code) }))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate(), 10, log))

    expect(result).toEqual({ sent: [], skipped: 1, errors: [] })
    expect(chain.fake.sendRawTransaction).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: name }))
    expect(log.warn).not.toHaveBeenCalled()
  })

  it.each([
    ['raised by the DBC CPI', dbcFailure(AUTO_EXIT_NOT_DUE)],
    ['with no logs to attribute it', { err: { InstructionError: [1, { Custom: AUTO_EXIT_NOT_DUE }] }, logs: [] }],
  ])('treats a race code %s as an error, not a race', async (_, failure) => {
    const chain = fakeConnection(chainOf([dueEntry()], { simulate: () => failure }))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result.skipped).toBe(0)
    expect(result.errors).toEqual([expect.stringContaining('simulation failed')])
  })

  it('records any other simulation failure as an error, skips that position and goes on with the next', async () => {
    const log = fakeLog()
    const entries = [dueEntry(CHAIN_NOW - 50n), dueEntry(CHAIN_NOW - 10n)]
    const simulate = (_tx: VersionedTransaction, index: number) =>
      index === 0 ? routerFailure(BUFFER_INSUFFICIENT) : { err: null, logs: [] }
    const chain = fakeConnection(chainOf(entries, { simulate }))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate(), 10, log))

    expect(result.sent).toEqual(['sig-1'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('BufferInsufficient')
    expect(result.errors[0]).toContain(entries[0]?.position.address.toBase58())
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('sends at most ctx.maxTx transactions and counts the rest as skipped', async () => {
    const chain = fakeConnection(chainOf([dueEntry(), dueEntry(), dueEntry(CHAIN_NOW - 1n, TSLAX)]))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate(), 1))

    expect(result).toEqual({ sent: ['sig-1'], skipped: 2, errors: [] })
    expect(chain.sent).toHaveLength(1)
  })

  it('simulates at most ctx.maxTx * 3 exits per tick and counts the rest as skipped', async () => {
    const maxTx = 2
    const chain = fakeConnection(chainOf(dueEntries(10), { simulate: () => routerFailure(BUFFER_INSUFFICIENT) }))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate(), maxTx))

    expect(MAX_ATTEMPTS_PER_TX).toBe(3)
    expect(chain.fake.simulateTransaction).toHaveBeenCalledTimes(maxTx * MAX_ATTEMPTS_PER_TX)
    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(maxTx * MAX_ATTEMPTS_PER_TX)
    expect(result.skipped).toBe(10 - maxTx * MAX_ATTEMPTS_PER_TX)
  })

  it('fetches one blockhash per tick and reuses it for every exit', async () => {
    const chain = fakeConnection(chainOf(dueEntries(3)))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result.sent).toHaveLength(3)
    expect(chain.fake.getLatestBlockhash).toHaveBeenCalledTimes(1)
    expect(chain.sent.map((tx) => tx.message.recentBlockhash)).toEqual([chain.blockhashes[0], chain.blockhashes[0], chain.blockhashes[0]])
  })

  it('refreshes the blockhash once and retries when the simulation reports it expired', async () => {
    const simulate = (_tx: VersionedTransaction, index: number): SimulationValue =>
      index === 0 ? { err: 'BlockhashNotFound', logs: [] } : { err: null, logs: [] }
    const chain = fakeConnection(chainOf(dueEntries(2), { simulate }))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result).toEqual({ sent: ['sig-1', 'sig-2'], skipped: 0, errors: [] })
    expect(chain.fake.getLatestBlockhash).toHaveBeenCalledTimes(2)
    expect(chain.sent.map((tx) => tx.message.recentBlockhash)).toEqual([chain.blockhashes[1], chain.blockhashes[1]])
  })

  it('refreshes the blockhash once and resends when the send fails with "blockhash not found"', async () => {
    const chain = fakeConnection(chainOf([dueEntry()]))
    chain.fake.sendRawTransaction.mockRejectedValueOnce(new Error('Transaction simulation failed: Blockhash not found'))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result).toEqual({ sent: ['sig-1'], skipped: 0, errors: [] })
    expect(chain.fake.getLatestBlockhash).toHaveBeenCalledTimes(2)
    expect(chain.sent[0]?.message.recentBlockhash).toBe(chain.blockhashes[1])
  })

  it('does nothing when the tick has no transaction budget left', async () => {
    const chain = fakeConnection(chainOf([dueEntry()]))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate(), 0))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(chain.fake.getProgramAccounts).not.toHaveBeenCalled()
  })

  it('records a transaction that fails on chain as an error, not as sent', async () => {
    const chain = fakeConnection(chainOf([dueEntry()], { confirmErr: { InstructionError: [1, { Custom: BUFFER_INSUFFICIENT }] } }))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result.sent).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('sig-1')])
  })

  it('records an undecodable Position account as an error and still exits the others', async () => {
    const base = chainOf([dueEntry()])
    const garbage = { address: randomKey(), data: Buffer.from([...POSITION_DISCRIMINATOR, 1, 2, 3]) }
    const chain = fakeConnection({ ...base, positions: [garbage, ...base.positions] })

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result.sent).toEqual(['sig-1'])
    expect(result.errors).toEqual([expect.stringContaining(garbage.address.toBase58())])
  })

  it('does not decode a market account the router does not own', async () => {
    const entry = dueEntry()
    const base = chainOf([entry])
    const market = entry.market.address.toBase58()
    const accounts = new Map([...base.accounts, [market, { data: encodeMarket(entry.market), owner: randomKey() }]])
    const chain = fakeConnection({ ...base, accounts })

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining(market)] })
    expect(chain.fake.simulateTransaction).not.toHaveBeenCalled()
  })

  it('does not read the progress byte of a pool account the DBC program does not own', async () => {
    const entry = dueEntry()
    const base = chainOf([entry])
    const pool = entry.market.pool.toBase58()
    const accounts = new Map([...base.accounts, [pool, { data: encodePool(LIVE), owner: randomKey() }]])
    const chain = fakeConnection({ ...base, accounts })

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining(pool)] })
    expect(chain.fake.simulateTransaction).not.toHaveBeenCalled()
  })

  it('gives up on a confirmation after 45 s, logs the outcome as unknown and does not resend it', async () => {
    const log = fakeLog()
    const chain = fakeConnection(chainOf([dueEntry()]))
    chain.fake.confirmTransaction.mockImplementationOnce(hang)

    const run = await runOnFakeTimers(CONFIRM_TIMEOUT_MS, () => autoExitJob.run(context(chain.connection, Keypair.generate(), 10, log)))

    expect(run.settledEarly).toBe(false)
    expect(run.result.sent).toEqual([])
    expect(run.result.errors).toEqual([expect.stringMatching(/sig-1 not confirmed .* outcome unknown/)])
    expect(chain.fake.sendRawTransaction).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unknown'), expect.objectContaining({ reason: expect.stringContaining('sig-1') }))
    expect(run.timersLeft).toBe(0)
  })

  it.each([
    'getBalance',
    'getProgramAccounts',
    'getAccountInfo',
    'getMultipleAccountsInfo',
    'getLatestBlockhash',
  ] as const)('bounds %s at 30 s: a timeout becomes an error and nothing is sent', async (call) => {
    const chain = fakeConnection(chainOf([dueEntry()]))
    chain.fake[call].mockImplementationOnce(hang)

    const run = await runOnFakeTimers(RPC_TIMEOUT_MS, () => autoExitJob.run(context(chain.connection, Keypair.generate())))

    expect(run.settledEarly).toBe(false)
    expect(run.result.sent).toEqual([])
    expect(run.result.errors).toEqual([expect.stringContaining(`timed out after ${RPC_TIMEOUT_MS} ms`)])
    expect(chain.fake.sendRawTransaction).not.toHaveBeenCalled()
    expect(run.timersLeft).toBe(0)
  })

  it('bounds simulateTransaction at 30 s and stops the tick: the RPC is stalled', async () => {
    const chain = fakeConnection(chainOf(dueEntries(2)))
    chain.fake.simulateTransaction.mockImplementationOnce(hang)

    const run = await runOnFakeTimers(RPC_TIMEOUT_MS, () => autoExitJob.run(context(chain.connection, Keypair.generate())))

    expect(run.settledEarly).toBe(false)
    expect(run.result).toEqual({ sent: [], skipped: 1, errors: [expect.stringContaining('simulateTransaction timed out')] })
    expect(chain.fake.simulateTransaction).toHaveBeenCalledTimes(1)
    expect(chain.fake.sendRawTransaction).not.toHaveBeenCalled()
  })

  it('bounds the send at 30 s: the outcome is unknown, it is not resent and the tick stops', async () => {
    const log = fakeLog()
    const chain = fakeConnection(chainOf(dueEntries(2)))
    chain.fake.sendRawTransaction.mockImplementationOnce(hang)

    const run = await runOnFakeTimers(RPC_TIMEOUT_MS, () => autoExitJob.run(context(chain.connection, Keypair.generate(), 10, log)))

    expect(run.settledEarly).toBe(false)
    expect(run.result).toEqual({ sent: [], skipped: 1, errors: [expect.stringMatching(/sendRawTransaction timed out .* outcome unknown/)] })
    expect(chain.fake.sendRawTransaction).toHaveBeenCalledTimes(1)
    expect(chain.fake.confirmTransaction).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unknown'), expect.any(Object))
    expect(run.timersLeft).toBe(0)
  })

  it('reduces RPC URLs in error strings to their host, so a provider key never reaches result.errors', async () => {
    const fetchFails = fakeConnection(chainOf([dueEntry()]))
    fetchFails.fake.getProgramAccounts.mockRejectedValueOnce(new Error(RPC_ERROR))
    const sendFails = fakeConnection(chainOf([dueEntry()]))
    sendFails.fake.sendRawTransaction.mockRejectedValueOnce(new Error(RPC_ERROR))

    const results = [
      await autoExitJob.run(context(fetchFails.connection, Keypair.generate())),
      await autoExitJob.run(context(sendFails.connection, Keypair.generate())),
    ]

    results.forEach((result) => {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('rpc.example.invalid')
      expect(result.errors[0]).not.toContain(RPC_KEY)
    })
  })

  it('never throws: an RPC failure becomes an error in the result', async () => {
    const chain = fakeConnection(chainOf([dueEntry()]))
    chain.fake.getProgramAccounts.mockRejectedValueOnce(new Error('429 Too Many Requests'))

    const result = await autoExitJob.run(context(chain.connection, Keypair.generate()))

    expect(result.sent).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('429 Too Many Requests')])
  })

  it('never throws when the cluster config cannot be resolved', async () => {
    const chain = fakeConnection(chainOf([dueEntry()]))
    const ctx = Object.defineProperty({ ...context(chain.connection, Keypair.generate()) }, 'cluster', {
      get: () => {
        throw new Error('no cluster config')
      },
    })

    await expect(autoExitJob.run(ctx)).resolves.toEqual({ sent: [], skipped: 0, errors: [expect.stringContaining('no cluster config')] })
  })
})

describe('autoExitJob ATA rent and payer guards (CRK-10)', () => {
  const guards = (overrides: Partial<CrankGuards> = {}): CrankGuards => ({ ...OPEN_GUARDS, minAtaValueLamports: DEFAULT_MIN_ATA_VALUE_LAMPORTS, maxAtaCreatesPerTick: 2, ...overrides })
  const dustEntry = (deadline: bigint): ChainEntry => {
    const market = makeMarket()
    return { market, position: makePosition(market, { autoExitDeadline: deadline, basis: DUST_BASIS }) }
  }
  const instructionsOf = (tx: VersionedTransaction | undefined) => (tx === undefined ? [] : TransactionMessage.decompile(tx.message).instructions)
  const createsAta = (tx: VersionedTransaction): boolean => instructionsOf(tx).some((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
  const withAccountAt = (chain: Chain, address: PublicKey, owner: PublicKey): Chain =>
    ({ ...chain, accounts: new Map([...chain.accounts, [address.toBase58(), { data: Buffer.alloc(165), owner }]]) })

  it('creates at most MAX_ATA_CREATES_PER_TICK missing ATAs per tick and logs the rest once', async () => {
    const log = fakeLog()
    const chain = fakeConnection(chainOf(dueEntries(3)))

    const result = await createAutoExitJob(guards()).run(context(chain.connection, Keypair.generate(), 10, log))

    expect(result).toEqual({ sent: ['sig-1', 'sig-2'], skipped: 1, errors: [] })
    expect(chain.sent.filter(createsAta)).toHaveLength(2)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('quote ATA missing'), expect.objectContaining({ belowMinValue: 0, overCreateCap: 1 }))
  })

  it.each([
    ['owned by the quote token program, exits it without an ATA create', TOKEN_PROGRAM_ID, ['sig-1']],
    ['owned by the system program (lamports sent to it), treats it as missing and skips the dust', SystemProgram.programId, []],
  ])('for a dust refund and an account at the quote ATA address %s', async (_, owner, sent) => {
    const entry = dustEntry(CHAIN_NOW - 5n)
    const ata = getAssociatedTokenAddressSync(SOL.mint, entry.position.owner, false, TOKEN_PROGRAM_ID)
    const chain = fakeConnection(withAccountAt(chainOf([entry]), ata, owner))

    const result = await createAutoExitJob(guards()).run(context(chain.connection, Keypair.generate()))

    expect(result.sent).toEqual(sent)
    expect(chain.sent.filter(createsAta)).toEqual([])
    expect(chain.fake.getMultipleAccountsInfo.mock.calls.some(([keys]) => keys.some((key) => key.equals(ata)))).toBe(true)
  })

  it('logs once and plans nothing while the payer holds less than CRANK_MIN_SOL_LAMPORTS (default 0.05 SOL)', async () => {
    const payer = Keypair.generate()
    const [below, atFloor] = [49_999_999, 50_000_000].map((payerBalance) => fakeConnection(chainOf([dueEntry()], { payerBalance })))
    const log = fakeLog()

    const skipped = await defaultAutoExitJob.run(context(below!.connection, payer, 10, log))
    const ran = await defaultAutoExitJob.run(context(atFloor!.connection, payer))

    expect(skipped).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(below!.fake.getBalance).toHaveBeenCalledWith(payer.publicKey, 'confirmed')
    expect(below!.fake.getProgramAccounts).not.toHaveBeenCalled()
    expect([log.info, log.warn, log.error].map((fn) => fn.mock.calls.length)).toEqual([0, 1, 0])
    expect(ran.sent).toEqual(['sig-1'])
  })

  it('counts an off-curve owner as skipped every tick and warns once per position for the job instance', async () => {
    const market = makeMarket()
    const position = makePosition(market, { owner: findMarketPda(randomKey()), autoExitDeadline: CHAIN_NOW - 5n })
    const chain = fakeConnection(chainOf([{ market, position }]))
    const log = fakeLog()
    const job = createAutoExitJob(guards())

    const first = await job.run(context(chain.connection, Keypair.generate(), 10, log))
    const second = await job.run(context(chain.connection, Keypair.generate(), 10, log))

    expect([first, second]).toEqual([{ sent: [], skipped: 1, errors: [] }, { sent: [], skipped: 1, errors: [] }])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('off curve'), expect.objectContaining({ position: position.address.toBase58() }))
    expect(chain.fake.simulateTransaction).not.toHaveBeenCalled()
  })

  it('skips positions whose quote mint has no crank minimums and warns once per mint for the job instance', async () => {
    const market = makeMarket(SOL, { quoteMint: randomKey() })
    const chain = fakeConnection(chainOf([{ market, position: makePosition(market, { autoExitDeadline: CHAIN_NOW - 5n }) }]))
    const log = fakeLog()
    const job = createAutoExitJob(guards())

    const first = await job.run(context(chain.connection, Keypair.generate(), 10, log))
    const second = await job.run(context(chain.connection, Keypair.generate(), 10, log))

    expect([first, second]).toEqual([{ sent: [], skipped: 1, errors: [] }, { sent: [], skipped: 1, errors: [] }])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('quote mint'), expect.objectContaining({ quoteMint: market.quoteMint.toBase58() }))
  })

  it('exits a real overdue position this tick even behind 50 dust positions with earlier deadlines', async () => {
    const dust = Array.from({ length: 50 }, (_, i) => dustEntry(CHAIN_NOW - 1_000n + BigInt(i)))
    const real = dueEntry(CHAIN_NOW - 5n)
    const chain = fakeConnection(chainOf([...dust, real]))

    const result = await createAutoExitJob(guards()).run(context(chain.connection, Keypair.generate(), 1))

    expect(result).toEqual({ sent: ['sig-1'], skipped: 50, errors: [] })
    expect(chain.fake.simulateTransaction).toHaveBeenCalledTimes(1)
    expect(instructionsOf(chain.sent[0])[1]?.keys[3]?.pubkey.equals(real.position.address)).toBe(true)
  })
})
