/**
 * Crank job: finalizes graduated markets. The router's `finalize` is permissionless once the DBC curve is complete
 * and snapshots the buffer surplus that holders later claim, so no claim is possible until it lands.
 * A market is due while its Market account is unfinalized and its pool's migration_progress is not PreBondingCurve;
 * once finalize confirms, the market reads finalized and drops out of the plan.
 */
import {
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Keypair,
  type TransactionError,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  decodeTxError,
  fetchAllMarkets,
  finalizeInstruction,
  getClusterConfig,
  type ClusterConfig,
  type MarketAccount,
} from '@trucee/sdk'
import { errorMessage } from '../../log.js'
import type { CrankContext, CrankJob, CrankJobResult } from '../index.js'

const JOB_NAME = 'finalize'
const COMMITMENT = 'confirmed'
/** DBC VirtualPool.migration_progress (u8), as read by the router's dbc::is_curve_complete. */
const POOL_MIGRATION_PROGRESS_OFFSET = 308
const POOL_MIN_LENGTH = POOL_MIGRATION_PROGRESS_OFFSET + 1
/** MigrationProgress::PreBondingCurve; every other value means the curve is complete. */
const PRE_BONDING_CURVE = 0
/** getMultipleAccountsInfo accepts at most 100 keys per request. */
const POOL_BATCH_SIZE = 100
/** finalizeInstruction puts the market first: [market (w), pool, buffer_vault]. */
const FINALIZE_MARKET_ACCOUNT_INDEX = 0
/**
 * Used only when the caller passes no cluster. Program ids are identical on every cluster in @trucee/sdk today;
 * run() always passes ctx.cluster, so a future per-cluster router id is picked up there.
 */
const DEFAULT_CLUSTER: ClusterConfig = getClusterConfig('devnet')

type SendOutcome =
  | { readonly ok: true; readonly signature: string }
  | { readonly ok: false; readonly error: string }

/* ---------- planner ---------- */

function isDue(market: MarketAccount, poolProgress: ReadonlyMap<string, number>): boolean {
  if (market.finalized) return false
  const progress = poolProgress.get(market.pool.toBase58())
  return progress !== undefined && progress !== PRE_BONDING_CURVE
}

/**
 * One single-instruction transaction per market that is not finalized and whose pool progress (keyed by pool
 * base58) is known and not PreBondingCurve, in input order. Markets with no progress entry are left out.
 */
export function planFinalize(
  markets: readonly MarketAccount[],
  poolProgress: ReadonlyMap<string, number>,
  cluster: ClusterConfig = DEFAULT_CLUSTER,
): TransactionInstruction[][] {
  return markets
    .filter((market) => isDue(market, poolProgress))
    .map((market) => [
      finalizeInstruction({ cluster, market: market.address, pool: market.pool, bufferVault: market.bufferVault }),
    ])
}

/* ---------- pool progress ---------- */

function chunk<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
}

/** migration_progress of one pool, or null (logged) when the account is missing or too short to hold it. */
function readProgress(ctx: CrankContext, market: MarketAccount, info: AccountInfo<Buffer> | null): number | null {
  const fields = { job: JOB_NAME, market: market.address.toBase58(), pool: market.pool.toBase58() }
  if (info === null) {
    ctx.log.warn('finalize: pool account missing; market skipped', fields)
    return null
  }
  if (info.data.length < POOL_MIN_LENGTH) {
    ctx.log.warn('finalize: pool account too short; market skipped', { ...fields, bytes: info.data.length })
    return null
  }
  return info.data.readUInt8(POOL_MIGRATION_PROGRESS_OFFSET)
}

