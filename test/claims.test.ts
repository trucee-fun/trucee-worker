/**
 * The claims crank job. planClaims is tested with synthetic decoded accounts; claimsJob.run is tested
 * against an in-memory fake of the few Connection methods it uses (no network).
 */
import { Buffer } from 'node:buffer'
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type AccountInfo,
  type Commitment,
  type Connection,
  type GetProgramAccountsConfig,
  type GetProgramAccountsFilter,
  type VersionedTransaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  claimSurplusInstruction,
  decodePosition,
  fetchAllMarkets,
  findBufferPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
  type ClaimParams,
  type ClusterConfig,
  type MarketAccount,
  type PositionAccount,
} from '@trucee/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MIN_ATA_VALUE_LAMPORTS, type CrankGuards } from '../src/config.js'
import type { CrankContext } from '../src/crank/index.js'
import {
  CONFIRM_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  claimsJob as defaultClaimsJob,
  createBoundedKeySet,
  createClaimsJob,
  planClaims,
} from '../src/crank/jobs/claims.js'

// Wrapped, still the real functions: one test makes claimSurplusInstruction pay the wrong account, and the
// legacy-account tests record what decodePosition is handed and what fetchAllMarkets returns.
vi.mock('@trucee/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@trucee/sdk')>()
  return {
    ...actual,
    claimSurplusInstruction: vi.fn(actual.claimSurplusInstruction),
    decodePosition: vi.fn(actual.decodePosition),
    fetchAllMarkets: vi.fn(actual.fetchAllMarkets),
  }
})

afterEach(() => {
  vi.useRealTimers()
})

const CLUSTER: ClusterConfig = getClusterConfig('localnet')
const ROUTER = CLUSTER.routerProgramId
const TSLAX_MINT = new PublicKey('XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB')

const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154]
const POSITION_DISCRIMINATOR = [170, 188, 143, 228, 122, 64, 247, 208]
const CLAIM_SURPLUS_DISCRIMINATOR = [195, 35, 205, 205, 177, 146, 141, 62]
const MARKET_SIZE = 274
const POSITION_SIZE = 97
/** Layouts the devnet router still owns: pre-v5 Markets and Positions without the auto-exit deadline. */
const LEGACY_MARKET_SIZE = 241
const LEGACY_POSITION_SIZE = 89
const PUBKEY_SIZE = 32
const POSITION_MARKET_OFFSET = 40
const FAKE_RPC_KEY = 'FAKE-RPC-KEY-0123456789'
const RPC_URL_WITH_KEY = `https://rpc.example.invalid/v2/${FAKE_RPC_KEY}?api-key=${FAKE_RPC_KEY}`
const FUNDED_LAMPORTS = 10_000_000_000
/** Surplus 0.9 SOL over a 3_000 basis snapshot: a 1_000 basis position's share is 0.3 SOL, a 1 basis one's is dust. */
const SURPLUS_SNAPSHOT = 900_000_000n
const DUST_BASIS = 1n
/** No ATA rent guard for basic claim tests; rent-guard tests pass their own guards. */
const OPEN_GUARDS: CrankGuards = Object.freeze({
  minAtaValueLamports: 0n,
  maxAtaCreatesPerTick: Number.MAX_SAFE_INTEGER,
  crankMinSolLamports: 0n,
  minMigrateThresholdSolLamports: 0n,
})
const claimsJob = createClaimsJob(OPEN_GUARDS)

/** claim_surplus account order: cranker, owner, market, position, owner_quote, buffer_vault, quote_mint, token program. */
const CLAIM_KEY = Object.freeze({ cranker: 0, owner: 1, market: 2, position: 3, ownerQuote: 4 })

/* ---------- synthetic accounts ---------- */

interface MarketOptions {
  readonly finalized?: boolean
  readonly quoteMint?: PublicKey
}

function makeMarket({ finalized = true, quoteMint = NATIVE_MINT }: MarketOptions = {}): MarketAccount {
  const pool = Keypair.generate().publicKey
  const address = findMarketPda(pool, ROUTER)
  return Object.freeze({
    address,
    pool,
    config: Keypair.generate().publicKey,
    baseMint: Keypair.generate().publicKey,
    quoteMint,
    baseVault: Keypair.generate().publicKey,
    quoteVault: Keypair.generate().publicKey,
    bufferVault: findBufferPda(address, ROUTER),
    feeNumerator: 10_000_000n,
    bump: 254,
    totalBasis: 3_000n,
    finalized,
    surplusSnapshot: finalized ? SURPLUS_SNAPSHOT : 0n,
    basisSnapshot: finalized ? 3_000n : 0n,
    surplusClaimed: 0n,
  })
}

function makePosition(market: MarketAccount, owner: PublicKey = Keypair.generate().publicKey, basis = 1_000n): PositionAccount {
  return Object.freeze({
    address: findPositionPda(market.address, owner, ROUTER),
    owner,
    market: market.address,
    tokens: 1_000_000n,
    basis,
    bump: 253,
    autoExitDeadline: null,
  })
}

/** An owner off the ed25519 curve (a PDA), whose ATA getAssociatedTokenAddressSync refuses to derive. */
function offCurveOwner(): PublicKey {
  return findMarketPda(Keypair.generate().publicKey, ROUTER)
}

function quoteAtaOf(market: MarketAccount, owner: PublicKey, program: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(market.quoteMint, owner, false, program)
}

function ataExistence(entries: readonly (readonly [PublicKey, boolean])[]): Map<string, boolean> {
  return new Map(entries.map(([ata, exists]) => [ata.toBase58(), exists]))
}

function keyAt(ix: TransactionInstruction | undefined, index: number): string | undefined {
  return ix?.keys[index]?.pubkey.toBase58()
}

function isClaim(ix: TransactionInstruction | undefined): boolean {
  if (ix === undefined || !ix.programId.equals(ROUTER)) return false
  return [...ix.data.subarray(0, 8)].join() === CLAIM_SURPLUS_DISCRIMINATOR.join()
}

