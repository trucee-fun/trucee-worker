/**
 * One small mainnet smoke test. From worker/:
 *   npx tsx scripts/mainnet-smoke.ts           # read-only preflight
 *   npx tsx scripts/mainnet-smoke.ts --execute # launch, buy, exit before graduation, unwrap
 * RPC_URL, PAYER_KEYPAIR (file only) and APP_BASE_URL (HTTPS origin) are required.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js'
import {
  ACCOUNT_SIZE, ExtensionType,
  createCloseAccountInstruction, getAccountLen, getAssociatedTokenAddressSync, unpackAccount,
} from '@solana/spl-token'
import { createDbcProgram, deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  MARKET_ACCOUNT_SIZE, POSITION_ACCOUNT_SIZE_V2,
  buildLaunchPlan, buyInstructions, decodePosition, fetchMarket, findBufferPda, findPositionPda,
  floorValue, getClusterConfig, marketAccountsFor, quoteBuy, sellInstructions,
  type LaunchPlan, type MarketAccount, type MarketAccounts, type PositionAccount,
} from '@trucee/sdk'
import { z } from 'zod'
import { loadCrankKeypair } from '../src/config.js'
import { errorMessage, log, registerSecret, scrubSecrets } from '../src/log.js'

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const UPGRADE_AUTHORITY = 'CamCkeR9iqBij1ZyrEYj9mp6emQtpMVdWWVCUX46tFLE'
const ROUTER = 'D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb'
const HOOK = 'CUNNV1MqVB53N4jWn91uVFXm1dBSyaynR6iBCbufJWMS'
const COMMITMENT = 'confirmed'
const BUY_LAMPORTS = 10_000_000n
const BALANCE_MARGIN = 10_000_000n
const MAX_SPEND = 50_000_000n
const MIGRATION_THRESHOLD = 1_000_000_000n
const FEE_BPS = 100
const NAME = 'Trucee Smoke Test'
const SYMBOL = 'TSMOKE'
const DESCRIPTION = 'Trucee smoke test: exits before graduation. The floor until graduation is basis minus fee at cost minus a 2-lamport haircut.'
const OUTPUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../out/mainnet-smoke.json')
/** Covers Token-2022 mint extensions and inline name/symbol/URI metadata (URI <= 200 UTF-8 bytes). */
const MINT_RENT_BYTES = 1_024
/** zpvp_hook EXTRA_ACCOUNT_METAS_LEN: discriminator + length + count + one 35-byte entry. */
const HOOK_METAS_BYTES = 51
const BASE_ACCOUNT_BYTES = getAccountLen([ExtensionType.TransferHookAccount, ExtensionType.ImmutableOwner])
const bs58 = createRequire(import.meta.url)('bs58') as { readonly encode: (bytes: Uint8Array) => string }

