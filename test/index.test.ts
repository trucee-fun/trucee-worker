/**
 * The worker entrypoint registers every crank job, in tick order, with the guards of its env config; it never
 * exits as a silent no-op when started; and it scrubs every part of the RPC URL that could carry the API key.
 * Finalize gets the env guards too, and library output on stderr is scrubbed like a log line.
 * One scrub covers stdout, stderr and every console method, and main() installs it before the config loads.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair, type Connection } from '@solana/web3.js'
import { getClusterConfig } from '@trucee/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CRANK_MIN_SOL_LAMPORTS,
  DEFAULT_MIN_ATA_VALUE_LAMPORTS,
  loadConfig,
  loadCrankKeypair,
  type WorkerConfig,
} from '../src/config.js'
import type { CrankContext } from '../src/crank/index.js'
import { createAutoExitJob } from '../src/crank/jobs/auto-exit.js'
import { createClaimsJob } from '../src/crank/jobs/claims.js'
import { createFinalizeJob } from '../src/crank/jobs/finalize.js'
import { createMigrateJob } from '../src/crank/jobs/migrate.js'
import { log, registerSecret, type Logger } from '../src/log.js'
import { buildJobs, installOutputScrub, protectRpcUrl, shouldStartWorker } from '../src/index.js'

/** bs58 comes with @solana/web3.js and ships no types: the wallet export form of a secret key. */
const bs58 = createRequire(import.meta.url)('bs58') as { readonly encode: (bytes: Uint8Array) => string }

vi.mock('../src/crank/jobs/finalize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/crank/jobs/finalize.js')>()
  return { ...actual, createFinalizeJob: vi.fn(actual.createFinalizeJob) }
})
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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('buildJobs', () => {
  it('registers finalize, migrate, claims and auto-exit in that order', () => {
    const jobs = buildJobs(configFromEnv())

    expect(jobs.map((job) => job.name)).toEqual(JOB_ORDER)
  })

  it('builds every job from its cfg-aware factory with MIN_ATA_VALUE_LAMPORTS and CRANK_MIN_SOL_LAMPORTS from the env', () => {
    const cfg = configFromEnv()
    expect(ENV_MIN_ATA_VALUE_LAMPORTS).not.toBe(DEFAULT_MIN_ATA_VALUE_LAMPORTS)
    expect(ENV_CRANK_MIN_SOL_LAMPORTS).not.toBe(DEFAULT_CRANK_MIN_SOL_LAMPORTS)
    const envGuards = expect.objectContaining({
      minAtaValueLamports: ENV_MIN_ATA_VALUE_LAMPORTS,
      crankMinSolLamports: ENV_CRANK_MIN_SOL_LAMPORTS,
    })

    buildJobs(cfg)

    expect(createFinalizeJob).toHaveBeenCalledTimes(1)
    expect(createFinalizeJob).toHaveBeenCalledWith(envGuards)
    expect(createMigrateJob).toHaveBeenCalledTimes(1)
    expect(createMigrateJob).toHaveBeenCalledWith({}, envGuards)
    expect(createClaimsJob).toHaveBeenCalledTimes(1)
    expect(createClaimsJob).toHaveBeenCalledWith(envGuards)
    expect(createAutoExitJob).toHaveBeenCalledTimes(1)
    expect(createAutoExitJob).toHaveBeenCalledWith(envGuards)
  })

  it('every job plans nothing while the payer holds less than CRANK_MIN_SOL_LAMPORTS from the env', async () => {
    // Above the 0.05 SOL default floor, below the env floor: only the env value can stop the scans.
    const balance = ENV_CRANK_MIN_SOL_LAMPORTS - 1n
    expect(balance).toBeGreaterThan(DEFAULT_CRANK_MIN_SOL_LAMPORTS)
    const jobs = buildJobs(configFromEnv())
    expect(jobs.map((job) => job.name)).toEqual(JOB_ORDER)

    for (const job of jobs) {
      const { ctx, getProgramAccounts, log } = contextWithBalance(balance)

      const result = await job.run(ctx)

      expect(result, job.name).toEqual({ sent: [], skipped: 0, errors: [] })
      expect(getProgramAccounts, job.name).not.toHaveBeenCalled()
      expect(log.warn, job.name).toHaveBeenCalledTimes(1)
      expect(log.warn, job.name).toHaveBeenCalledWith(
        expect.stringContaining('CRANK_MIN_SOL_LAMPORTS'),
        expect.objectContaining({ minLamports: ENV_CRANK_MIN_SOL_LAMPORTS }),
      )
    }
  })

  it('every job scans the chain once the payer holds CRANK_MIN_SOL_LAMPORTS from the env', async () => {
    for (const job of buildJobs(configFromEnv())) {
      const { ctx, getProgramAccounts } = contextWithBalance(ENV_CRANK_MIN_SOL_LAMPORTS)

      await job.run(ctx)

      expect(getProgramAccounts, job.name).toHaveBeenCalled()
    }
  })
})