/** A claim_surplus builder that pays `thief` instead of the owner's canonical quote ATA. */
async function tamperedClaimBuilder(thief: PublicKey): Promise<(params: ClaimParams) => TransactionInstruction> {
  const actual = await vi.importActual<typeof import('@trucee/sdk')>('@trucee/sdk')
  return (params) => {
    const ix = actual.claimSurplusInstruction(params)
    const keys = ix.keys.map((meta, i) => (i === CLAIM_KEY.ownerQuote ? { ...meta, pubkey: thief } : meta))
    return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data })
  }
}

/* ---------- planClaims ---------- */

describe('planClaims', () => {
  const payer = Keypair.generate().publicKey

  it('plans nothing for a market that is not finalized', () => {
    const market = makeMarket({ finalized: false })
    const positions = [makePosition(market), makePosition(market), makePosition(market)]

    const plan = planClaims(market, positions, new Map(), payer, TOKEN_PROGRAM_ID)

    expect(plan).toEqual([])
  })

  it('plans one claim transaction per position with the crank payer as cranker', () => {
    const market = makeMarket()
    const positions = [makePosition(market), makePosition(market), makePosition(market)]
    const exists = ataExistence(positions.map((p) => [quoteAtaOf(market, p.owner), true]))

    const plan = planClaims(market, positions, exists, payer, TOKEN_PROGRAM_ID)

    expect(plan).toHaveLength(3)
    plan.forEach((ixs, i) => {
      const position = positions[i] as PositionAccount
      const claim = ixs[0]
      expect(ixs).toHaveLength(1)
      expect(isClaim(claim)).toBe(true)
      expect(keyAt(claim, CLAIM_KEY.cranker)).toBe(payer.toBase58())
      expect(claim?.keys[CLAIM_KEY.cranker]?.isSigner).toBe(true)
      expect(keyAt(claim, CLAIM_KEY.owner)).toBe(position.owner.toBase58())
      expect(keyAt(claim, CLAIM_KEY.market)).toBe(market.address.toBase58())
      expect(keyAt(claim, CLAIM_KEY.position)).toBe(position.address.toBase58())
      expect(keyAt(claim, CLAIM_KEY.ownerQuote)).toBe(quoteAtaOf(market, position.owner).toBase58())
    })
  })

  it('prepends createAssociatedTokenAccountIdempotent for an owner whose quote ATA does not exist', () => {
    const market = makeMarket()
    const [withAta, withoutAta, alsoWithAta] = [makePosition(market), makePosition(market), makePosition(market)]
    const missingAta = quoteAtaOf(market, withoutAta.owner)
    const exists = ataExistence([
      [quoteAtaOf(market, withAta.owner), true],
      [missingAta, false],
      [quoteAtaOf(market, alsoWithAta.owner), true],
    ])

    const plan = planClaims(market, [withAta, withoutAta, alsoWithAta], exists, payer, TOKEN_PROGRAM_ID)

    expect(plan.map((ixs) => ixs.length)).toEqual([1, 2, 1])
    const [create, claim] = plan[1] ?? []
    const expected = createAssociatedTokenAccountIdempotentInstruction(
      payer, missingAta, withoutAta.owner, market.quoteMint, TOKEN_PROGRAM_ID,
    )
    expect(create).toEqual(expected)
    expect(create?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true)
    expect(keyAt(create, 0)).toBe(payer.toBase58())
    expect(isClaim(claim)).toBe(true)
    expect(keyAt(claim, CLAIM_KEY.ownerQuote)).toBe(missingAta.toBase58())
  })

  it('treats an owner absent from the existence map as having no quote ATA', () => {
    const market = makeMarket()
    const position = makePosition(market)

    const plan = planClaims(market, [position], new Map(), payer, TOKEN_PROGRAM_ID)

    expect(plan).toHaveLength(1)
    expect(plan[0]?.[0]?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true)
    expect(isClaim(plan[0]?.[1])).toBe(true)
  })

  it('derives the canonical quote ATA under Token-2022 for a Token-2022 quote', () => {
    const market = makeMarket({ quoteMint: TSLAX_MINT })
    const position = makePosition(market)
    const ata = quoteAtaOf(market, position.owner, TOKEN_2022_PROGRAM_ID)

    const plan = planClaims(market, [position], new Map(), payer, TOKEN_2022_PROGRAM_ID)

    const [create, claim] = plan[0] ?? []
    expect(create).toEqual(
      createAssociatedTokenAccountIdempotentInstruction(payer, ata, position.owner, TSLAX_MINT, TOKEN_2022_PROGRAM_ID),
    )
    expect(keyAt(claim, CLAIM_KEY.ownerQuote)).toBe(ata.toBase58())
  })

  it('rejects a quote token program other than SPL Token or Token-2022', () => {
    const market = makeMarket()
    const position = makePosition(market)

    expect(() => planClaims(market, [position], new Map(), payer, Keypair.generate().publicKey)).toThrow(
      /SPL Token or Token-2022/,
    )
  })

  it('rejects a position that belongs to another market', () => {
    const market = makeMarket()
    const foreign = makePosition(makeMarket())

    expect(() => planClaims(market, [makePosition(market), foreign], new Map(), payer, TOKEN_PROGRAM_ID)).toThrow(
      /another market/,
    )
  })

  it('fails closed when the claim builder would pay anything but the owner canonical quote ATA', async () => {
    const market = makeMarket()
    const position = makePosition(market)
    vi.mocked(claimSurplusInstruction).mockImplementationOnce(await tamperedClaimBuilder(Keypair.generate().publicKey))

    expect(() => planClaims(market, [position], new Map(), payer, TOKEN_PROGRAM_ID)).toThrow(/canonical quote ATA/)
  })

  it('does not mutate its inputs', () => {
    const market = makeMarket()
    const positions = Object.freeze([makePosition(market), makePosition(market)])
    const exists = ataExistence([[quoteAtaOf(market, (positions[0] as PositionAccount).owner), true]])

    planClaims(market, positions, exists, payer, TOKEN_PROGRAM_ID)

    expect(exists.size).toBe(1)
    expect(positions).toHaveLength(2)
  })

  describe('owner quote ATA rent (CRK-10)', () => {
    it('plans no instructions for a missing ATA whose surplus share is below MIN_ATA_VALUE_LAMPORTS', () => {
      const market = makeMarket()

      const plan = planClaims(market, [makePosition(market, undefined, DUST_BASIS)], new Map(), payer, TOKEN_PROGRAM_ID)

      expect(plan).toEqual([[]])
    })

    it('creates a missing ATA once floor(surplus_snapshot * basis / basis_snapshot) reaches MIN_ATA_VALUE_LAMPORTS', () => {
      const market = makeMarket()
      const position = makePosition(market)
      const share = (market.surplusSnapshot * position.basis) / market.basisSnapshot
      const planAt = (min: bigint) => planClaims(market, [position], new Map(), payer, TOKEN_PROGRAM_ID, CLUSTER, min)

      expect(share).toBe(300_000_000n)
      expect(planAt(share)[0]?.map((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))).toEqual([true, false])
      expect(planAt(share + 1n)).toEqual([[]])
    })

    it('claims a dust share with no ATA create when the quote ATA exists (no threshold)', () => {
      const market = makeMarket()
      const position = makePosition(market, undefined, DUST_BASIS)
      const exists = ataExistence([[quoteAtaOf(market, position.owner), true]])

      const plan = planClaims(market, [position], exists, payer, TOKEN_PROGRAM_ID)

      expect(plan).toHaveLength(1)
      expect(plan[0]).toHaveLength(1)
      expect(isClaim(plan[0]?.[0])).toBe(true)
    })
  })
})

