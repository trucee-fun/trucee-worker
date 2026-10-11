/**
 * CRK-07: the worker entrypoint registers every crank job, in tick order, with the guards of its env config; it never
 * exits as a silent no-op when started; and it scrubs every part of the RPC URL that could carry the API key.
 * CRK-13: finalize gets the env guards too, and library output on stderr is scrubbed like a log line.
 */
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair, type Connection } from '@solana/web3.js'
import { getClusterConfig } from '@trucee/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CRANK_MIN_SOL_LAMPORTS, DEFAULT_MIN_ATA_VALUE_LAMPORTS, loadConfig, type WorkerConfig } from '../src/config.js'
import type { CrankContext } from '../src/crank/index.js'
import { createAutoExitJob } from '../src/crank/jobs/auto-exit.js'
import { createClaimsJob } from '../src/crank/jobs/claims.js'
import { createFinalizeJob } from '../src/crank/jobs/finalize.js'
import { createMigrateJob } from '../src/crank/jobs/migrate.js'
import { log, type Logger } from '../src/log.js'
import { buildJobs, protectRpcUrl, scrubStderr, shouldStartWorker } from '../src/index.js'

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

/** An RPC URL whose path carries the key, as a library would quote it on a connection error. */
const STDERR_HOST = 'x.invalid'
const STDERR_SECRET = 'SECRETKEY'
const STDERR_RPC_URL = `https://${STDERR_HOST}/v2/${STDERR_SECRET}`

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

/** Imports src/index.ts from `node -e`, where process.argv[1] is undefined, as another runner would load it. */
const IMPORT_INDEX = ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/index.ts')"]

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

  it('main() scrubs stderr once the config loads: a library line quoting the RPC URL keeps neither its key nor its host', async () => {
    // A missing keypair stops main() after the scrub is installed and before anything touches the network.
    const libraryWrites = `process.stderr.write('lib error ${STDERR_RPC_URL}\\n'); console.error('ws error:', '${STDERR_RPC_URL}')`
    const script = ['--import', 'tsx', '--input-type=module', '-e', `await import('./src/index.ts'); ${libraryWrites}`]
    const env = { CLUSTER: 'devnet', RPC_URL: STDERR_RPC_URL, CRANK_KEYPAIR: './no-such-keypair.json', CRANK_FORCE_START: '1' }

    const run = await runNode(script, env)

    expect(run.code).not.toBe(0)
    expect(run.output).toContain('worker failed to start')
    expect(run.output).toContain('lib error [redacted]')
    expect(run.output).toContain('ws error: [redacted]')
    expect(run.output).not.toContain(STDERR_SECRET)
    expect(run.output).not.toContain(STDERR_HOST)
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

/** Replaces process.stderr.write, console.error and console.warn with recorders of what each is handed. */
function recordStderr(): { readonly chunks: string[]; readonly restore: () => void } {
  const chunks: string[] = []
  const text = (chunk: string | Uint8Array): string => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  const spies = [
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(text(chunk))
      return true
    }),
    vi.spyOn(console, 'error').mockImplementation((...data: unknown[]) => {
      chunks.push(data.map(String).join(' '))
    }),
    vi.spyOn(console, 'warn').mockImplementation((...data: unknown[]) => {
      chunks.push(data.map(String).join(' '))
    }),
  ]
  return { chunks, restore: () => spies.forEach((spy) => spy.mockRestore()) }
}

describe('scrubStderr', () => {
  /** Undoes, in order, the scrubber and then the recorders under it, so no wrapper outlives its test. */
  let undo: ReadonlyArray<() => void> = []

  /** Records stderr, then installs the scrubber over the recorders for STDERR_RPC_URL. */
  function scrubbedStderr(): string[] {
    const recorder = recordStderr()
    const unscrub = scrubStderr(STDERR_RPC_URL)
    undo = [unscrub, recorder.restore]
    return recorder.chunks
  }

  afterEach(() => {
    for (const fn of undo) fn()
    undo = []
  })

  it('a library writing the RPC URL to stderr: the line written contains neither the key nor the host', () => {
    const chunks = scrubbedStderr()

    process.stderr.write(`request to ${STDERR_RPC_URL} failed\n`)

    expect(chunks).toEqual(['request to [redacted] failed\n'])
  })

  it('scrubs a bare key and a Buffer chunk, and keeps the host of any other URL, as the logger does', () => {
    const chunks = scrubbedStderr()

    process.stderr.write(Buffer.from(`invalid api key ${STDERR_SECRET}\n`))
    process.stderr.write('see https://docs.example.org/errors/429?ref=abc\n', 'utf8')

    expect(chunks).toEqual(['invalid api key [redacted]\n', 'see docs.example.org\n'])
  })

  it('scrubs console.error and console.warn, which @solana/web3.js uses for connection and retry errors', () => {
    const chunks = scrubbedStderr()

    console.error('ws error:', `connect ECONNREFUSED ${STDERR_RPC_URL}`)
    console.warn(new Error(`fetch failed: ${STDERR_RPC_URL}`))

    const output = chunks.join('\n')
    expect(chunks[0]).toBe('ws error: connect ECONNREFUSED [redacted]')
    expect(output).toContain('fetch failed: [redacted]')
    expect(output).not.toContain(STDERR_SECRET)
    expect(output).not.toContain(STDERR_HOST)
  })

  it('restores the original stderr writers', () => {
    const recorder = recordStderr()
    undo = [recorder.restore]
    const originals = [process.stderr.write, console.error, console.warn]

    scrubStderr(STDERR_RPC_URL)()

    expect([process.stderr.write, console.error, console.warn]).toEqual(originals)
  })
})
