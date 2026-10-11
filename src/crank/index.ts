/**
 * Crank runtime: runs every registered job once per tick, in order, then waits crankIntervalMs.
 * A job that throws is logged and skipped for that tick; it never stops the loop or the jobs after it.
 */
import { Connection, type Keypair } from '@solana/web3.js'
import { getClusterConfig, type ClusterConfig } from '@trucee/sdk'
import { loadCrankKeypair, type WorkerConfig } from '../config.js'
import { errorMessage, log } from '../log.js'

export interface CrankContext {
  readonly connection: Connection
  readonly payer: Keypair
  /** Resolved lazily on first read (and cached), so a cluster config failure only fails the jobs that read it. */
  readonly cluster: ClusterConfig
  readonly log: typeof log
  /** Transactions this job may still send in the current tick (MAX_TX_PER_TICK minus what earlier jobs sent). */
  readonly maxTx: number
}

export interface CrankJobResult {
  sent: string[] /* signatures */
  skipped: number
  errors: string[]
}

export interface CrankJob {
  name: string
  run(ctx: CrankContext): Promise<CrankJobResult>
}

export interface CrankHandle {
  stop(): Promise<void>
}

const COMMITMENT = 'confirmed'

interface TickDeps {
  readonly connection: Connection
  readonly payer: Keypair
  readonly resolveCluster: () => ClusterConfig
  readonly maxTxPerTick: number
}

interface TickTotals {
  readonly sent: number
  readonly skipped: number
  readonly errors: number
}

const EMPTY_TOTALS: TickTotals = Object.freeze({ sent: 0, skipped: 0, errors: 0 })

function addTotals(a: TickTotals, b: TickTotals): TickTotals {
  return { sent: a.sent + b.sent, skipped: a.skipped + b.skipped, errors: a.errors + b.errors }
}

function memoizeClusterConfig(cluster: WorkerConfig['cluster']): () => ClusterConfig {
  let cached: ClusterConfig | undefined
  return () => {
    cached ??= getClusterConfig(cluster)
    return cached
  }
}

function createContext(deps: TickDeps, maxTx: number): CrankContext {
  return Object.freeze({
    connection: deps.connection,
    payer: deps.payer,
    log,
    maxTx,
    get cluster(): ClusterConfig {
      return deps.resolveCluster()
    },
  })
}

async function runJob(job: CrankJob, ctx: CrankContext, tick: number): Promise<TickTotals> {
  try {
    const result = await job.run(ctx)
    const fields = { job: job.name, tick, sent: result.sent, skipped: result.skipped, errors: result.errors }
    if (result.errors.length > 0) log.warn('crank job reported errors', fields)
    else log.info('crank job done', fields)
    return { sent: result.sent.length, skipped: result.skipped, errors: result.errors.length }
  } catch (err) {
    log.error('crank job failed', { job: job.name, tick, error: errorMessage(err) })
    return { sent: 0, skipped: 0, errors: 1 }
  }
}

async function runTick(jobs: readonly CrankJob[], deps: TickDeps, tick: number): Promise<void> {
  const startedAt = Date.now()
  let totals = EMPTY_TOTALS
  for (const job of jobs) {
    const maxTx = Math.max(0, deps.maxTxPerTick - totals.sent)
    totals = addTotals(totals, await runJob(job, createContext(deps, maxTx), tick))
  }
  log.info('crank tick', { tick, jobs: jobs.length, ...totals, ms: Date.now() - startedAt })
}

function warnIfClusterUnavailable(cluster: WorkerConfig['cluster'], resolveCluster: () => ClusterConfig): void {
  try {
    resolveCluster()
  } catch (err) {
    log.warn('cluster config unavailable; jobs that read ctx.cluster will fail', { cluster, error: errorMessage(err) })
  }
}

/** Starts the crank loop: the first tick runs immediately, the next one crankIntervalMs after the previous ends. */
export async function startCrank(cfg: WorkerConfig, jobs: CrankJob[]): Promise<CrankHandle> {
  const payer = loadCrankKeypair(cfg.crankKeypairPath)
  const resolveCluster = memoizeClusterConfig(cfg.cluster)
  const deps: TickDeps = Object.freeze({
    connection: new Connection(cfg.rpcUrl, COMMITMENT),
    payer,
    resolveCluster,
    maxTxPerTick: cfg.maxTxPerTick,
  })
  const jobList = Object.freeze([...jobs])

  log.info('crank started', {
    cluster: cfg.cluster,
    payer: payer.publicKey.toBase58(),
    jobs: jobList.map((job) => job.name),
    intervalMs: cfg.crankIntervalMs,
    maxTxPerTick: cfg.maxTxPerTick,
  })
  warnIfClusterUnavailable(cfg.cluster, resolveCluster)

  let stopped = false
  let tick = 0
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<void> = Promise.resolve()

  const scheduleNext = (): void => {
    if (!stopped) timer = setTimeout(runNext, cfg.crankIntervalMs)
  }
  function runNext(): void {
    tick += 1
    inFlight = runTick(jobList, deps, tick)
      .catch((err: unknown) => log.error('crank tick failed', { tick, error: errorMessage(err) }))
      .then(scheduleNext)
  }

  runNext()

  return {
    async stop(): Promise<void> {
      if (stopped) return inFlight
      stopped = true
      clearTimeout(timer)
      await inFlight
      log.info('crank stopped', { ticks: tick })
    },
  }
}