/* ---------- raw account encoding for the fake RPC ---------- */

function encodeMarket(m: MarketAccount): Buffer {
  const data = Buffer.alloc(MARKET_SIZE)
  data.set(MARKET_DISCRIMINATOR, 0)
  const keys = [m.pool, m.config, m.baseMint, m.quoteMint, m.baseVault, m.quoteVault, m.bufferVault]
  keys.forEach((key, i) => data.set(key.toBytes(), 8 + PUBKEY_SIZE * i))
  data.writeBigUInt64LE(m.feeNumerator, 232)
  data.writeUInt8(m.bump, 240)
  data.writeBigUInt64LE(m.totalBasis, 241)
  data.writeUInt8(m.finalized ? 1 : 0, 249)
  data.writeBigUInt64LE(m.surplusSnapshot, 250)
  data.writeBigUInt64LE(m.basisSnapshot, 258)
  data.writeBigUInt64LE(m.surplusClaimed, 266)
  return data
}

function encodePosition(p: PositionAccount): Buffer {
  const data = Buffer.alloc(POSITION_SIZE)
  data.set(POSITION_DISCRIMINATOR, 0)
  data.set(p.owner.toBytes(), 8)
  data.set(p.market.toBytes(), POSITION_MARKET_OFFSET)
  data.writeBigUInt64LE(p.tokens, 72)
  data.writeBigUInt64LE(p.basis, 80)
  data.writeUInt8(p.bump, 88)
  data.writeBigInt64LE(p.autoExitDeadline ?? 0n, 89)
  return data
}

/** A pre-v5 account: the current encoding cut to the legacy length. */
const truncated = (data: Buffer, size: number): Buffer => Buffer.from(data.subarray(0, size))

function accountInfo(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, owner, lamports: 1_000_000, executable: false, rentEpoch: 0 }
}

/* ---------- fake Connection ---------- */

interface FakeChainOptions {
  readonly markets: readonly MarketAccount[]
  readonly positions?: readonly PositionAccount[]
  /** Markets the router still owns in the 241-byte legacy layout. */
  readonly legacyMarkets?: readonly MarketAccount[]
  /** Positions the router still owns in the 89-byte legacy layout. */
  readonly legacyPositions?: readonly PositionAccount[]
  /** Quote ATAs that already exist on chain. */
  readonly existingAtas?: readonly PublicKey[]
  /** Accounts at ATA addresses owned by some other program, as [ata, owner]: not live token accounts. */
  readonly foreignAtas?: readonly (readonly [PublicKey, PublicKey])[]
  /** One RPC read that never answers. */
  readonly hangs?: HangingCall
  /** Owners whose claim send never answers. */
  readonly sendHangsFor?: readonly PublicKey[]
  /** Owners whose claim simulation fails. */
  readonly simulationFailsFor?: readonly PublicKey[]
  /** Owners whose claim send throws. */
  readonly sendFailsFor?: readonly PublicKey[]
  /** Owners whose claim lands but fails on chain. */
  readonly landsFailedFor?: readonly PublicKey[]
  /** The crank payer's lamports; FUNDED_LAMPORTS when absent. */
  readonly payerBalance?: number
}

type HangingCall = 'getBalance' | 'markets' | 'positions' | 'getMultipleAccountsInfo' | 'getLatestBlockhash' | 'simulateTransaction'

const NEVER = new Promise<never>(() => undefined)

interface Memcmp {
  readonly bytes: string
  readonly encoding?: string
}

function memcmpAt(filters: readonly GetProgramAccountsFilter[], offset: number): Memcmp | undefined {
  for (const filter of filters) {
    if ('memcmp' in filter && filter.memcmp.offset === offset) return filter.memcmp
  }
  return undefined
}

function discriminatorOf(filters: readonly GetProgramAccountsFilter[]): string {
  const disc = memcmpAt(filters, 0)
  if (disc === undefined || disc.encoding !== 'base64') return ''
  return [...Buffer.from(disc.bytes, 'base64')].join()
}