/** An RPC URL whose path and query carry the key, as a library would quote it on a connection error. */
const RPC_HOST = 'x.invalid'
const RPC_PATH_KEY = 'SECRETKEY'
const RPC_QUERY_KEY = 'QUERYKEY9'
const SECRET_RPC_URL = `https://${RPC_HOST}/v2/${RPC_PATH_KEY}?api-key=${RPC_QUERY_KEY}`
/** The URL without scheme and host, as a request line quotes it: only the registered parts, no URL pattern, match it. */
const RPC_PATH_AND_QUERY = `/v2/${RPC_PATH_KEY}?api-key=${RPC_QUERY_KEY}`

/** `output` names neither the RPC host nor anything of its path or query. */
function expectNoRpcUrlPart(output: string): void {
  expect(output).not.toContain(RPC_HOST)
  expect(output).not.toContain(RPC_PATH_KEY)
  expect(output).not.toContain(RPC_QUERY_KEY)
}

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_PATH = join(WORKER_DIR, 'src', 'index.ts')
const SPAWN_TIMEOUT_MS = 20_000

interface ChildRun {
  readonly code: number | null
  readonly output: string
}

/** Runs node in worker/ with `args` and an env without any worker config but `extra`; resolves on exit. */
function runNode(args: readonly string[], extra: Readonly<Record<string, string>>): Promise<ChildRun> {
  const { RPC_URL: _rpc, DEVNET_RPC: _devnet, CLUSTER: _cluster, CRANK_FORCE_START: _force, ...inherited } = process.env
  return new Promise((done) => {
    execFile(process.execPath, [...args], { cwd: WORKER_DIR, env: { ...inherited, ...extra }, timeout: SPAWN_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null
      done({ code, output: `${stdout}${stderr}` })
    })
  })
}

/** Runs `script` as an ES module from `node -e` in worker/: process.argv[1] is undefined, as under another runner. */
const nodeScript = (script: string): string[] => ['--import', 'tsx', '--input-type=module', '-e', script]
const IMPORT_INDEX_SCRIPT = "await import('./src/index.ts')"
/** Imports src/index.ts from `node -e`, as another runner would load it. */
const IMPORT_INDEX = nodeScript(IMPORT_INDEX_SCRIPT)

/**
 * Turns os.homedir, which loadConfig calls to expand a `~` CRANK_KEYPAIR, into a library failing at config time: it
 * prints the RPC URL, and its path and query alone, on every console method and both streams, then throws an error
 * quoting the URL. Patched before the import, so it fires inside main()'s loadConfig.
 */