export interface SmokeOptions {
  readonly execute: boolean
  readonly rpcUrl: URL
  readonly payerPath: string
  readonly appBaseUrl: URL
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

export function parseOptions(args: readonly string[], env: NodeJS.ProcessEnv): SmokeOptions {
  // Register before validation: neither malformed endpoints nor pasted keys can leak through errors.
  for (const raw of [env.RPC_URL, env.PAYER_KEYPAIR]) if (raw) registerSecret(raw.trim())
  if (args.length > 1 || (args.length === 1 && args[0] !== '--execute')) {
    throw new Error('arguments: only --execute is accepted; omit it for a dry run')
  }
  const rawRpc = required(env, 'RPC_URL')
  let rpcUrl: URL
  try { rpcUrl = new URL(rawRpc) } catch { throw new Error('RPC_URL must be an https URL') }
  if (rpcUrl.protocol !== 'https:') throw new Error('RPC_URL must be an https URL')
  const parts = [rpcUrl.href, rpcUrl.origin, rpcUrl.host, rpcUrl.hostname, rpcUrl.pathname, rpcUrl.search,
    rpcUrl.username, rpcUrl.password, ...rpcUrl.pathname.split('/'), ...rpcUrl.searchParams.values()]
  parts.forEach(registerSecret)
  const payerPath = required(env, 'PAYER_KEYPAIR')
  if (/^[\[{"']/.test(payerPath)) throw new Error('PAYER_KEYPAIR must be a keypair file path; inline JSON is refused')
  let appBaseUrl: URL
  const rawApp = required(env, 'APP_BASE_URL')
  try { appBaseUrl = new URL(rawApp) } catch { throw new Error('APP_BASE_URL must be an https origin') }
  if (appBaseUrl.protocol !== 'https:' || appBaseUrl.pathname !== '/' || appBaseUrl.search || appBaseUrl.hash || appBaseUrl.username || appBaseUrl.password) {
    throw new Error('APP_BASE_URL must be an https origin with no credentials, path, query or fragment')
  }
  return Object.freeze({ execute: args.length === 1, rpcUrl, payerPath, appBaseUrl })
}

export function assertPayer(payer: PublicKey): void {
  if (payer.toBase58() === UPGRADE_AUTHORITY) throw new Error('PAYER_KEYPAIR is the upgrade authority; use a separate smoke-test payer')
}

/** The only key read in the script happens after this chain check. */
export async function loadMainnetPayer(
  connection: Pick<Connection, 'getGenesisHash'>,
  path: string,
  read: (path: string) => Keypair = loadCrankKeypair,
): Promise<Keypair> {
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error('RPC_URL is not mainnet-beta; refusing to read the keypair or send')
  const payer = read(path)
  assertPayer(payer.publicKey)
  return payer
}

export function requireExecutable(label: string, address: PublicKey, info: { readonly executable: boolean } | null): void {
  if (info === null) throw new Error(`${label} ${address.toBase58()} is missing; deploy it before the smoke test`)
  if (!info.executable) throw new Error(`${label} ${address.toBase58()} is not executable`)
}

export function calculateNeed(rents: Readonly<Record<string, bigint>>, fees: bigint) {
  const amounts = [...Object.values(rents), fees]
  if (amounts.some((n) => n < 0n)) throw new Error('need amounts must be non-negative')
  const rent = Object.values(rents).reduce((sum, n) => sum + n, 0n)
  const total = rent + BUY_LAMPORTS + fees
  if (total >= MAX_SPEND) throw new Error('computed need must stay under 0.05 SOL; refusing to send')
  return Object.freeze({ rents, rent, buy: BUY_LAMPORTS, fees, total, requiredBalance: total + BALANCE_MARGIN })
}

/** Exact quote-account delta, independent of transaction fees and rent refunds. */
export function assertFloorRefund(position: PositionAccount, market: MarketAccount, received: bigint): bigint {
  if (position.tokens === 0n) throw new Error('cannot verify an empty position')
  const expected = floorValue(position, market)
  if (received !== expected) {
    throw new Error(`refund mismatch: received ${received}, expected ${expected} lamports; floor until graduation includes fee at cost and the 2-lamport haircut`)
  }
  return expected
}

interface SendDeps {
  readonly send: () => Promise<string>
  readonly confirm: (signature: string) => Promise<void>
  readonly status: (signature: string) => Promise<{ readonly err: unknown; readonly confirmationStatus?: string | null } | null>
}

/** Signed signature is known before sending. Never rebuild or retry a transaction, even when its status is absent. */
export async function sendOnce(label: string, signature: string, deps: SendDeps): Promise<string> {
  try {
    const returned = await deps.send()
    if (returned !== signature) throw new Error('RPC returned a different signature')
    await deps.confirm(signature)
    return signature
  } catch (err) {
    let status: Awaited<ReturnType<SendDeps['status']>>
    try { status = await deps.status(signature) } catch {
      throw new Error(`${label}: signature ${signature} status unavailable; not retried. ${errorMessage(err)}`)
    }
    if (status?.err === null && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature
    const outcome = status?.err ? `failed (${JSON.stringify(status.err)})` : 'not confirmed; it may still land'
    throw new Error(`${label}: signature ${signature} ${outcome}; not retried. ${errorMessage(err)}`)
  }
}

const sol = (amount: bigint): string => `${amount / 1_000_000_000n}.${(amount % 1_000_000_000n).toString().padStart(9, '0')}`
const explorer = (kind: 'address' | 'tx', value: string): string => `https://explorer.solana.com/${kind}/${value}`

function plannedAccounts(plan: LaunchPlan): MarketAccounts {
  const cluster = getClusterConfig('mainnet-beta')
  const quote = cluster.quoteMints.find((q) => q.symbol === 'SOL')!
  return {
    market: plan.market, pool: plan.pool, config: plan.config, baseMint: plan.baseMint, quoteMint: quote.mint,
    baseVault: deriveDbcTokenVaultAddress(plan.pool, plan.baseMint), quoteVault: deriveDbcTokenVaultAddress(plan.pool, quote.mint),
    bufferVault: findBufferPda(plan.market, cluster.routerProgramId), quoteTokenProgram: quote.tokenProgram,
  }
}

async function launchPlan(connection: Connection, payer: Keypair, uri: string): Promise<LaunchPlan> {
  const cluster = getClusterConfig('mainnet-beta')
  if (cluster.routerProgramId.toBase58() !== ROUTER || cluster.hookProgramId.toBase58() !== HOOK) throw new Error('SDK program IDs differ from the smoke-test deployment')
  const quote = cluster.quoteMints.find((q) => q.symbol === 'SOL')
  if (!quote) throw new Error('SDK mainnet configuration has no SOL quote')
  return buildLaunchPlan({
    connection, cluster, creator: payer.publicKey, name: NAME, symbol: SYMBOL, uri, initialBuy: 0n,
    preset: { quote, migrationQuoteThreshold: MIGRATION_THRESHOLD, feeBps: FEE_BPS, feeClaimer: payer.publicKey, leftoverReceiver: payer.publicKey },
  })
}

async function feeFor(connection: Connection, tx: Transaction): Promise<bigint> {
  const { value } = await connection.getFeeForMessage(tx.compileMessage(), COMMITMENT)
  if (value === null) throw new Error('cannot calculate transaction fees for the current blockhash')
  return BigInt(value)
}

async function preflight(connection: Connection, payer: Keypair, plan: LaunchPlan, execute: boolean) {
  const cluster = getClusterConfig('mainnet-beta')
  const accounts = plannedAccounts(plan)
  const quoteAta = getAssociatedTokenAddressSync(accounts.quoteMint, payer.publicKey, false, accounts.quoteTokenProgram)
  const [router, hook, existingQuote] = await connection.getMultipleAccountsInfo([cluster.routerProgramId, cluster.hookProgramId, quoteAta], COMMITMENT)
  const dbc = createDbcProgram(connection, COMMITMENT).program
  const sizes: Readonly<Record<string, number>> = {
    config: dbc.account.configWithTransferHook.size, pool: dbc.account.transferHookPool.size,
    mint: MINT_RENT_BYTES, baseVault: BASE_ACCOUNT_BYTES, quoteVault: ACCOUNT_SIZE,
    market: MARKET_ACCOUNT_SIZE, bufferVault: ACCOUNT_SIZE, hookMetas: HOOK_METAS_BYTES,
    position: POSITION_ACCOUNT_SIZE_V2, baseAta: BASE_ACCOUNT_BYTES,
    ...(existingQuote === null ? { quoteAta: ACCOUNT_SIZE } : {}),
  }
  const rentRows = await Promise.all(Object.entries(sizes).map(async ([label, size]) =>
    [label, BigInt(await connection.getMinimumBalanceForRentExemption(size, COMMITMENT))] as const))
  const latest = { blockhash: plan.transactions[0]!.recentBlockhash!, lastValidBlockHeight: plan.transactions[0]!.lastValidBlockHeight! }
  const tx = (ixs: readonly TransactionInstruction[]) => new Transaction({ feePayer: payer.publicKey, ...latest }).add(...ixs)
  const buy = tx(buyInstructions({ cluster, accounts, user: payer.publicKey, amountIn: BUY_LAMPORTS, minOut: 0n }))
  const exit = tx(sellInstructions({ cluster, accounts, user: payer.publicKey, tokens: 1n, unwrapSol: false }))
  const close = tx([createCloseAccountInstruction(quoteAta, payer.publicKey, payer.publicKey, [], accounts.quoteTokenProgram)])
  const fees = await Promise.all([...plan.transactions, buy, exit, close].map((t) => feeFor(connection, t)))
  const need = calculateNeed(Object.fromEntries(rentRows), fees.reduce((sum, n) => sum + n, 0n))
  const balance = BigInt(await connection.getBalance(payer.publicKey, COMMITMENT))
  log.info('mainnet smoke preflight', { mode: execute ? 'execute' : 'dry run', payer: payer.publicKey.toBase58(), balanceSol: sol(balance) })
  log.info('plan: launch SOL market, buy 0.01 SOL, exit all tokens before graduation, verify floor until graduation with a 2-lamport haircut, close wSOL ATA', {
    name: NAME, symbol: SYMBOL, feeBps: FEE_BPS, migrationQuoteThreshold: MIGRATION_THRESHOLD.toString(),
    router: ROUTER, hook: HOOK,
  })
  for (const [label, amount] of rentRows) log.info('rent need', { account: label, lamports: amount.toString(), sol: sol(amount) })
  log.info('buy and fees need', { buySol: sol(need.buy), feesSol: sol(need.fees), totalSol: sol(need.total), marginSol: sol(BALANCE_MARGIN), requiredBalanceSol: sol(need.requiredBalance), mintRentAllowanceBytes: MINT_RENT_BYTES })
  requireExecutable('router', cluster.routerProgramId, router ?? null)
  requireExecutable('hook', cluster.hookProgramId, hook ?? null)
  if (existingQuote) {
    const account = unpackAccount(quoteAta, existingQuote, accounts.quoteTokenProgram)
    if (!account.owner.equals(payer.publicKey) || !account.mint.equals(accounts.quoteMint) || !account.isNative) throw new Error('payer wSOL ATA is invalid')
  }
  if (balance < need.requiredBalance) throw new Error(`payer needs ${sol(need.requiredBalance)} SOL (computed need plus 0.01 SOL margin); has ${sol(balance)} SOL`)
  return { need, balance, fees }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

/** A small 64x64 striped PNG, following seed-devnet's upload path. */
function smokePng(): Uint8Array<ArrayBuffer> {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0)
  header.writeUInt32BE(64, 4)
  header.set([8, 2], 8)
  const rows = Array.from({ length: 64 }, (_, y) => [0, ...Array.from({ length: 64 }, (_, x) =>
    Math.floor((x + y) / 8) % 2 === 0 ? [64, 112, 244] : [16, 18, 24]).flat()]).flat()
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from(rows))), pngChunk('IEND', Buffer.alloc(0)),
  ]))
}

const metadataSchema = z.object({ uri: z.url(), image: z.url() })

async function uploadMetadata(app: URL): Promise<{ readonly uri: string; readonly image: string }> {
  const form = new FormData()
  form.set('name', NAME)
  form.set('symbol', SYMBOL)
  form.set('description', DESCRIPTION)
  form.set('image', new Blob([smokePng()], { type: 'image/png' }), 'tsmoke.png')
  const response = await fetch(new URL('/api/metadata', app), { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
  if (response.status !== 201) throw new Error(`metadata upload failed: HTTP ${response.status}`)
  const parsed = metadataSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new Error('metadata upload returned invalid URI/image')
  for (const [label, raw] of Object.entries(parsed.data)) {
    const url = new URL(raw)
    if (url.origin !== app.origin || url.username || url.password || url.search || url.hash) throw new Error(`metadata ${label} must be public at APP_BASE_URL with no credentials, query or fragment`)
    const fetched = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (fetched.status !== 200) throw new Error(`metadata ${label} returned HTTP ${fetched.status}`)
  }
  if (Buffer.byteLength(parsed.data.uri) > 200) throw new Error('metadata URI exceeds the SDK 200-byte limit')
  return parsed.data
}

function save(output: Readonly<Record<string, unknown>>): void {
  writeFileSync(OUTPUT_PATH, `${scrubSecrets(JSON.stringify(output, null, 2))}\n`)
}

async function tokenAmount(connection: Connection, ata: PublicKey): Promise<bigint> {
  return BigInt((await connection.getTokenAccountBalance(ata, COMMITMENT)).value.amount)
}

export async function runSmoke(options: SmokeOptions, connection: Connection, readPayer: (path: string) => Keypair = loadCrankKeypair): Promise<void> {
  const payer = await loadMainnetPayer(connection, options.payerPath, readPayer)
  const preview = await launchPlan(connection, payer, new URL('/api/metadata/mainnet-smoke.json', options.appBaseUrl).href)
  const budget = await preflight(connection, payer, preview, options.execute)
  if (!options.execute) { log.info('dry run complete; sends nothing (use --execute after deployment)'); return }
  if (existsSync(OUTPUT_PATH)) throw new Error('out/mainnet-smoke.json exists; inspect its signatures before intentionally starting a new smoke test')
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  const metadata = await uploadMetadata(options.appBaseUrl)
  const plan = await launchPlan(connection, payer, metadata.uri)
  const cluster = getClusterConfig('mainnet-beta')
  const accounts = plannedAccounts(plan)
  let output: Readonly<Record<string, unknown>> = {
    task: 'MN-03', cluster: 'mainnet-beta', complete: false, generatedAt: new Date().toISOString(),
    payer: payer.publicKey.toBase58(), router: ROUTER, hook: HOOK, name: NAME, symbol: SYMBOL,
    market: plan.market.toBase58(), pool: plan.pool.toBase58(), config: plan.config.toBase58(),
    baseMint: plan.baseMint.toBase58(), quoteMint: accounts.quoteMint.toBase58(), bufferVault: accounts.bufferVault.toBase58(),
    feeBps: FEE_BPS, migrationQuoteThreshold: MIGRATION_THRESHOLD.toString(), ...metadata,
    needLamports: budget.need.total.toString(), payerLamportsBefore: budget.balance.toString(),
    marketExplorer: explorer('address', plan.market.toBase58()),
  }
  const record = (fields: Readonly<Record<string, unknown>>): void => { output = { ...output, ...fields }; save(output) }
  const sends: { readonly step: string; readonly signature: string; readonly explorer: string; readonly confirmed: boolean }[] = []
  let sendIndex = 0
  save(output)
  process.stdout.write(`HIDDEN_MARKETS=${plan.market.toBase58()}\n`)

  const send = async (label: string, instructions: readonly TransactionInstruction[], extra: readonly Keypair[] = []): Promise<string> => {
    const latest = await connection.getLatestBlockhash(COMMITMENT)
    const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(...instructions)
    const fee = await feeFor(connection, tx)
    const allowance = budget.fees[sendIndex]
    if (allowance === undefined || fee > allowance) throw new Error(`${label}: fee exceeds the preflight allowance`)
    tx.sign(payer, ...extra)
    const simulated = await connection.simulateTransaction(VersionedTransaction.deserialize(tx.serialize()), {
      commitment: COMMITMENT, sigVerify: true, accounts: { encoding: 'base64', addresses: [payer.publicKey.toBase58()] },
    })
    if (simulated.value.err !== null) throw new Error(`${label}: simulation failed: ${JSON.stringify(simulated.value.err)}`)
    const after = simulated.value.accounts?.[0]
    if (!after) throw new Error(`${label}: simulation did not return payer balance`)
    // Include fee again conservatively, even on RPC implementations whose simulation already deducts it.
    if (budget.balance - BigInt(after.lamports) + fee >= MAX_SPEND || BigInt(after.lamports) - fee < BALANCE_MARGIN) {
      throw new Error(`${label}: simulated spend would exceed the 0.05 SOL limit or use the 0.01 SOL margin`)
    }
    const signature = bs58.encode(tx.signature!)
    sends.push({ step: label, signature, explorer: explorer('tx', signature), confirmed: false })
    record({ transactions: [...sends] })
    await sendOnce(label, signature, {
      send: () => connection.sendRawTransaction(tx.serialize(), { preflightCommitment: COMMITMENT, maxRetries: 0 }),
      confirm: async (sig) => {
        const { value } = await connection.confirmTransaction({ signature: sig, ...latest }, COMMITMENT)
        if (value.err !== null) throw new Error(`transaction failed: ${JSON.stringify(value.err)}`)
      },
      status: async (sig) => (await connection.getSignatureStatus(sig, { searchTransactionHistory: true })).value,
    })
    sends[sends.length - 1] = { step: label, signature, explorer: explorer('tx', signature), confirmed: true }
    sendIndex++
    record({ transactions: [...sends] })
    log.info('confirmed', { step: label, signature })
    return signature
  }

  try {
    for (const [i, tx] of plan.transactions.entries()) await send(`launch ${i + 1}`, tx.instructions, plan.signers[i] ?? [])
    const market = await fetchMarket(connection, plan.market)
    if (!market) throw new Error('router market missing after launch')
    if (market.finalized || market.feeNumerator !== 10_000_000n) throw new Error('launched market is finalized or does not have the required 1% fee')
    const liveAccounts = marketAccountsFor(market, accounts.quoteTokenProgram)
    const quoted = await quoteBuy(connection, market, BUY_LAMPORTS)
    if (quoted.tokensOut === 0n) throw new Error('0.01 SOL buy quote returned no tokens')
    await send('buy', buyInstructions({ cluster, accounts: liveAccounts, user: payer.publicKey, amountIn: BUY_LAMPORTS, minOut: quoted.tokensOut * 99n / 100n }))
    const positionAddress = findPositionPda(market.address, payer.publicKey, cluster.routerProgramId)
    const info = await connection.getAccountInfo(positionAddress, COMMITMENT)
    if (!info || !info.owner.equals(cluster.routerProgramId)) throw new Error('router position missing after buy')
    const position = decodePosition(positionAddress, info.data)
    if (!position.owner.equals(payer.publicKey) || position.tokens === 0n || position.basis === 0n) throw new Error('bought position has invalid owner, basis or tokens')
    const expected = floorValue(position, market)
    record({ position: positionAddress.toBase58(), basisLamports: position.basis.toString(), tokens: position.tokens.toString(), floorUntilGraduationLamports: expected.toString(), haircutLamports: '2' })
    log.info('position before exit before graduation', { basis: position.basis.toString(), tokens: position.tokens.toString(), floorUntilGraduation: expected.toString(), haircutLamports: '2' })
    const quoteAta = getAssociatedTokenAddressSync(accounts.quoteMint, payer.publicKey, false, accounts.quoteTokenProgram)
    const before = await tokenAmount(connection, quoteAta)
    await send('exit before graduation', sellInstructions({ cluster, accounts: liveAccounts, user: payer.publicKey, tokens: position.tokens, unwrapSol: false }))
    const received = await tokenAmount(connection, quoteAta) - before
    record({ receivedLamports: received.toString() })
    assertFloorRefund(position, market, received)
    const remaining = await connection.getAccountInfo(positionAddress, COMMITMENT)
    if (remaining && (decodePosition(positionAddress, remaining.data).tokens !== 0n || decodePosition(positionAddress, remaining.data).basis !== 0n)) throw new Error('position was not fully exited before graduation')
    await send('close wSOL ATA', [createCloseAccountInstruction(quoteAta, payer.publicKey, payer.publicKey, [], accounts.quoteTokenProgram)])
    if (await connection.getAccountInfo(quoteAta, COMMITMENT) !== null) throw new Error('payer wSOL ATA remains open')
    const after = BigInt(await connection.getBalance(payer.publicKey, COMMITMENT))
    if (budget.balance - after >= MAX_SPEND) throw new Error('observed payer spend reached the 0.05 SOL limit')
    record({ complete: true, payerLamportsAfter: after.toString(), spentLamports: (budget.balance - after).toString() })
    log.info('mainnet smoke complete: refund equals the floor until graduation with the 2-lamport haircut', { market: market.address.toBase58(), receivedLamports: received.toString(), spentLamports: (budget.balance - after).toString() })
  } catch (err) {
    // No cleanup send after a failure: an uncertain preceding transaction could still land.
    record({ stopped: true })
    throw err
  }
}

function isEntrypoint(script: string | undefined): boolean {
  if (!script) return false
  try { return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isEntrypoint(process.argv[1])) {
  void (async () => {
    const options = parseOptions(process.argv.slice(2), process.env)
    const connection = new Connection(options.rpcUrl.href, {
      commitment: COMMITMENT, disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
    })
    await runSmoke(options, connection)
  })().catch((err: unknown) => {
    log.error('STOP: mainnet smoke failed', { error: errorMessage(err) })
    process.exitCode = 1
  })
}