interface ServedAccount {
  readonly pubkey: PublicKey
  readonly account: AccountInfo<Buffer>
}

/** Like an RPC node: serves only the accounts whose length matches every dataSize filter. */
function matchingDataSize<T extends ServedAccount>(filters: readonly GetProgramAccountsFilter[], accounts: readonly T[]): T[] {
  const sizes = filters.flatMap((filter) => ('dataSize' in filter ? [filter.dataSize] : []))
  return accounts.filter(({ account }) => sizes.every((size) => account.data.length === size))
}

function claimOwner(tx: VersionedTransaction): string | undefined {
  const instructions = TransactionMessage.decompile(tx.message).instructions
  return keyAt(instructions.find(isClaim), CLAIM_KEY.owner)
}

function fakeConnection(options: FakeChainOptions) {
  const positions = options.positions ?? []
  const marketAccounts: readonly ServedAccount[] = [
    ...options.markets.map((m) => ({ pubkey: m.address, account: accountInfo(encodeMarket(m), ROUTER) })),
    ...(options.legacyMarkets ?? []).map((m) => ({
      pubkey: m.address,
      account: accountInfo(truncated(encodeMarket(m), LEGACY_MARKET_SIZE), ROUTER),
    })),
  ]
  const positionAccounts: readonly (ServedAccount & { readonly market: PublicKey })[] = [
    ...positions.map((p) => ({ pubkey: p.address, market: p.market, account: accountInfo(encodePosition(p), ROUTER) })),
    ...(options.legacyPositions ?? []).map((p) => ({
      pubkey: p.address,
      market: p.market,
      account: accountInfo(truncated(encodePosition(p), LEGACY_POSITION_SIZE), ROUTER),
    })),
  ]
  const existing = new Set((options.existingAtas ?? []).map((key) => key.toBase58()))
  const foreign = new Map((options.foreignAtas ?? []).map(([ata, owner]) => [ata.toBase58(), owner]))
  let sendCount = 0
  const ownerIn = (list: readonly PublicKey[] | undefined, owner: string | undefined): boolean =>
    (list ?? []).some((key) => key.toBase58() === owner)
  const signatureOwners = new Map<string, string | undefined>()

  const getProgramAccounts = vi.fn(async (programId: PublicKey, config?: GetProgramAccountsConfig) => {
    expect(programId.equals(ROUTER)).toBe(true)
    const filters = config?.filters ?? []
    const discriminator = discriminatorOf(filters)
    if (discriminator === MARKET_DISCRIMINATOR.join()) {
      if (options.hangs === 'markets') return NEVER
      return matchingDataSize(filters, marketAccounts)
    }
    if (discriminator !== POSITION_DISCRIMINATOR.join()) throw new Error('unexpected getProgramAccounts filters')
    if (options.hangs === 'positions') return NEVER
    const market = memcmpAt(filters, POSITION_MARKET_OFFSET)?.bytes
    const ofMarket = positionAccounts.filter((p) => p.market.toBase58() === market)
    return matchingDataSize(filters, ofMarket).map(({ pubkey, account }) => ({ pubkey, account }))
  })
  const getBalance = vi.fn(async (_key: PublicKey, _commitment?: Commitment) =>
    options.hangs === 'getBalance' ? NEVER : (options.payerBalance ?? FUNDED_LAMPORTS),
  )
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) => {
    if (options.hangs === 'getMultipleAccountsInfo') return NEVER
    return keys.map((key) => {
      if (existing.has(key.toBase58())) return accountInfo(Buffer.alloc(165), TOKEN_PROGRAM_ID)
      const owner = foreign.get(key.toBase58())
      return owner === undefined ? null : accountInfo(Buffer.alloc(165), owner)
    })
  })
  const getLatestBlockhash = vi.fn(async () => {
    if (options.hangs === 'getLatestBlockhash') return NEVER
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }
  })
  const simulateTransaction = vi.fn(async (tx: VersionedTransaction) => {
    if (options.hangs === 'simulateTransaction') return NEVER
    const fails = ownerIn(options.simulationFailsFor, claimOwner(tx))
    return {
      context: { slot: 1 },
      value: fails
        ? { err: { InstructionError: [1, { Custom: 6006 }] }, logs: ['Program log: claim failed'] }
        : { err: null, logs: [] },
    }
  })
  const sendTransaction = vi.fn(async (tx: VersionedTransaction) => {
    const owner = claimOwner(tx)
    if (ownerIn(options.sendFailsFor, owner)) throw new Error('send failed')
    if (ownerIn(options.sendHangsFor, owner)) return NEVER
    sendCount += 1
    const signature = `sig-${sendCount}`
    signatureOwners.set(signature, owner)
    return signature
  })
  const confirmTransaction = vi.fn(async ({ signature }: { signature: string }) => ({
    context: { slot: 2 },
    value: {
      err: ownerIn(options.landsFailedFor, signatureOwners.get(signature)) ? { InstructionError: [1, 'Custom'] } : null,
    },
  }))

  const methods = {
    getBalance,
    getProgramAccounts,
    getMultipleAccountsInfo,
    getLatestBlockhash,
    simulateTransaction,
    sendTransaction,
    confirmTransaction,
  }
  return { ...methods, connection: methods as unknown as Connection }
}

type FakeConnection = ReturnType<typeof fakeConnection>

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const payerKeypair = Keypair.generate()

function makeContext(fake: FakeConnection, maxTx: number, log = silentLog()): CrankContext {
  return Object.freeze({ connection: fake.connection, payer: payerKeypair, cluster: CLUSTER, log, maxTx })
}

function sentTransactions(fake: FakeConnection): VersionedTransaction[] {
  return fake.sendTransaction.mock.calls.map(([tx]) => tx)
}

function instructionsOf(tx: VersionedTransaction): TransactionInstruction[] {
  return TransactionMessage.decompile(tx.message).instructions
}

/* ---------- claimsJob ---------- */