const HOMEDIR_FAILS_QUOTING_RPC_URL = `
const os = process.getBuiltinModule('node:os')
os.homedir = () => {
  const url = process.env.RPC_URL
  const { pathname, search } = new URL(url)
  console.log('lib log', url)
  console.info('lib info', pathname + search)
  console.debug('lib debug', url)
  console.warn('lib warn', pathname + search)
  console.error(new Error('lib error: ' + url))
  process.stdout.write('lib stdout GET ' + pathname + search + '\\n')
  process.stderr.write(Buffer.from('lib stderr ' + url + ' ' + pathname + search + '\\n'))
  throw new Error('fetch failed: ' + url)
}
process.getBuiltinModule('node:module').syncBuiltinESMExports()
`
/** CRANK_KEYPAIR under ~, so loadConfig calls os.homedir; the file is never read. */
const HOME_KEYPAIR = '~/no-such-keypair.json'

/**
 * Points the worker's worker/.env (absolute path in WORKER_ENV_FILE) at the file in TEMP_ENV_FILE: the real loader
 * reads the temp file, and no worker/.env in the checkout is read or written.
 */
const WORKER_ENV_FILE_IS_TEMP_ENV = `
const fs = process.getBuiltinModule('node:fs')
const { WORKER_ENV_FILE: workerEnv, TEMP_ENV_FILE: tempEnv } = process.env
const exists = fs.existsSync
fs.existsSync = (path) => path === workerEnv || exists(path)
process.getBuiltinModule('node:module').syncBuiltinESMExports()
const loadEnvFile = process.loadEnvFile
process.loadEnvFile = (path) => loadEnvFile(path === workerEnv ? tempEnv : path)
`

describe('worker start', () => {
  it('npm start and the Docker CMD (node --import tsx src/index.ts) run main(): an invalid config exits non-zero with the config error', async () => {
    const run = await runNode(['--import', 'tsx', 'src/index.ts'], { CLUSTER: 'bogus' })

    expect(run.code).not.toBe(0)
    expect(run.output).toContain('worker failed to start')
    expect(run.output).toContain('Invalid worker config')
    expect(run.output).toContain('CLUSTER must be one of')
  }, SPAWN_TIMEOUT_MS)

  it('an import with CRANK_FORCE_START=1 runs main()', async () => {
    const run = await runNode(IMPORT_INDEX, { CLUSTER: 'bogus', CRANK_FORCE_START: '1' })

    expect(run.code).not.toBe(0)
    expect(run.output).toContain('Invalid worker config')
  }, SPAWN_TIMEOUT_MS)

  it('an import without CRANK_FORCE_START starts nothing', async () => {
    const run = await runNode(IMPORT_INDEX, { CLUSTER: 'bogus' })

    expect(run).toEqual({ code: 0, output: '' })
  }, SPAWN_TIMEOUT_MS)

  it('main() keeps the scrub after the config loads: library lines quoting the RPC URL keep neither its key nor its host', async () => {
    // A missing keypair stops main() after the config loads and before anything touches the network.
    const libraryWrites = `
      const url = process.env.RPC_URL
      process.stderr.write('lib error ' + url + '\\n')
      console.error('ws error:', url)
      console.log('request', '${RPC_PATH_AND_QUERY}')
      process.stdout.write('GET ${RPC_PATH_AND_QUERY}\\n')
    `
    const env = { CLUSTER: 'devnet', RPC_URL: SECRET_RPC_URL, CRANK_KEYPAIR: './no-such-keypair.json', CRANK_FORCE_START: '1' }

    const run = await runNode(nodeScript(`${IMPORT_INDEX_SCRIPT}\n${libraryWrites}`), env)

    expect(run.code).not.toBe(0)
    expect(run.output).toContain('worker failed to start')
    expect(run.output).toContain('lib error [redacted]')
    expect(run.output).toContain('ws error: [redacted]')
    expect(run.output).toContain('request [redacted]')
    expect(run.output).toContain('GET [redacted]')
    expectNoRpcUrlPart(run.output)
  }, SPAWN_TIMEOUT_MS)

  it('main() scrubs before loadConfig: a library throwing inside loadConfig with the RPC URL prints no URL path or query', async () => {
    const env = { CLUSTER: 'devnet', RPC_URL: SECRET_RPC_URL, CRANK_KEYPAIR: HOME_KEYPAIR, CRANK_FORCE_START: '1' }

    const run = await runNode(nodeScript(`${HOMEDIR_FAILS_QUOTING_RPC_URL}\n${IMPORT_INDEX_SCRIPT}`), env)

    expect(run.code).not.toBe(0)
    expect(run.output).toContain('worker failed to start')
    expect(run.output).toContain('fetch failed: [redacted]')
    for (const line of ['lib log [redacted]', 'lib info [redacted]', 'lib debug [redacted]', 'lib warn [redacted]']) {
      expect(run.output).toContain(line)
    }
    expect(run.output).toContain('lib error: [redacted]')
    expect(run.output).toContain('lib stdout GET [redacted]')
    expect(run.output).toContain('lib stderr [redacted] [redacted]')
    expectNoRpcUrlPart(run.output)
  }, SPAWN_TIMEOUT_MS)

  it('RPC_URL set only in worker/.env is registered as soon as the file loads: a loadConfig error quoting it prints no URL path or query', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'trucee-worker-env-'))
    try {
      const tempEnvFile = join(tempDir, '.env')
      writeFileSync(tempEnvFile, `RPC_URL=${SECRET_RPC_URL}\n`)
      // No RPC_URL in the process env (runNode drops it): only the .env file sets it.
      const env = {
        CLUSTER: 'devnet',
        CRANK_KEYPAIR: HOME_KEYPAIR,
        CRANK_FORCE_START: '1',
        WORKER_ENV_FILE: join(realpathSync(WORKER_DIR), '.env'),
        TEMP_ENV_FILE: tempEnvFile,
      }
      const script = `${WORKER_ENV_FILE_IS_TEMP_ENV}\n${HOMEDIR_FAILS_QUOTING_RPC_URL}\n${IMPORT_INDEX_SCRIPT}`

      const run = await runNode(nodeScript(script), env)

      expect(run.code).not.toBe(0)
      expect(run.output).toContain('worker failed to start')
      // loadConfig got as far as os.homedir with the URL from the file, so the throw quotes it.
      expect(run.output).toContain('fetch failed: [redacted]')
      expect(run.output).toContain('lib info [redacted]')
      expect(run.output).toContain('lib stdout GET [redacted]')
      expectNoRpcUrlPart(run.output)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, SPAWN_TIMEOUT_MS)
})

