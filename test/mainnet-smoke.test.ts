import * as fs from 'node:fs'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { floorValue, fetchMarket, quoteBuy, getClusterConfig, type MarketAccount, type PositionAccount } from '@trucee/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertFloorRefund,
  assertPayer,
  calculateNeed,
  loadMainnetPayer,
  parseOptions,
  requireExecutable,
  runSmoke,
  sendOnce,
} from '../scripts/mainnet-smoke.js'

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const ENV = { RPC_URL: 'https://rpc.example/private-key', PAYER_KEYPAIR: '/tmp/smoke.json', APP_BASE_URL: 'https://trucee.fun' }
const PAYER = Keypair.generate()

vi.mock('node:fs', async (original) => ({
  ...await original<typeof fs>(), existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn(),
}))
vi.mock('@trucee/sdk', async (original) => ({
  ...await original<typeof import('@trucee/sdk')>(), fetchMarket: vi.fn(), quoteBuy: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fs.existsSync).mockReturnValue(false)
})

describe('mainnet smoke options', () => {
  it('defaults to dry run and accepts only an explicit execute flag', () => {
    expect(parseOptions([], ENV).execute).toBe(false)
    expect(parseOptions(['--execute'], ENV).execute).toBe(true)
    expect(() => parseOptions(['--execute', '--execute'], ENV)).toThrow('arguments')
    expect(() => parseOptions(['--rpc', ENV.RPC_URL], ENV)).toThrow('arguments')
  })

  it.each(['RPC_URL', 'PAYER_KEYPAIR', 'APP_BASE_URL'] as const)('requires %s', (key) => {
    expect(() => parseOptions([], { ...ENV, [key]: ' ' })).toThrow(`${key} is required`)
  })

  it('does not use devnet or payer defaults', () => {
    expect(() => parseOptions([], { DEVNET_RPC: ENV.RPC_URL })).toThrow('RPC_URL is required')
  })

  it.each(['[1,2,3]', '{"secretKey":[1,2,3]}', '"[1,2,3]"'])('rejects inline JSON without echoing it', (value) => {
    expect(() => parseOptions([], { ...ENV, PAYER_KEYPAIR: value })).toThrow('file path')
    try { parseOptions([], { ...ENV, PAYER_KEYPAIR: value }) } catch (err) {
      expect(String(err)).not.toContain(value)
    }
  })

  it.each(['http://trucee.fun', 'https://trucee.fun/path', 'https://user:pass@trucee.fun', 'https://trucee.fun?key=x', 'https://trucee.fun/#x'])('requires an HTTPS app origin: %s', (url) => {
    expect(() => parseOptions([], { ...ENV, APP_BASE_URL: url })).toThrow('https origin')
  })

  it('trims input and rejects malformed RPC values without echoing them', () => {
    const options = parseOptions([], { ...ENV, APP_BASE_URL: ' https://trucee.fun/ ', PAYER_KEYPAIR: ' ./payer.json ' })
    expect(options.appBaseUrl.origin).toBe(ENV.APP_BASE_URL)
    expect(options.payerPath).toBe('./payer.json')
    expect(() => parseOptions([], { ...ENV, RPC_URL: 'SECRET-BAD-URL' })).toThrow('RPC_URL must be an https URL')
    expect(() => parseOptions([], { ...ENV, RPC_URL: 'http://rpc.example' })).toThrow('RPC_URL must be an https URL')
  })
})