describe('claimsJob', () => {
  it('is named claims', () => {
    expect(claimsJob.name).toBe('claims')
  })

  it('skips unfinalized markets without reading their positions', async () => {
    const market = makeMarket({ finalized: false })
    const fake = fakeConnection({ markets: [market], positions: [makePosition(market)] })

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(fake.getProgramAccounts).toHaveBeenCalledTimes(1)
    expect(fake.sendTransaction).not.toHaveBeenCalled()
  })

  it('queries positions by the Position discriminator at 0, the market at 40 and the 97-byte size', async () => {
    const market = makeMarket()
    const fake = fakeConnection({ markets: [market] })

    await claimsJob.run(makeContext(fake, 10))

    const [programId, config] = fake.getProgramAccounts.mock.calls[1] ?? []
    expect(programId?.equals(ROUTER)).toBe(true)
    expect(config?.filters).toEqual([
      { memcmp: { offset: 0, bytes: Buffer.from(POSITION_DISCRIMINATOR).toString('base64'), encoding: 'base64' } },
      { memcmp: { offset: POSITION_MARKET_OFFSET, bytes: market.address.toBase58() } },
      { dataSize: POSITION_SIZE },
    ])
  })

  it('claims every position into its owner canonical quote ATA, signed and paid by the crank', async () => {
    const market = makeMarket()
    const positions = [makePosition(market), makePosition(market), makePosition(market)]
    const existingAtas = positions.map((p) => quoteAtaOf(market, p.owner))
    const fake = fakeConnection({ markets: [market], positions, existingAtas })

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result).toEqual({ sent: ['sig-1', 'sig-2', 'sig-3'], skipped: 0, errors: [] })
    const sent = sentTransactions(fake)
    expect(sent.map(claimOwner)).toEqual(positions.map((p) => p.owner.toBase58()))
    sent.forEach((tx, i) => {
      const owner = (positions[i] as PositionAccount).owner
      const ixs = instructionsOf(tx)
      expect(tx.message.staticAccountKeys[0]?.equals(payerKeypair.publicKey)).toBe(true)
      expect(tx.signatures[0]?.some((byte) => byte !== 0)).toBe(true)
      expect(ixs).toHaveLength(1)
      expect(keyAt(ixs[0], CLAIM_KEY.cranker)).toBe(payerKeypair.publicKey.toBase58())
      expect(keyAt(ixs[0], CLAIM_KEY.ownerQuote)).toBe(quoteAtaOf(market, owner).toBase58())
    })
    expect(fake.simulateTransaction).toHaveBeenCalledTimes(3)
  })

  it('creates the quote ATA first, paid by the crank, for an owner who has none', async () => {
    const market = makeMarket()
    const position = makePosition(market)
    const fake = fakeConnection({ markets: [market], positions: [position] })

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.sent).toHaveLength(1)
    const ata = quoteAtaOf(market, position.owner)
    expect(fake.getMultipleAccountsInfo).toHaveBeenCalledWith([ata], 'confirmed')
    const [create, claim] = instructionsOf(sentTransactions(fake)[0] as VersionedTransaction)
    expect(create?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true)
    expect(keyAt(create, 0)).toBe(payerKeypair.publicKey.toBase58())
    expect(keyAt(create, 1)).toBe(ata.toBase58())
    expect(keyAt(create, 2)).toBe(position.owner.toBase58())
    expect(keyAt(claim, CLAIM_KEY.ownerQuote)).toBe(ata.toBase58())
  })

  it.each([
    ['the system program (lamports sent to the address)', SystemProgram.programId],
    ['Token-2022 under an SPL Token quote', TOKEN_2022_PROGRAM_ID],
    ['an unrelated program', Keypair.generate().publicKey],
  ])('treats an account at the quote ATA address owned by %s as missing', async (_, owner) => {
    const market = makeMarket()
    const position = makePosition(market)
    const ata = quoteAtaOf(market, position.owner)
    const fake = fakeConnection({ markets: [market], positions: [position], foreignAtas: [[ata, owner]] })

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.sent).toHaveLength(1)
    const [create, claim] = instructionsOf(sentTransactions(fake)[0] as VersionedTransaction)
    expect(create?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true)
    expect(keyAt(create, 1)).toBe(ata.toBase58())
    expect(isClaim(claim)).toBe(true)
  })

  it('sends at most ctx.maxTx transactions and counts the rest as skipped', async () => {
    const market = makeMarket()
    const positions = [makePosition(market), makePosition(market), makePosition(market)]
    const fake = fakeConnection({ markets: [market], positions })

    const result = await claimsJob.run(makeContext(fake, 2))

    expect(fake.sendTransaction).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ sent: ['sig-1', 'sig-2'], skipped: 1, errors: [] })
  })

  it('shares the maxTx budget across markets', async () => {
    const [first, second] = [makeMarket(), makeMarket()]
    const positions = [makePosition(first), makePosition(first), makePosition(second), makePosition(second)]
    const fake = fakeConnection({ markets: [first, second], positions })

    const result = await claimsJob.run(makeContext(fake, 3))

    expect(fake.sendTransaction).toHaveBeenCalledTimes(3)
    expect(result.sent).toHaveLength(3)
    expect(result.skipped).toBe(1)
  })

  it('makes no RPC call when maxTx is 0', async () => {
    const market = makeMarket()
    const fake = fakeConnection({ markets: [market], positions: [makePosition(market)] })

    const result = await claimsJob.run(makeContext(fake, 0))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(fake.getProgramAccounts).not.toHaveBeenCalled()
  })

  it('skips and logs a claim whose simulation fails without spending the budget on it', async () => {
    const market = makeMarket()
    const positions = [makePosition(market), makePosition(market), makePosition(market)]
    const failing = (positions[0] as PositionAccount).owner
    const fake = fakeConnection({ markets: [market], positions, simulationFailsFor: [failing] })
    const log = silentLog()

    const result = await claimsJob.run(makeContext(fake, 2, log))

    expect(result).toEqual({ sent: ['sig-1', 'sig-2'], skipped: 1, errors: [] })
    expect(sentTransactions(fake).map(claimOwner)).not.toContain(failing.toBase58())
    expect(log.warn).toHaveBeenCalledWith(
      'claims: simulation failed; skipped',
      expect.objectContaining({ market: market.address.toBase58(), owner: failing.toBase58() }),
    )
  })

  it('skips and logs positions whose owner is off the ed25519 curve', async () => {
    const market = makeMarket()
    const offCurve = makePosition(market, offCurveOwner())
    const positions = [makePosition(market), offCurve, makePosition(market)]
    const fake = fakeConnection({ markets: [market], positions })
    const log = silentLog()

    const result = await claimsJob.run(makeContext(fake, 10, log))

    expect(result).toEqual({ sent: ['sig-1', 'sig-2'], skipped: 1, errors: [] })
    expect(sentTransactions(fake).map(claimOwner)).not.toContain(offCurve.owner.toBase58())
    expect(log.warn).toHaveBeenCalledWith(
      'claims: owner is off curve; skipped',
      expect.objectContaining({ owner: offCurve.owner.toBase58() }),
    )
  })

  it('records an error and continues when a send fails', async () => {
    const market = makeMarket()
    const positions = [makePosition(market), makePosition(market), makePosition(market)]
    const fake = fakeConnection({ markets: [market], positions, sendFailsFor: [(positions[0] as PositionAccount).owner] })

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.sent).toHaveLength(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/send failed/)
  })

  it('records an error when a claim lands but fails on chain', async () => {
    const market = makeMarket()
    const position = makePosition(market)
    const fake = fakeConnection({ markets: [market], positions: [position], landsFailedFor: [position.owner] })

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/sig-1/)
  })

  it('skips a market whose quote mint has no crank minimums, warning once per mint for the job instance', async () => {
    const market = makeMarket({ quoteMint: Keypair.generate().publicKey })
    const fake = fakeConnection({ markets: [market], positions: [makePosition(market)] })
    const log = silentLog()

    const results = [await claimsJob.run(makeContext(fake, 10, log)), await claimsJob.run(makeContext(fake, 10, log))]

    expect(results).toEqual([{ sent: [], skipped: 0, errors: [] }, { sent: [], skipped: 0, errors: [] }])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('quote mint'), expect.objectContaining({ quoteMint: market.quoteMint.toBase58() }))
    expect(fake.getProgramAccounts).toHaveBeenCalledTimes(2) // one market scan per run: no position read: no position read
    expect(fake.sendTransaction).not.toHaveBeenCalled()
  })

  it('gives up on a confirmation after 45 s, reports the outcome as unknown and does not resend', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const market = makeMarket()
    const position = makePosition(market)
    const fake = fakeConnection({ markets: [market], positions: [position] })
    fake.confirmTransaction.mockReturnValueOnce(NEVER)
    const log = silentLog()

    const run = claimsJob.run(makeContext(fake, 10, log))
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS)
    const result = await run

    expect(result.sent).toEqual([])
    expect(result.errors).toEqual([expect.stringMatching(/sig-1 not confirmed within 45000 ms; outcome unknown/)])
    expect(fake.sendTransaction).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(
      'claims: outcome unknown; not resent this tick',
      expect.objectContaining({ signature: 'sig-1', owner: position.owner.toBase58() }),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('caps attempts per tick at 3 x maxTx when every simulation fails', async () => {
    const market = makeMarket()
    const positions = Array.from({ length: 5 }, () => makePosition(market))
    const fake = fakeConnection({ markets: [market], positions, simulationFailsFor: positions.map((p) => p.owner) })

    const result = await claimsJob.run(makeContext(fake, 1))

    expect(fake.simulateTransaction).toHaveBeenCalledTimes(3)
    expect(fake.sendTransaction).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: [], skipped: 5, errors: [] })
  })

  it('stops reading markets once it has planned as many claims as it may attempt', async () => {
    const [first, second] = [makeMarket(), makeMarket()]
    const positions = [...Array.from({ length: 3 }, () => makePosition(first)), makePosition(second)]
    const fake = fakeConnection({ markets: [first, second], positions })

    const result = await claimsJob.run(makeContext(fake, 1))

    expect(fake.getProgramAccounts).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ sent: ['sig-1'], skipped: 2, errors: [] })
  })

  it('fetches one blockhash per tick and signs every claim with it', async () => {
    const [first, second] = [makeMarket(), makeMarket()]
    const positions = [makePosition(first), makePosition(first), makePosition(second), makePosition(second)]
    const fake = fakeConnection({ markets: [first, second], positions })

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.sent).toHaveLength(4)
    expect(fake.getLatestBlockhash).toHaveBeenCalledTimes(1)
    expect(new Set(sentTransactions(fake).map((tx) => tx.message.recentBlockhash)).size).toBe(1)
  })

  it('fetches no blockhash when there is nothing to claim', async () => {
    const fake = fakeConnection({ markets: [makeMarket()] })

    await claimsJob.run(makeContext(fake, 10))

    expect(fake.getLatestBlockhash).not.toHaveBeenCalled()
  })

  it.each(['getBalance', 'markets', 'positions', 'getMultipleAccountsInfo', 'getLatestBlockhash', 'simulateTransaction'] as const)(
    'records an error and sends nothing when %s does not answer within 30 s',
    async (hangs) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const market = makeMarket()
      const fake = fakeConnection({ markets: [market], positions: [makePosition(market)], hangs })

      const run = claimsJob.run(makeContext(fake, 10))
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS)
      const result = await run

      expect(result.sent).toEqual([])
      expect(result.errors).toEqual([expect.stringMatching(/not answered within 30000 ms/)])
      expect(fake.sendTransaction).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('treats a send that does not answer within 30 s as an unknown outcome and does not resend it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const market = makeMarket()
    const [stuck, fine] = [makePosition(market), makePosition(market)]
    const fake = fakeConnection({ markets: [market], positions: [stuck, fine], sendHangsFor: [stuck.owner] })
    const log = silentLog()

    const run = claimsJob.run(makeContext(fake, 10, log))
    await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS)
    const result = await run

    expect(result.sent).toHaveLength(1)
    expect(result.errors).toEqual([expect.stringMatching(/send not answered within 30000 ms; outcome unknown/)])
    expect(sentTransactions(fake).map(claimOwner)).toEqual([stuck.owner.toBase58(), fine.owner.toBase58()])
    expect(log.warn).toHaveBeenCalledWith(
      'claims: outcome unknown; not resent this tick',
      expect.objectContaining({ owner: stuck.owner.toBase58(), signature: null }),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records an error and sends nothing when the claim builder would pay the wrong account', async () => {
    const market = makeMarket()
    const fake = fakeConnection({ markets: [market], positions: [makePosition(market)] })
    vi.mocked(claimSurplusInstruction).mockImplementationOnce(await tamperedClaimBuilder(Keypair.generate().publicKey))

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.sent).toEqual([])
    expect(result.errors).toEqual([expect.stringMatching(/canonical quote ATA/)])
    expect(fake.simulateTransaction).not.toHaveBeenCalled()
    expect(fake.sendTransaction).not.toHaveBeenCalled()
  })

  it('warns about an off-curve owner once, but skips it every tick', async () => {
    const market = makeMarket()
    const offCurve = makePosition(market, offCurveOwner())
    const fake = fakeConnection({ markets: [market], positions: [offCurve] })
    const log = silentLog()

    const first = await claimsJob.run(makeContext(fake, 10, log))
    const second = await claimsJob.run(makeContext(fake, 10, log))

    expect([first.skipped, second.skipped]).toEqual([1, 1])
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('keeps the off-curve memory per job instance, not per module', async () => {
    const market = makeMarket()
    const fake = fakeConnection({ markets: [market], positions: [makePosition(market, offCurveOwner())] })
    const log = silentLog()

    await createClaimsJob(OPEN_GUARDS).run(makeContext(fake, 10, log))
    await createClaimsJob(OPEN_GUARDS).run(makeContext(fake, 10, log))

    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('records an error without the RPC URL or its key, instead of throwing, when the market read fails', async () => {
    const fake = fakeConnection({ markets: [] })
    fake.getProgramAccounts.mockRejectedValueOnce(new Error(`request to ${RPC_URL_WITH_KEY} failed`))

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringMatching(/to rpc\.example\.invalid failed/)] })
    expect(result.errors.join('\n')).not.toContain(FAKE_RPC_KEY)
  })

  it('keeps the RPC URL and its key out of result.errors when a send fails', async () => {
    const market = makeMarket()
    const fake = fakeConnection({ markets: [market], positions: [makePosition(market)] })
    fake.sendTransaction.mockRejectedValueOnce(new Error(`failed to send transaction: ${RPC_URL_WITH_KEY} returned 429`))

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.errors).toHaveLength(1)
    expect(result.errors.join('\n')).not.toContain(FAKE_RPC_KEY)
  })

  it('records an error instead of throwing when ctx.cluster cannot be resolved', async () => {
    const fake = fakeConnection({ markets: [] })
    const ctx: CrankContext = {
      connection: fake.connection,
      payer: payerKeypair,
      log: silentLog(),
      maxTx: 10,
      get cluster(): ClusterConfig {
        throw new Error('unknown cluster')
      },
    }

    const result = await claimsJob.run(ctx)

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringMatching(/unknown cluster/)] })
  })
})