/** Captures logger output (stdout) while `fn` runs. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return chunks.join('')
}

describe('shouldStartWorker', () => {
  const missingScript = join(WORKER_DIR, 'no-such-dir', 'start-script.ts')

  it('starts when the start script is this module, silently', () => {
    let started = false
    const output = captureStdout(() => {
      started = shouldStartWorker(INDEX_PATH, {}, INDEX_PATH)
    })

    expect(started).toBe(true)
    expect(output).toBe('')
  })

  it('does not start when imported (another start script, or none), silently', () => {
    let started: boolean[] = []
    const output = captureStdout(() => {
      started = [shouldStartWorker(join(WORKER_DIR, 'package.json'), {}, INDEX_PATH), shouldStartWorker(undefined, {}, INDEX_PATH)]
    })

    expect(started).toEqual([false, false])
    expect(output).toBe('')
  })

  it('starts when imported with CRANK_FORCE_START=1', () => {
    expect(shouldStartWorker(undefined, { CRANK_FORCE_START: '1' }, INDEX_PATH)).toBe(true)
    expect(shouldStartWorker(join(WORKER_DIR, 'package.json'), { CRANK_FORCE_START: '1' }, INDEX_PATH)).toBe(true)
  })

  it('logs one warning without the path when the start script cannot be resolved, and starts only when forced', () => {
    let started: boolean[] = []
    const output = captureStdout(() => {
      started = [shouldStartWorker(missingScript, {}, INDEX_PATH), shouldStartWorker(missingScript, { CRANK_FORCE_START: '1' }, INDEX_PATH)]
    })
    const lines = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(started).toEqual([false, true])
    expect(lines.map((line) => [line.level, line.forced])).toEqual([['warn', false], ['warn', true]])
    expect(lines[0]?.msg).toContain('CRANK_FORCE_START=1')
    expect(output).not.toContain('no-such-dir')
    expect(output).not.toContain(WORKER_DIR)
  })
})

describe('protectRpcUrl', () => {
  const PATH_KEY = 'abcdefgh12345678'
  const QUERY_KEY = 'zzzzzzzz9999'

  it('scrubs the bare API key from the path and from the query wherever it appears in a log line', () => {
    protectRpcUrl(`https://rpc.example.com/v2/${PATH_KEY}?api-key=${QUERY_KEY}`)

    const output = captureStdout(() => {
      log.warn(`invalid api-key ${QUERY_KEY}`)
      log.error('rpc rejected the request', { error: `unknown key ${PATH_KEY}`, keys: [QUERY_KEY, PATH_KEY] })
      log.info('provider', { host: 'rpc.example.com' })
    })

    expect(output).not.toContain(QUERY_KEY)
    expect(output).not.toContain(PATH_KEY)
    expect(output).not.toContain('rpc.example.com')
    expect(output).toContain('invalid api-key [redacted]')
  })
})

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

interface OutputRecorder {
  /** The text each writer under the scrub was handed, in order: a stream write's chunk or a console line. */
  readonly chunks: string[]
  /** The arguments each process.stdout.write and process.stderr.write under the scrub was called with, in order. */
  readonly writeCalls: unknown[][]
  readonly restore: () => void
}