/** Pool migration_progress by pool base58 for `markets`, read in batches; unreadable pools are absent. */
async function fetchPoolProgress(ctx: CrankContext, markets: readonly MarketAccount[]): Promise<Map<string, number>> {
  let entries: ReadonlyArray<readonly [string, number]> = []
  for (const batch of chunk(markets, POOL_BATCH_SIZE)) {
    const infos = await ctx.connection.getMultipleAccountsInfo(
      batch.map((market) => market.pool),
      COMMITMENT,
    )
    const read = batch.flatMap((market, i): Array<readonly [string, number]> => {
      const progress = readProgress(ctx, market, infos[i] ?? null)
      return progress === null ? [] : [[market.pool.toBase58(), progress]]
    })
    entries = [...entries, ...read]
  }
  return new Map(entries)
}

/* ---------- sending ---------- */

function marketLabel(ixs: readonly TransactionInstruction[]): string {
  return ixs[0]?.keys[FINALIZE_MARKET_ACCOUNT_INDEX]?.pubkey.toBase58() ?? 'unknown market'
}

function describeTxError(err: TransactionError, logs: readonly string[] | null): string {
  const decoded = decodeTxError({ error: err, logs })
  return decoded === null ? JSON.stringify(err) : `${decoded.name}: ${decoded.message}`
}

function buildTransaction(payer: Keypair, ixs: readonly TransactionInstruction[], blockhash: string): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...ixs],
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([payer])
  return tx
}

function failure(ctx: CrankContext, market: string, reason: string): SendOutcome {
  ctx.log.warn('finalize: market skipped', { job: JOB_NAME, market, reason })
  return { ok: false, error: `${market}: ${reason}` }
}

/** Simulates, then sends and confirms one finalize transaction. Never throws. */
async function sendFinalize(ctx: CrankContext, ixs: readonly TransactionInstruction[]): Promise<SendOutcome> {
  const market = marketLabel(ixs)
  try {
    const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash(COMMITMENT)
    const tx = buildTransaction(ctx.payer, ixs, blockhash)
    const simulation = await ctx.connection.simulateTransaction(tx, { commitment: COMMITMENT })
    if (simulation.value.err !== null) {
      const reason = describeTxError(simulation.value.err, simulation.value.logs)
      return failure(ctx, market, `simulation failed: ${reason}`)
    }
    // Preflight would repeat the simulation that just passed.
    const signature = await ctx.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true })
    const confirmation = await ctx.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      COMMITMENT,
    )
    if (confirmation.value.err !== null) {
      return failure(ctx, market, `transaction ${signature} failed: ${describeTxError(confirmation.value.err, null)}`)
    }
    ctx.log.info('finalize: market finalized', { job: JOB_NAME, market, signature })
    return { ok: true, signature }
  } catch (err) {
    return failure(ctx, market, errorMessage(err))
  }
}

/* ---------- job ---------- */

async function runFinalize(ctx: CrankContext): Promise<CrankJobResult> {
  const cluster = ctx.cluster
  const markets = await fetchAllMarkets(ctx.connection, cluster.routerProgramId)
  const open = markets.filter((market) => !market.finalized)
  const poolProgress = await fetchPoolProgress(ctx, open)
  const unreadable = open.filter((market) => !poolProgress.has(market.pool.toBase58())).length

  const plan = planFinalize(open, poolProgress, cluster)
  const toSend = plan.slice(0, Math.max(0, ctx.maxTx))
  let outcomes: readonly SendOutcome[] = []
  for (const ixs of toSend) outcomes = [...outcomes, await sendFinalize(ctx, ixs)]

  return {
    sent: outcomes.flatMap((outcome) => (outcome.ok ? [outcome.signature] : [])),
    // Due but not attempted this tick: unreadable pool, or over the tick's transaction budget.
    skipped: unreadable + (plan.length - toSend.length),
    errors: outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error])),
  }
}

/** Sends `finalize` (simulated first) for every complete, unfinalized market, at most ctx.maxTx per tick. */
export const finalizeJob: CrankJob = Object.freeze({
  name: JOB_NAME,
  async run(ctx: CrankContext): Promise<CrankJobResult> {
    try {
      return await runFinalize(ctx)
    } catch (err) {
      const error = errorMessage(err)
      ctx.log.error('finalize job failed', { job: JOB_NAME, error })
      return { sent: [], skipped: 0, errors: [error] }
    }
  },
})