describe('claimsJob ATA rent and payer guards (CRK-10)', () => {
  const guards: CrankGuards = { ...OPEN_GUARDS, minAtaValueLamports: DEFAULT_MIN_ATA_VALUE_LAMPORTS, maxAtaCreatesPerTick: 2 }
  const createsAta = (tx: VersionedTransaction): boolean =>
    instructionsOf(tx).some((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))

  it('creates at most MAX_ATA_CREATES_PER_TICK missing ATAs per tick and logs the rest once', async () => {
    const market = makeMarket()
    const fake = fakeConnection({ markets: [market], positions: [makePosition(market), makePosition(market), makePosition(market)] })
    const log = silentLog()

    const result = await createClaimsJob(guards).run(makeContext(fake, 10, log))

    expect(result).toEqual({ sent: ['sig-1', 'sig-2'], skipped: 1, errors: [] })
    expect(sentTransactions(fake).filter(createsAta)).toHaveLength(2)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('quote ATA missing'), expect.objectContaining({ belowMinValue: 0, overCreateCap: 1 }))
  })

  it('creates a missing xStock ATA for a 0.1 share surplus share, not for 0.09 share (raw-unit minimum)', async () => {
    const market: MarketAccount = { ...makeMarket({ quoteMint: TSLAX_MINT }), surplusSnapshot: 1_000_000_000n, basisSnapshot: 1_000n }
    const [small, enough] = [9n, 10n].map((basis) => makePosition(market, undefined, basis)) // shares 9e6 and 1e7 raw
    const fake = fakeConnection({ markets: [market], positions: [small!, enough!] })

    const result = await createClaimsJob(guards).run(makeContext(fake, 10))

    expect(result).toEqual({ sent: ['sig-1'], skipped: 1, errors: [] })
    expect(sentTransactions(fake).map(claimOwner)).toEqual([enough!.owner.toBase58()])
  })

  it('claims a dust share into an existing quote ATA without creating one', async () => {
    const market = makeMarket()
    const position = makePosition(market, undefined, DUST_BASIS)
    const fake = fakeConnection({ markets: [market], positions: [position], existingAtas: [quoteAtaOf(market, position.owner)] })

    const result = await createClaimsJob(guards).run(makeContext(fake, 10))

    expect(result.sent).toEqual(['sig-1'])
    expect(sentTransactions(fake).filter(createsAta)).toEqual([])
  })

  it('claims a real share this tick even behind 50 dust positions with missing ATAs', async () => {
    const market = makeMarket()
    const dust = Array.from({ length: 50 }, () => makePosition(market, undefined, DUST_BASIS))
    const real = makePosition(market)
    const fake = fakeConnection({ markets: [market], positions: [...dust, real] })

    const result = await createClaimsJob(guards).run(makeContext(fake, 1))

    expect(result).toEqual({ sent: ['sig-1'], skipped: 50, errors: [] })
    expect(fake.simulateTransaction).toHaveBeenCalledTimes(1)
    expect(sentTransactions(fake).map(claimOwner)).toEqual([real.owner.toBase58()])
  })

  it('keeps reading markets past claims that the create cap will skip, so they do not starve later markets', async () => {
    const [first, second] = [makeMarket(), makeMarket()]
    const later = makePosition(second)
    const positions = [...Array.from({ length: 6 }, () => makePosition(first)), later]
    const fake = fakeConnection({ markets: [first, second], positions, existingAtas: [quoteAtaOf(second, later.owner)] })

    const result = await createClaimsJob({ ...guards, maxAtaCreatesPerTick: 1 }).run(makeContext(fake, 2))

    expect(result).toEqual({ sent: ['sig-1', 'sig-2'], skipped: 5, errors: [] })
    expect(sentTransactions(fake).map(claimOwner)).toContain(later.owner.toBase58())
  })

  it('logs once and plans nothing while the payer holds less than CRANK_MIN_SOL_LAMPORTS (default 0.05 SOL)', async () => {
    const market = makeMarket()
    const [below, atFloor] = [49_999_999, 50_000_000].map((payerBalance) =>
      fakeConnection({ markets: [market], positions: [makePosition(market)], payerBalance }),
    )
    const log = silentLog()

    const skipped = await defaultClaimsJob.run(makeContext(below!, 10, log))
    const ran = await defaultClaimsJob.run(makeContext(atFloor!, 10))

    expect(skipped).toEqual({ sent: [], skipped: 0, errors: [] })
    expect(below!.getBalance).toHaveBeenCalledWith(payerKeypair.publicKey, 'confirmed')
    expect(below!.getProgramAccounts).not.toHaveBeenCalled()
    expect([log.info, log.warn, log.error].map((fn) => fn.mock.calls.length)).toEqual([0, 1, 0])
    expect(ran.sent).toEqual(['sig-1'])
  })
})

