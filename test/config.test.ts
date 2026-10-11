import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, Keypair } from '@solana/web3.js'
import { getClusterConfig } from '@trucee/sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultCrankGuards, loadConfig, loadCrankKeypair, quoteMinimums, type WorkerConfig } from '../src/config.js'
import { startCrank, type CrankContext, type CrankJob } from '../src/crank/index.js'
import { log, registerSecret } from '../src/log.js'

const SECRET = 'SECRETKEY'
const SECRET_RPC_URL = `https://example.invalid/v2/${SECRET}`
const LOCAL_RPC_URL = 'http://127.0.0.1:8899'
const TEST_INTERVAL_MS = 5

type LogEntry = Record<string, unknown>

function thrownText(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof Error) {
      return [err.message, err.stack ?? '', String(err.cause ?? ''), JSON.stringify(err)].join('\n')
    }
    return String(err)
  }
  throw new Error('expected the call to throw')
}

function captureStdout(): { raw: () => string; entries: () => LogEntry[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  return {
    raw: () => chunks.join(''),
    entries: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LogEntry),
    restore: () => spy.mockRestore(),
  }
}

let tempDir = ''
let keypairPath = ''
let testKeypair: Keypair

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trucee-worker-test-'))
  testKeypair = Keypair.generate()
  keypairPath = join(tempDir, 'crank.json')
  writeFileSync(keypairPath, JSON.stringify(Array.from(testKeypair.secretKey)))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadConfig', () => {
  it('throws when RPC_URL is missing', () => {
    expect(() => loadConfig({ CLUSTER: 'devnet' })).toThrow(/RPC_URL/)
  })

  it('throws when RPC_URL is empty', () => {
    expect(() => loadConfig({ CLUSTER: 'devnet', RPC_URL: '' })).toThrow(/RPC_URL/)
  })

  it('throws when CLUSTER is missing', () => {
    expect(() => loadConfig({ RPC_URL: SECRET_RPC_URL })).toThrow(/CLUSTER/)
  })

  it('throws when CLUSTER is invalid', () => {
    expect(() => loadConfig({ CLUSTER: 'testnet', RPC_URL: SECRET_RPC_URL })).toThrow(/CLUSTER/)
  })

  it('throws when CRANK_INTERVAL_MS or MAX_TX_PER_TICK are not positive integers', () => {
    const base = { CLUSTER: 'devnet', RPC_URL: SECRET_RPC_URL }
    expect(() => loadConfig({ ...base, CRANK_INTERVAL_MS: 'soon' })).toThrow(/CRANK_INTERVAL_MS/)
    expect(() => loadConfig({ ...base, CRANK_INTERVAL_MS: '1' })).toThrow(/CRANK_INTERVAL_MS/)
    expect(() => loadConfig({ ...base, MAX_TX_PER_TICK: '0' })).toThrow(/MAX_TX_PER_TICK/)
    expect(() => loadConfig({ ...base, MAX_TX_PER_TICK: '2.5' })).toThrow(/MAX_TX_PER_TICK/)
  })

  it('parses a valid env and applies the defaults', () => {
    const cfg = loadConfig({ CLUSTER: 'devnet', RPC_URL: SECRET_RPC_URL })

    expect(cfg).toEqual<WorkerConfig>({
      cluster: 'devnet',
      rpcUrl: SECRET_RPC_URL,
      crankKeypairPath: join(homedir(), '.config', 'solana', 'id.json'),
      crankIntervalMs: 15000,
      maxTxPerTick: 10,
      minAtaValueLamports: 250_000_000n,
      maxAtaCreatesPerTick: 2,
      crankMinSolLamports: 50_000_000n,
      minMigrateThresholdSolLamports: 0n,
    })
  })

  it('parses explicit overrides and expands ~ in CRANK_KEYPAIR', () => {
    const cfg = loadConfig({
      CLUSTER: 'localnet',
      RPC_URL: LOCAL_RPC_URL,
      CRANK_KEYPAIR: '~/keys/crank.json',
      CRANK_INTERVAL_MS: '500',
      MAX_TX_PER_TICK: '3',
      MIN_ATA_VALUE_LAMPORTS: '0',
      MAX_ATA_CREATES_PER_TICK: '0',
      CRANK_MIN_SOL_LAMPORTS: '1000000000',
      MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS: '303000000',
    })

    expect(cfg).toEqual<WorkerConfig>({
      cluster: 'localnet',
      rpcUrl: LOCAL_RPC_URL,
      crankKeypairPath: join(homedir(), 'keys', 'crank.json'),
      crankIntervalMs: 500,
      maxTxPerTick: 3,
      minAtaValueLamports: 0n,
      maxAtaCreatesPerTick: 0,
      crankMinSolLamports: 1_000_000_000n,
      minMigrateThresholdSolLamports: 303_000_000n,
    })
  })

  it('defaults MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS by cluster: 1 SOL on mainnet-beta, 0 on devnet and localnet', () => {
    const base = { RPC_URL: SECRET_RPC_URL }

    expect(loadConfig({ ...base, CLUSTER: 'mainnet-beta' }).minMigrateThresholdSolLamports).toBe(1_000_000_000n)
    expect(loadConfig({ ...base, CLUSTER: 'mainnet-beta', MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS: '' }).minMigrateThresholdSolLamports).toBe(1_000_000_000n)
    expect(loadConfig({ ...base, CLUSTER: 'mainnet-beta', MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS: '0' }).minMigrateThresholdSolLamports).toBe(0n)
    expect(loadConfig({ ...base, CLUSTER: 'devnet' }).minMigrateThresholdSolLamports).toBe(0n)
    expect(loadConfig({ ...base, CLUSTER: 'localnet' }).minMigrateThresholdSolLamports).toBe(0n)
    expect(defaultCrankGuards('mainnet-beta')).toEqual({
      minAtaValueLamports: 250_000_000n,
      maxAtaCreatesPerTick: 2,
      crankMinSolLamports: 50_000_000n,
      minMigrateThresholdSolLamports: 1_000_000_000n,
    })
  })

  it('builds per-quote-mint minimums: the wSOL row from the guards, xStocks fixed in raw units, no other mint', () => {
    const mainnetQuotes = getClusterConfig('mainnet-beta').quoteMints
    const mainnet = quoteMinimums({ ...defaultCrankGuards('mainnet-beta'), minAtaValueLamports: 7n }, mainnetQuotes)
    const devnet = quoteMinimums(defaultCrankGuards('devnet'), getClusterConfig('devnet').quoteMints)

    expect(Object.fromEntries(mainnetQuotes.map((quote) => [quote.symbol, mainnet.get(quote.mint.toBase58())]))).toEqual({
      SOL: { ataValue: 7n, migrateThreshold: 1_000_000_000n },
      TSLAx: { ataValue: 10_000_000n, migrateThreshold: 100_000_000n },
      NVDAx: { ataValue: 10_000_000n, migrateThreshold: 100_000_000n },
    })
    expect(mainnet.size).toBe(3)
    expect([...devnet.values()]).toEqual([{ ataValue: 250_000_000n, migrateThreshold: 0n }])
  })

  it.each(['MIN_ATA_VALUE_LAMPORTS', 'MAX_ATA_CREATES_PER_TICK', 'CRANK_MIN_SOL_LAMPORTS', 'MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS'])(
    'throws when %s is not a non-negative integer',
    (key) => {
      const base = { CLUSTER: 'devnet', RPC_URL: SECRET_RPC_URL }
      for (const bad of [' ', '0x10', '1e3', '-1', '+1', '2.5', 'lots', '9007199254740993']) {
        expect(() => loadConfig({ ...base, [key]: bad })).toThrow(new RegExp(`${key} must be a non-negative integer`))
      }
    },
  )

  it('trims surrounding whitespace from the guard values', () => {
    const cfg = loadConfig({ CLUSTER: 'devnet', RPC_URL: SECRET_RPC_URL, MIN_ATA_VALUE_LAMPORTS: ' 7 ', MAX_ATA_CREATES_PER_TICK: '\t3\n' })

    expect([cfg.minAtaValueLamports, cfg.maxAtaCreatesPerTick]).toEqual([7n, 3])
  })

  it('never puts the RPC_URL value in the thrown error', () => {
    const badEnvs: NodeJS.ProcessEnv[] = [
      { CLUSTER: 'testnet', RPC_URL: SECRET_RPC_URL },
      { CLUSTER: 'devnet', RPC_URL: SECRET_RPC_URL, CRANK_INTERVAL_MS: 'never' },
      { CLUSTER: 'devnet', RPC_URL: `ftp://example.invalid/v2/${SECRET}` },
      { CLUSTER: 'devnet', RPC_URL: `not a url ${SECRET}` },
    ]

    for (const env of badEnvs) {
      const text = thrownText(() => loadConfig(env))
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('example.invalid')
    }
  })
})