/**
 * Replaces process.stdout.write, process.stderr.write and console.log/info/warn/error/debug with recorders of what each
 * is handed. A recorded stream write returns `writeResult`.
 */
function recordOutput(writeResult = true): OutputRecorder {
  const chunks: string[] = []
  const writeCalls: unknown[][] = []
  const text = (chunk: string | Uint8Array): string => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  const recordWrite = (...args: [chunk: string | Uint8Array, ...rest: unknown[]]): boolean => {
    writeCalls.push(args)
    chunks.push(text(args[0]))
    return writeResult
  }
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(recordWrite),
    vi.spyOn(process.stderr, 'write').mockImplementation(recordWrite),
    ...CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation((...data: unknown[]) => {
        chunks.push(data.map(String).join(' '))
      }),
    ),
  ]
  return { chunks, writeCalls, restore: () => spies.forEach((spy) => spy.mockRestore()) }
}

describe('installOutputScrub', () => {
  const SECRET = 'plain-secret-0123456789'

  /** Undoes, in order, the scrub and then the recorders under it, so no wrapper outlives its test. */
  let undo: ReadonlyArray<() => void> = []

  /** Records every output, then installs the scrub over the recorders with RPC_URL set to SECRET_RPC_URL. */
  function scrubbedOutput(writeResult = true): OutputRecorder {
    vi.stubEnv('RPC_URL', SECRET_RPC_URL)
    const recorder = recordOutput(writeResult)
    const unscrub = installOutputScrub()
    undo = [unscrub, recorder.restore]
    return recorder
  }

  afterEach(() => {
    for (const fn of undo) fn()
    undo = []
  })

  it('after registerSecret, every console method and both streams print the secret as [redacted]', () => {
    registerSecret(SECRET)
    const { chunks } = scrubbedOutput()

    for (const method of CONSOLE_METHODS) console[method](`${method}:`, `key ${SECRET}`)
    process.stdout.write(`stdout key ${SECRET}\n`)
    process.stderr.write(Buffer.from(`stderr key ${SECRET}\n`))

    expect(chunks).toEqual([
      ...CONSOLE_METHODS.map((method) => `${method}: key [redacted]`),
      'stdout key [redacted]\n',
      'stderr key [redacted]\n',
    ])
  })

  it('scrubs a loaded crank keypair in its JSON-array and base58 forms from every output', () => {
    const keypair = Keypair.generate()
    const jsonArray = JSON.stringify(Array.from(keypair.secretKey))
    const base58 = bs58.encode(keypair.secretKey)
    loadCrankKeypair(jsonArray)
    const { chunks } = scrubbedOutput()

    console.log('key', jsonArray)
    console.info(`key ${base58}`)
    process.stdout.write(`key ${base58}\n`)
    process.stderr.write(`key ${jsonArray}\n`)

    expect(chunks).toEqual(['key [redacted]', 'key [redacted]', 'key [redacted]\n', 'key [redacted]\n'])
  })

  it('registers RPC_URL from the env at install: its host, key and bare path and query never print', () => {
    const { chunks } = scrubbedOutput()

    process.stderr.write(`request to ${SECRET_RPC_URL} failed\n`)
    process.stdout.write(`GET ${RPC_PATH_AND_QUERY}\n`)
    console.log('invalid api key', RPC_QUERY_KEY)
    console.error('ws error:', `connect ECONNREFUSED ${SECRET_RPC_URL}`)
    console.warn(new Error(`fetch failed: ${SECRET_RPC_URL}`))

    const output = chunks.join('\n')
    expect(chunks.slice(0, 4)).toEqual([
      'request to [redacted] failed\n',
      // The path and the query are registered as separate parts.
      'GET [redacted][redacted]\n',
      'invalid api key [redacted]',
      'ws error: connect ECONNREFUSED [redacted]',
    ])
    expect(output).toContain('fetch failed: [redacted]')
    expectNoRpcUrlPart(output)
  })

  it('reduces any other URL to its host, as the logger does', () => {
    const { chunks } = scrubbedOutput()

    process.stderr.write('see https://docs.example.org/errors/429?ref=abc\n', 'utf8')
    console.log('see', 'https://docs.example.org/errors/429?ref=abc')

    expect(chunks).toEqual(['see docs.example.org\n', 'see docs.example.org'])
  })

  it('a logger line passes through unchanged apart from its secrets, so it stays one JSON line', () => {
    registerSecret(SECRET)
    const { chunks } = scrubbedOutput()

    log.info('ready', { key: SECRET, cluster: 'devnet' })

    expect(chunks).toHaveLength(1)
    expect(JSON.parse(chunks[0] ?? '')).toMatchObject({ level: 'info', msg: 'ready', key: '[redacted]', cluster: 'devnet' })
  })

  it('keeps write semantics: the return value, the callback and the encoding; a chunk with nothing to scrub passes as is', () => {
    registerSecret(SECRET)
    const { writeCalls } = scrubbedOutput(false)
    const done = vi.fn()
    const clean = Buffer.from('plain line\n')
    const cleanBase64 = Buffer.from('plain bytes').toString('base64')

    const results = [
      process.stdout.write(clean, done),
      process.stdout.write('plain text\n'),
      process.stdout.write(cleanBase64, 'base64', done),
      process.stderr.write(`key ${SECRET}\n`, 'latin1', done),
      process.stderr.write(Buffer.from(`key ${SECRET}\n`), done),
      process.stderr.write(Buffer.from(`key ${SECRET}\n`).toString('base64'), 'base64'),
    ]

    expect(results).toEqual(Array(results.length).fill(false))
    expect(writeCalls).toEqual([
      [clean, done],
      ['plain text\n'],
      [cleanBase64, 'base64', done],
      ['key [redacted]\n', 'latin1', done],
      ['key [redacted]\n', 'utf8', done],
      ['key [redacted]\n', 'utf8', undefined],
    ])
    expect(writeCalls[0]?.[0]).toBe(clean)
  })

  it('restores every original writer', () => {
    const recorder = recordOutput()
    undo = [recorder.restore]
    const writers = (): unknown[] => [process.stdout.write, process.stderr.write, ...CONSOLE_METHODS.map((method) => console[method])]
    const originals = writers()

    const unscrub = installOutputScrub()
    expect(writers().every((writer, i) => writer !== originals[i])).toBe(true)
    unscrub()

    expect(writers()).toEqual(originals)
  })
})