/*
 * The devnet router still owns 241-byte Markets and 89-byte pre-v5 Positions. The fake RPC applies dataSize
 * filters like a node, so only a scan that sends one is spared the legacy accounts.
 */
describe('claimsJob with legacy-size router accounts (CRK-11)', () => {
  const marketScan = [{ memcmp: { offset: 0, bytes: Buffer.from(MARKET_DISCRIMINATOR).toString('base64'), encoding: 'base64' as const } }]

  it('the fake RPC serves legacy accounts to a scan without a dataSize filter', async () => {
    const fake = fakeConnection({ markets: [makeMarket()], legacyMarkets: [makeMarket()] })

    const served = await fake.connection.getProgramAccounts(ROUTER, { filters: marketScan })

    expect(served.map(({ account }) => account.data.length).sort()).toEqual([LEGACY_MARKET_SIZE, MARKET_SIZE])
  })

  it('never decodes an 89-byte legacy position and claims only the current-layout ones', async () => {
    const market = makeMarket()
    const current = makePosition(market)
    const legacy = makePosition(market)
    const existingAtas = [current, legacy].map((p) => quoteAtaOf(market, p.owner))
    const fake = fakeConnection({ markets: [market], positions: [current], legacyPositions: [legacy], existingAtas })
    vi.mocked(decodePosition).mockClear()

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result).toEqual({ sent: ['sig-1'], skipped: 0, errors: [] })
    expect(vi.mocked(decodePosition).mock.calls.map(([, data]) => data.length)).toEqual([POSITION_SIZE])
    expect(sentTransactions(fake).map(claimOwner)).toEqual([current.owner.toBase58()])
  })

  it('plans claims from a fetchAllMarkets result without the 241-byte legacy markets, without errors', async () => {
    const market = makeMarket()
    const legacy = makeMarket()
    const position = makePosition(market)
    const fake = fakeConnection({
      markets: [market],
      legacyMarkets: [legacy],
      positions: [position, makePosition(legacy)],
      existingAtas: [quoteAtaOf(market, position.owner)],
    })
    vi.mocked(fetchAllMarkets).mockClear()

    const result = await claimsJob.run(makeContext(fake, 10))

    const settled = vi.mocked(fetchAllMarkets).mock.settledResults
    expect(settled.map(({ type }) => type)).toEqual(['fulfilled'])
    const markets = settled[0]?.type === 'fulfilled' ? settled[0].value : []
    expect(markets.map((m) => m.address.toBase58())).toEqual([market.address.toBase58()])
    expect(fake.getProgramAccounts.mock.calls[0]?.[1]?.filters).toContainEqual({ dataSize: MARKET_SIZE })
    expect(result).toEqual({ sent: ['sig-1'], skipped: 0, errors: [] })
    expect(sentTransactions(fake).map(claimOwner)).toEqual([position.owner.toBase58()])
  })
})

describe('createBoundedKeySet', () => {
  it('remembers at most its capacity, forgetting the oldest key first', () => {
    const keys = createBoundedKeySet(2)

    keys.add('a')
    keys.add('b')
    keys.add('a') // already known: no eviction, no reorder
    keys.add('c')

    expect(['a', 'b', 'c'].map((key) => keys.has(key))).toEqual([false, true, true])
    expect(keys.size()).toBe(2)
  })
})