describe('loadCrankKeypair', () => {
  it('loads a solana-keygen JSON keypair file', () => {
    const kp = loadCrankKeypair(keypairPath)

    expect(kp.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58())
  })

  it('throws a clear error when the file is missing', () => {
    expect(() => loadCrankKeypair(join(tempDir, 'missing.json'))).toThrow(/crank keypair/i)
  })

  it('throws without echoing the file contents when the file is not a keypair', () => {
    const notJson = join(tempDir, 'not-json.json')
    const wrongShape = join(tempDir, 'wrong-shape.json')
    writeFileSync(notJson, `${SECRET} is not json`)
    writeFileSync(wrongShape, JSON.stringify([1, 2, 3]))

    for (const path of [notJson, wrongShape]) {
      const text = thrownText(() => loadCrankKeypair(path))
      expect(text).toMatch(/crank keypair/i)
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('1,2,3')
    }
  })
})

describe('log', () => {
  it('writes one JSON line per call and redacts URL values in ctx to their host', () => {
    const out = captureStdout()

    log.info('hello', { rpc: SECRET_RPC_URL, note: `failed to reach ${SECRET_RPC_URL} today`, n: 1 })
    log.warn('careful')
    log.error('boom', { nested: { url: SECRET_RPC_URL }, big: 5n })
    out.restore()

    const entries = out.entries()
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ level: 'info', msg: 'hello', rpc: 'example.invalid', n: 1 })
    expect(entries[0]?.note).toBe('failed to reach example.invalid today')
    expect(entries[1]).toMatchObject({ level: 'warn', msg: 'careful' })
    expect(entries[2]).toMatchObject({ level: 'error', msg: 'boom', nested: { url: 'example.invalid' }, big: '5' })
    expect(typeof entries[0]?.ts).toBe('string')
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })

  it('keeps ts, level and msg when ctx uses the same keys', () => {
    const out = captureStdout()

    log.info('real', { level: 'fake', msg: 'fake' })
    out.restore()

    expect(out.entries()[0]).toMatchObject({ level: 'info', msg: 'real' })
  })

  it('never dumps Keypair, Connection, URL, Buffer or Uint8Array internals', () => {
    const kp = Keypair.generate()
    const secretBytes = Array.from(kp.secretKey)
    const out = captureStdout()

    log.info('objects', {
      kp,
      conn: new Connection(SECRET_RPC_URL),
      url: new URL(SECRET_RPC_URL),
      buf: Buffer.from(kp.secretKey),
      bytes: kp.secretKey,
      nested: { list: [kp], map: new Map([['k', kp]]) },
    })
    out.restore()

    const line = out.raw()
    expect(out.entries()[0]).toMatchObject({
      kp: '[Keypair]',
      conn: '[Connection]',
      url: '[URL]',
      buf: '[Buffer]',
      bytes: '[Uint8Array]',
      nested: { list: ['[Keypair]'], map: '[Map]' },
    })
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('example.invalid')
    expect(line).not.toContain(secretBytes.slice(0, 8).join(','))
    expect(line).not.toContain(`"0":${secretBytes[0]},"1":${secretBytes[1]}`)
    expect(line).not.toContain(Buffer.from(kp.secretKey).toString('base64'))
    expect(line).not.toContain(Buffer.from(kp.secretKey).toString('hex'))
  })

  it('logs a PublicKey as base58 and a Date as an ISO string', () => {
    const kp = Keypair.generate()
    const out = captureStdout()

    log.info('values', { pub: kp.publicKey, at: new Date(0), bad: new Date(Number.NaN) })
    out.restore()

    expect(out.entries()[0]).toMatchObject({
      pub: kp.publicKey.toBase58(),
      at: '1970-01-01T00:00:00.000Z',
      bad: '[Invalid Date]',
    })
  })

  it('scrubs registered secrets from the whole line and ignores values shorter than 8 chars', () => {
    const secret = 'sk-live-0123456789'
    registerSecret(secret)
    registerSecret('tiny')
    const out = captureStdout()

    log.error(`request with ${secret} failed`, {
      detail: `path /v2/${secret}`,
      nested: { key: secret },
      err: new Error(`bad key ${secret}`),
      small: 'tiny',
    })
    out.restore()

    expect(out.raw()).not.toContain(secret)
    expect(out.entries()[0]).toMatchObject({
      msg: 'request with [redacted] failed',
      detail: 'path /v2/[redacted]',
      nested: { key: '[redacted]' },
      err: 'bad key [redacted]',
      small: 'tiny',
    })
  })

  it('scrubs a registered secret that JSON escapes inside the line', () => {
    const secret = 'quote"and\\slash-secret'
    registerSecret(secret)
    const out = captureStdout()

    log.info('escaped', { value: secret })
    out.restore()

    expect(out.entries()[0]?.value).toBe('[redacted]')
  })
})

