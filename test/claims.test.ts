/**
 * CRK-03: the claims crank job. planClaims is tested with synthetic decoded accounts; claimsJob.run is tested
 * against an in-memory fake of the few Connection methods it uses (no network).
 */
import { Buffer } from 'node:buffer'
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type AccountInfo,
  type Connection,
  type GetProgramAccountsConfig,
  type GetProgramAccountsFilter,
  type TransactionInstruction,
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
  findBufferPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
  type ClusterConfig,
  type MarketAccount,
  type PositionAccount,
} from '@trucee/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { CrankContext } from '../src/crank/index.js'
import { claimsJob, planClaims } from '../src/crank/jobs/claims.js'

const CLUSTER: ClusterConfig = getClusterConfig('localnet')
const ROUTER = CLUSTER.routerProgramId
const TSLAX_MINT = new PublicKey('XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB')

const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154]
const POSITION_DISCRIMINATOR = [170, 188, 143, 228, 122, 64, 247, 208]
const CLAIM_SURPLUS_DISCRIMINATOR = [195, 35, 205, 205, 177, 146, 141, 62]
const MARKET_SIZE = 274
const POSITION_SIZE = 97
const PUBKEY_SIZE = 32
const POSITION_MARKET_OFFSET = 40
const CONFIRM_TIMEOUT_MS = 45_000
const FAKE_RPC_KEY = 'FAKE-RPC-KEY-0123456789'
const RPC_URL_WITH_KEY = `https://rpc.example.invalid/v2/${FAKE_RPC_KEY}?api-key=${FAKE_RPC_KEY}`

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
    surplusSnapshot: finalized ? 600n : 0n,
    basisSnapshot: finalized ? 3_000n : 0n,
    surplusClaimed: 0n,
  })
}