describe('mainnet smoke preflight', () => {
  it('refuses another genesis before reading the payer key', async () => {
    const read = vi.fn(() => PAYER)
    await expect(loadMainnetPayer({ getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }, ENV.PAYER_KEYPAIR, read)).rejects.toThrow('mainnet-beta')
    expect(read).not.toHaveBeenCalled()
  })

  it('does not read keys when the genesis request fails', async () => {
    const read = vi.fn(() => PAYER)
    await expect(loadMainnetPayer({ getGenesisHash: async () => { throw new Error('RPC unavailable') } }, ENV.PAYER_KEYPAIR, read)).rejects.toThrow('RPC unavailable')
    expect(read).not.toHaveBeenCalled()
  })

  it('reads a payer only after the mainnet genesis check', async () => {
    const order: string[] = []
    const payer = await loadMainnetPayer({ getGenesisHash: async () => { order.push('genesis'); return MAINNET_GENESIS } }, ENV.PAYER_KEYPAIR, () => { order.push('read'); return PAYER })
    expect(payer).toBe(PAYER)
    expect(order).toEqual(['genesis', 'read'])
  })

  it('refuses the upgrade authority, but accepts a throwaway payer', () => {
    expect(() => assertPayer(new PublicKey('CamCkeR9iqBij1ZyrEYj9mp6emQtpMVdWWVCUX46tFLE'))).toThrow('upgrade authority')
    expect(() => assertPayer(PAYER.publicKey)).not.toThrow()
  })

  it('reports missing and non-executable programs clearly', () => {
    expect(() => requireExecutable('router', PAYER.publicKey, null)).toThrow('router')
    expect(() => requireExecutable('hook', PAYER.publicKey, { executable: false })).toThrow('not executable')
    expect(() => requireExecutable('hook', PAYER.publicKey, { executable: true })).not.toThrow()
  })

  it('itemises rents, buy and fees, keeping the margin separate from spend', () => {
    const need = calculateNeed({ config: 8_741_760n, pool: 3_841_920n, mint: 8_017_920n, baseVault: 2_108_880n, quoteVault: 2_039_280n, market: 2_797_920n, bufferVault: 2_039_280n, hookMetas: 1_245_840n, position: 1_566_000n, baseAta: 2_108_880n, quoteAta: 2_039_280n }, 40_000n)
    expect(need.rent).toBe(36_546_960n)
    expect(need.buy).toBe(10_000_000n)
    expect(need.fees).toBe(40_000n)
    expect(need.total).toBe(46_586_960n)
    expect(need.requiredBalance).toBe(56_586_960n)
  })

  it('refuses a need at or above 0.05 SOL and negative inputs', () => {
    expect(() => calculateNeed({ config: 39_960_000n }, 40_000n)).toThrow('under 0.05 SOL')
    expect(() => calculateNeed({ config: -1n }, 0n)).toThrow('non-negative')
    expect(() => calculateNeed({}, -1n)).toThrow('non-negative')
  })
})

const market = (): MarketAccount => ({
  address: PAYER.publicKey, pool: PAYER.publicKey, config: PAYER.publicKey, baseMint: PAYER.publicKey,
  quoteMint: PAYER.publicKey, baseVault: PAYER.publicKey, quoteVault: PAYER.publicKey, bufferVault: PAYER.publicKey,
  feeNumerator: 10_000_000n, bump: 0, totalBasis: 9_899_998n, finalized: false,
  surplusSnapshot: 0n, basisSnapshot: 0n, surplusClaimed: 0n,
})
const position = (): PositionAccount => ({ address: PAYER.publicKey, owner: PAYER.publicKey, market: PAYER.publicKey, tokens: 10n, basis: 9_899_998n, bump: 0, autoExitDeadline: null })

describe('mainnet smoke refund', () => {
  it('asserts the exact SDK floor until graduation, including fee rounding and the 2-lamport haircut', () => {
    const expected = floorValue(position(), market())
    expect(expected).toBe(9_800_996n)
    expect(assertFloorRefund(position(), market(), expected)).toBe(expected)
    expect(() => assertFloorRefund(position(), market(), expected + 1n)).toThrow('2-lamport haircut')
    expect(() => assertFloorRefund(position(), market(), expected - 1n)).toThrow('refund mismatch')
  })

  it('refuses an empty position and one belonging to another market', () => {
    expect(() => assertFloorRefund({ ...position(), tokens: 0n }, market(), 0n)).toThrow('empty position')
    expect(() => assertFloorRefund({ ...position(), market: Keypair.generate().publicKey }, market(), 0n)).toThrow('belongs to market')
  })
})