describe('startCrank', () => {
  function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
    return {
      cluster: 'devnet',
      rpcUrl: LOCAL_RPC_URL,
      crankKeypairPath: keypairPath,
      crankIntervalMs: TEST_INTERVAL_MS,
      maxTxPerTick: 10,
      ...defaultCrankGuards('devnet'),
      ...overrides,
    }
  }

  it('keeps ticking when a job throws, logs the error and still runs later jobs', async () => {
    const out = captureStdout()
    const counts = { boom: 0, after: 0 }
    const boom: CrankJob = {
      name: 'boom',
      run: async () => {
        counts.boom += 1
        throw new Error('kaboom')
      },
    }
    const after: CrankJob = {
      name: 'after',
      run: async () => {
        counts.after += 1
        return { sent: [], skipped: 1, errors: [] }
      },
    }

    const crank = await startCrank(testConfig(), [boom, after])
    await vi.waitFor(() => expect(counts.boom).toBeGreaterThanOrEqual(2), { timeout: 2000, interval: 5 })
    await crank.stop()
    out.restore()

    expect(counts.after).toBeGreaterThanOrEqual(1)
    const failures = out.entries().filter((e) => e.level === 'error' && e.job === 'boom')
    expect(failures.length).toBeGreaterThanOrEqual(2)
    expect(failures[0]).toMatchObject({ msg: 'crank job failed', error: 'kaboom' })
  })

  it('stops ticking after stop() resolves', async () => {
    const out = captureStdout()
    const counter = { runs: 0 }
    const job: CrankJob = {
      name: 'count',
      run: async () => {
        counter.runs += 1
        return { sent: [], skipped: 0, errors: [] }
      },
    }

    const crank = await startCrank(testConfig(), [job])
    await vi.waitFor(() => expect(counter.runs).toBeGreaterThanOrEqual(1), { timeout: 2000, interval: 5 })
    await crank.stop()
    const runsAtStop = counter.runs
    await new Promise((resolve) => setTimeout(resolve, TEST_INTERVAL_MS * 10))
    out.restore()

    expect(counter.runs).toBe(runsAtStop)
  })

  it('gives each job the payer, a connection and the remaining tx budget of the tick', async () => {
    const out = captureStdout()
    const seen: CrankContext[] = []
    const sender: CrankJob = {
      name: 'sender',
      run: async (ctx) => {
        seen.push(ctx)
        return { sent: ['sig-1', 'sig-2'], skipped: 0, errors: [] }
      },
    }
    const reader: CrankJob = {
      name: 'reader',
      run: async (ctx) => {
        seen.push(ctx)
        return { sent: [], skipped: 0, errors: [] }
      },
    }

    const crank = await startCrank(testConfig({ maxTxPerTick: 5 }), [sender, reader])
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2), { timeout: 2000, interval: 5 })
    await crank.stop()
    out.restore()

    expect(seen[0]?.maxTx).toBe(5)
    expect(seen[1]?.maxTx).toBe(3)
    expect(seen[0]?.payer.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58())
    expect(seen[0]?.connection.rpcEndpoint).toBe(LOCAL_RPC_URL)
    expect(seen[0]?.log).toBe(log)
  })
})