function makePosition(market: MarketAccount, owner: PublicKey = Keypair.generate().publicKey): PositionAccount {
  return Object.freeze({
    address: findPositionPda(market.address, owner, ROUTER),
    owner,
    market: market.address,
    tokens: 1_000_000n,
    basis: 1_000n,
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

  it('does not mutate its inputs', () => {
    const market = makeMarket()
    const positions = Object.freeze([makePosition(market), makePosition(market)])
    const exists = ataExistence([[quoteAtaOf(market, (positions[0] as PositionAccount).owner), true]])

    planClaims(market, positions, exists, payer, TOKEN_PROGRAM_ID)

    expect(exists.size).toBe(1)
    expect(positions).toHaveLength(2)
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

function accountInfo(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, owner, lamports: 1_000_000, executable: false, rentEpoch: 0 }
}

/* ---------- fake Connection ---------- */

interface FakeChainOptions {
  readonly markets: readonly MarketAccount[]
  readonly positions?: readonly PositionAccount[]
  /** Quote ATAs that already exist on chain. */
  readonly existingAtas?: readonly PublicKey[]
  /** ATA addresses that only hold lamports someone sent there (a system-owned account, not a token account). */
  readonly prefundedAtas?: readonly PublicKey[]
  /** Owners whose claim simulation fails. */
  readonly simulationFailsFor?: readonly PublicKey[]
  /** Owners whose claim send throws. */
  readonly sendFailsFor?: readonly PublicKey[]
  /** Owners whose claim lands but fails on chain. */
  readonly landsFailedFor?: readonly PublicKey[]
}

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

function claimOwner(tx: VersionedTransaction): string | undefined {
  const instructions = TransactionMessage.decompile(tx.message).instructions
  return keyAt(instructions.find(isClaim), CLAIM_KEY.owner)
}

function fakeConnection(options: FakeChainOptions) {
  const positions = options.positions ?? []
  const existing = new Set((options.existingAtas ?? []).map((key) => key.toBase58()))
  const prefunded = new Set((options.prefundedAtas ?? []).map((key) => key.toBase58()))
  let sendCount = 0
  const ownerIn = (list: readonly PublicKey[] | undefined, owner: string | undefined): boolean =>
    (list ?? []).some((key) => key.toBase58() === owner)
  const signatureOwners = new Map<string, string | undefined>()

  const getProgramAccounts = vi.fn(async (programId: PublicKey, config?: GetProgramAccountsConfig) => {
    expect(programId.equals(ROUTER)).toBe(true)
    const filters = config?.filters ?? []
    const discriminator = discriminatorOf(filters)
    if (discriminator === MARKET_DISCRIMINATOR.join()) {
      return options.markets.map((m) => ({ pubkey: m.address, account: accountInfo(encodeMarket(m), ROUTER) }))
    }
    if (discriminator !== POSITION_DISCRIMINATOR.join()) throw new Error('unexpected getProgramAccounts filters')
    const market = memcmpAt(filters, POSITION_MARKET_OFFSET)?.bytes
    return positions
      .filter((p) => p.market.toBase58() === market)
      .map((p) => ({ pubkey: p.address, account: accountInfo(encodePosition(p), ROUTER) }))
  })
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) =>
    keys.map((key) => {
      if (existing.has(key.toBase58())) return accountInfo(Buffer.alloc(165), TOKEN_PROGRAM_ID)
      return prefunded.has(key.toBase58()) ? accountInfo(Buffer.alloc(0), SystemProgram.programId) : null
    }),
  )
  const getLatestBlockhash = vi.fn(async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000,
  }))
  const simulateTransaction = vi.fn(async (tx: VersionedTransaction) => {
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

  it('queries positions by the Position discriminator at 0 and the market at 40', async () => {
    const market = makeMarket()
    const fake = fakeConnection({ markets: [market] })

    await claimsJob.run(makeContext(fake, 10))

    const [programId, config] = fake.getProgramAccounts.mock.calls[1] ?? []
    expect(programId?.equals(ROUTER)).toBe(true)
    expect(config?.filters).toEqual([
      { memcmp: { offset: 0, bytes: Buffer.from(POSITION_DISCRIMINATOR).toString('base64'), encoding: 'base64' } },
      { memcmp: { offset: POSITION_MARKET_OFFSET, bytes: market.address.toBase58() } },
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

  it('still creates the quote ATA when its address only holds lamports sent there', async () => {
    const market = makeMarket()
    const position = makePosition(market)
    const ata = quoteAtaOf(market, position.owner)
    const fake = fakeConnection({ markets: [market], positions: [position], prefundedAtas: [ata] })

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

  it('records an error for a market whose quote mint is not in the cluster config', async () => {
    const market = makeMarket({ quoteMint: Keypair.generate().publicKey })
    const fake = fakeConnection({ markets: [market], positions: [makePosition(market)] })

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.sent).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/quote mint/)
    expect(fake.sendTransaction).not.toHaveBeenCalled()
  })

  it('records an error instead of throwing when the RPC fails', async () => {
    const fake = fakeConnection({ markets: [] })
    fake.getProgramAccounts.mockRejectedValueOnce(new Error('rpc unavailable'))

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result).toEqual({ sent: [], skipped: 0, errors: [expect.stringMatching(/rpc unavailable/)] })
  })

  it('gives up on a confirmation after 45 s, reports the outcome as unknown and does not resend', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const market = makeMarket()
      const position = makePosition(market)
      const fake = fakeConnection({ markets: [market], positions: [position] })
      let markConfirming: () => void = () => undefined
      const confirming = new Promise<void>((resolve) => {
        markConfirming = resolve
      })
      fake.confirmTransaction.mockImplementationOnce(() => {
        markConfirming()
        return new Promise<never>(() => undefined)
      })
      const log = silentLog()

      const run = claimsJob.run(makeContext(fake, 10, log))
      await confirming
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS)
      const result = await run

      expect(result.sent).toEqual([])
      expect(result.errors).toEqual([expect.stringMatching(/sig-1 not confirmed within 45000 ms; outcome unknown/)])
      expect(fake.sendTransaction).toHaveBeenCalledTimes(1)
      expect(log.warn).toHaveBeenCalledWith(
        'claims: confirmation timed out; outcome unknown',
        expect.objectContaining({ signature: 'sig-1', owner: position.owner.toBase58() }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the RPC URL and its key out of result.errors when the market read fails', async () => {
    const fake = fakeConnection({ markets: [] })
    fake.getProgramAccounts.mockRejectedValueOnce(new Error(`request to ${RPC_URL_WITH_KEY} failed`))

    const result = await claimsJob.run(makeContext(fake, 10))

    expect(result.errors).toHaveLength(1)
    expect(result.errors.join('\n')).not.toContain(FAKE_RPC_KEY)
    expect(result.errors[0]).toMatch(/rpc\.example\.invalid/)
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