describe('mainnet smoke sends', () => {
  const confirmed = { err: null, confirmationStatus: 'confirmed' as const }
  const deps = (status: typeof confirmed | null = null) => ({
    send: vi.fn(async () => 'signature'),
    confirm: vi.fn(async () => { throw new Error('confirmation timed out') }),
    status: vi.fn(async () => status),
  })

  it('checks a known signature after a send error and never retries', async () => {
    const d = deps(confirmed)
    d.send.mockRejectedValue(new Error('response lost'))
    await expect(sendOnce('buy', 'signature', d)).resolves.toBe('signature')
    expect(d.status).toHaveBeenCalledWith('signature')
    expect(d.send).toHaveBeenCalledTimes(1)
  })

  it('accepts a confirmed signature after confirmation fails', async () => {
    const d = deps(confirmed)
    await expect(sendOnce('buy', 'signature', d)).resolves.toBe('signature')
    expect(d.send).toHaveBeenCalledTimes(1)
  })

  it('confirms an ordinary send without a status lookup', async () => {
    const d = { ...deps(), confirm: vi.fn(async () => {}) }
    await expect(sendOnce('buy', 'signature', d)).resolves.toBe('signature')
    expect(d.status).not.toHaveBeenCalled()
  })

  it('stops for absent, processed, failed or unreadable signature status', async () => {
    for (const status of [null, { err: null, confirmationStatus: 'processed' }, { err: { Custom: 1 }, confirmationStatus: 'confirmed' }]) {
      const d = { ...deps(), status: vi.fn(async () => status) }
      await expect(sendOnce('buy', 'signature', d)).rejects.toThrow('not retried')
      expect(d.send).toHaveBeenCalledTimes(1)
    }
    const d = { ...deps(), status: vi.fn(async () => { throw new Error('RPC unavailable') }) }
    await expect(sendOnce('buy', 'signature', d)).rejects.toThrow('not retried')
  })
})

describe('mainnet smoke dry run (mocked RPC, no network)', () => {
  function fixture(programsPresent = true, balance = 100_000_000) {
    const connection = new Connection('https://api.mainnet-beta.solana.com')
    vi.spyOn(connection, 'getGenesisHash').mockResolvedValue(MAINNET_GENESIS)
    vi.spyOn(connection, 'getLatestBlockhash').mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 })
    const program = { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 1, executable: true, rentEpoch: 0 }
    vi.spyOn(connection, 'getMultipleAccountsInfo').mockResolvedValue(programsPresent ? [program, program, null] : [null, null, null])
    vi.spyOn(connection, 'getMinimumBalanceForRentExemption').mockImplementation(async (bytes) => (bytes + 128) * 6_960)
    vi.spyOn(connection, 'getFeeForMessage').mockImplementation(async (message) => ({ context: { slot: 1 }, value: message.header.numRequiredSignatures * 5_000 }))
    vi.spyOn(connection, 'getBalance').mockResolvedValue(balance)
    const send = vi.spyOn(connection, 'sendRawTransaction').mockRejectedValue(new Error('dry run must not send'))
    const simulate = vi.spyOn(connection, 'simulateTransaction')
    const upload = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('dry run must not upload'))
    const output: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true })
    return { connection, send, simulate, upload, output }
  }

  it('prints the complete itemised plan and need, with no upload, simulation or send', async () => {
    const f = fixture()
    await runSmoke(parseOptions([], ENV), f.connection, () => PAYER)
    const lines = f.output.join('')
    expect(lines).toContain('dry run complete')
    expect(lines).toContain('0.046586960')
    expect(lines).toContain('0.056586960')
    for (const account of ['config', 'pool', 'mint', 'baseVault', 'quoteVault', 'market', 'bufferVault', 'hookMetas', 'position', 'baseAta', 'quoteAta']) expect(lines).toContain(`"account":"${account}"`)
    expect(lines).not.toContain(ENV.RPC_URL)
    expect(f.upload).not.toHaveBeenCalled()
    expect(f.simulate).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('reports missing deployments after printing preflight, before any send', async () => {
    const f = fixture(false, 0)
    await expect(runSmoke(parseOptions([], ENV), f.connection, () => PAYER)).rejects.toThrow('router D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb is missing')
    expect(f.output.join('')).toContain('mainnet smoke preflight')
    expect(f.output.join('')).toContain('requiredBalanceSol')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('enforces the computed balance need plus margin even in dry run', async () => {
    const f = fixture(true, 56_586_959)
    await expect(runSmoke(parseOptions([], ENV), f.connection, () => PAYER)).rejects.toThrow('computed need plus 0.01 SOL margin')
    expect(f.upload).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })
})

describe('mainnet smoke execute (mocked RPC and files, no network)', () => {
  function fixture(refundDelta = 0n) {
    const connection = new Connection('https://api.mainnet-beta.solana.com')
    const cluster = getClusterConfig('mainnet-beta')
    const program = { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 1, executable: true, rentEpoch: 0 }
    vi.spyOn(connection, 'getGenesisHash').mockResolvedValue(MAINNET_GENESIS)
    vi.spyOn(connection, 'getLatestBlockhash').mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 })
    vi.spyOn(connection, 'getMultipleAccountsInfo').mockResolvedValue([program, program, null])
    vi.spyOn(connection, 'getMinimumBalanceForRentExemption').mockImplementation(async (bytes) => (bytes + 128) * 6_960)
    vi.spyOn(connection, 'getFeeForMessage').mockImplementation(async (message) => ({ context: { slot: 1 }, value: message.header.numRequiredSignatures * 5_000 }))
    vi.spyOn(connection, 'getBalance').mockResolvedValue(100_000_000)
    const simulate = vi.spyOn(connection, 'simulateTransaction').mockImplementation(async (tx, config) => {
      expect(tx).toBeInstanceOf(VersionedTransaction)
      expect((tx as VersionedTransaction).signatures[0]!.some((n) => n !== 0)).toBe(true)
      expect(config).toMatchObject({ sigVerify: true })
      return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ ...program, owner: program.owner.toBase58(), data: ['', 'base64'], lamports: 70_000_000 }] } }
    })
    const send = vi.spyOn(connection, 'sendRawTransaction').mockImplementation(async (wire, options) => {
      expect(options).toMatchObject({ maxRetries: 0 })
      const tx = Transaction.from(Buffer.from(wire))
      return (await import('node:module')).createRequire(import.meta.url)('bs58').encode(tx.signature!) as string
    })
    vi.spyOn(connection, 'confirmTransaction').mockResolvedValue({ context: { slot: 1 }, value: { err: null } })
    vi.mocked(fetchMarket).mockImplementation(async (_connection, address) => ({ ...market(), address }))
    vi.mocked(quoteBuy).mockResolvedValue({ tokensOut: 10n, netIntoCurve: 9_900_000n, basisAdded: 9_899_998n, fee: 100_000n })
    const buffer = () => {
      const data = Buffer.alloc(97)
      data.set([170, 188, 143, 228, 122, 64, 247, 208])
      data.set(PAYER.publicKey.toBytes(), 8)
      data.set(vi.mocked(fetchMarket).mock.calls.at(-1)![1].toBytes(), 40)
      data.writeBigUInt64LE(10n, 72)
      data.writeBigUInt64LE(9_899_998n, 80)
      return data
    }
    vi.spyOn(connection, 'getAccountInfo').mockImplementation(async () => {
      if (send.mock.calls.length === 4) return { ...program, executable: false, owner: cluster.routerProgramId, data: buffer() }
      if (send.mock.calls.length === 5) {
        const data = buffer()
        data.writeBigUInt64LE(0n, 72)
        data.writeBigUInt64LE(0n, 80)
        return { ...program, executable: false, owner: cluster.routerProgramId, data }
      }
      return null
    })
    const balance = vi.spyOn(connection, 'getTokenAccountBalance').mockResolvedValueOnce({ context: { slot: 1 }, value: { amount: '123', decimals: 9, uiAmount: null } })
      .mockResolvedValueOnce({ context: { slot: 1 }, value: { amount: (123n + 9_800_996n + refundDelta).toString(), decimals: 9, uiAmount: null } })
    const upload = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => options?.method === 'POST'
      ? new Response(JSON.stringify({ uri: 'https://trucee.fun/api/metadata/smoke', image: 'https://trucee.fun/api/metadata/smoke/image' }), { status: 201 })
      : new Response('ok'))
    const output: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const records: string[] = []
    vi.mocked(fs.writeFileSync).mockImplementation((_path, content) => { records.push(String(content)) })
    return { connection, simulate, send, balance, upload, output, records }
  }

  it('launches, buys, verifies the exact quote delta, exits the whole position and closes wSOL', async () => {
    const f = fixture()
    await runSmoke(parseOptions(['--execute'], ENV), f.connection, () => PAYER)
    expect(f.send).toHaveBeenCalledTimes(6)
    const result = JSON.parse(f.records.at(-1)!)
    expect(result).toMatchObject({ complete: true, name: 'Trucee Smoke Test', symbol: 'TSMOKE', basisLamports: '9899998', tokens: '10', receivedLamports: '9800996', haircutLamports: '2' })
    expect(result.transactions).toHaveLength(6)
    expect(result.transactions.every((tx: { confirmed: boolean }) => tx.confirmed)).toBe(true)
    expect(f.output.join('')).toContain(`HIDDEN_MARKETS=${result.market}\n`)
    const files = f.records.join('')
    expect(files).not.toContain('?cluster')
    expect(files).not.toContain(ENV.RPC_URL)
    expect(files).not.toContain(JSON.stringify(Array.from(PAYER.secretKey)))
    const form = f.upload.mock.calls[0]![1]!.body as FormData
    const image = form.get('image') as Blob
    expect(image.type).toBe('image/png')
    expect(Array.from(new Uint8Array(await image.arrayBuffer()).subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })

  it('stops on a one-lamport refund mismatch, without sending cleanup after the failure', async () => {
    const f = fixture(1n)
    await expect(runSmoke(parseOptions(['--execute'], ENV), f.connection, () => PAYER)).rejects.toThrow('refund mismatch')
    expect(f.send).toHaveBeenCalledTimes(5)
    expect(JSON.parse(f.records.at(-1)!)).toMatchObject({ complete: false, stopped: true, receivedLamports: '9800997' })
  })

  it('refuses an existing result before metadata upload or a send', async () => {
    const f = fixture()
    vi.mocked(fs.existsSync).mockReturnValue(true)
    await expect(runSmoke(parseOptions(['--execute'], ENV), f.connection, () => PAYER)).rejects.toThrow('inspect its signatures')
    expect(f.upload).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('stops before sending when simulation reaches the total spend limit', async () => {
    const f = fixture()
    f.simulate.mockResolvedValue({ context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ data: ['', 'base64'], owner: SystemProgram.programId.toBase58(), lamports: 50_010_000, executable: false }] } })
    await expect(runSmoke(parseOptions(['--execute'], ENV), f.connection, () => PAYER)).rejects.toThrow('simulated spend would exceed')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('stops before sending when simulation fails', async () => {
    const f = fixture()
    f.simulate.mockResolvedValue({ context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: 123 }] }, logs: [] } })
    await expect(runSmoke(parseOptions(['--execute'], ENV), f.connection, () => PAYER)).rejects.toThrow('simulation failed')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('persists the signed signature when a send may have landed, then stops without another send', async () => {
    const f = fixture()
    f.send.mockRejectedValue(new Error('response lost'))
    const status = vi.spyOn(f.connection, 'getSignatureStatus').mockResolvedValue({ context: { slot: 1 }, value: null })
    await expect(runSmoke(parseOptions(['--execute'], ENV), f.connection, () => PAYER)).rejects.toThrow('not retried')
    const result = JSON.parse(f.records.at(-1)!)
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].confirmed).toBe(false)
    expect(status).toHaveBeenCalledWith(result.transactions[0].signature, { searchTransactionHistory: true })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('does not send when metadata upload fails', async () => {
    const f = fixture()
    f.upload.mockResolvedValue(new Response('unavailable', { status: 503 }))
    await expect(runSmoke(parseOptions(['--execute'], ENV), f.connection, () => PAYER)).rejects.toThrow('metadata upload failed: HTTP 503')
    expect(f.send).not.toHaveBeenCalled()
  })
})
