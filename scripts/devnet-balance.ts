/**
 * Devnet balance report: the payer plus every throwaway trader wallet listed in `*.traders.json` files.
 * Read-only (getMultipleAccounts only, 100 keys per call). Prints public keys and SOL; never secret keys
 * and never the RPC URL.
 *
 * Usage (from worker/; the URL only reaches this process, never argv or your shell):
 *   node --env-file=<main checkout>/litesvm-diff/.env --import tsx scripts/devnet-balance.ts
 *   (set -a; . <main checkout>/litesvm-diff/.env; set +a; RPC_URL="$DEVNET_RPC" npx tsx scripts/devnet-balance.ts)
 *
 * Env:
 *   RPC_URL        RPC endpoint, falls back to DEVNET_RPC (required, never printed). Must be https,
 *                  except http://localhost and http://127.0.0.1
 *   TRADERS_DIRS   comma-separated directories scanned for *.traders.json
 *                  (default: <repo>/worker/out,<repo>/litesvm-diff/out)
 *   PAYER_KEYPAIR  payer keypair file, only its public key is derived (default ~/.config/solana/id.json)
 *
 * Exit code: 0 when every balance was read, 1 on bad config, an RPC failure or an unreadable traders file.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { expandHome, loadCrankKeypair } from '../src/config.js'

const LAMPORTS_PER_SOL = 1_000_000_000n
/** getMultipleAccounts accepts at most 100 keys per call. */
const RPC_BATCH_SIZE = 100
const SECRET_KEY_BYTES = 64
const BYTE_MAX = 255
const MAX_ERROR_CHARS = 300
const MIN_SECRET_FRAGMENT = 8
/** The only hosts allowed over plain http: a local validator. */
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1'])
const TRADERS_SUFFIX = '.traders.json'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_TRADERS_DIRS = [join(REPO_ROOT, 'worker', 'out'), join(REPO_ROOT, 'litesvm-diff', 'out')]
const DEFAULT_PAYER_KEYPAIR = '~/.config/solana/id.json'
/** Devnet upgrade authority of zpvp_router and zpvp_hook. */
const UPGRADE_AUTHORITY = new PublicKey('CamCkeR9iqBij1ZyrEYj9mp6emQtpMVdWWVCUX46tFLE')
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112')

interface Wallet {
  readonly source: string
  readonly owner: PublicKey
  /** sweep_traders.ts closes this account too, so its lamports are recoverable. */
  readonly wsolAta: PublicKey
}

interface Row extends Wallet {
  readonly lamports: bigint
  readonly wsolLamports: bigint
}

interface TradersScan {
  readonly wallets: readonly Wallet[]
  readonly problems: readonly string[]
}

const HTTPS_ONLY = 'RPC_URL must be an https URL (plain http only for localhost or 127.0.0.1)'

/** RPC_URL wins; DEVNET_RPC lets `node --env-file=litesvm-diff/.env` work without exporting anything. */
function rawRpcUrl(env: NodeJS.ProcessEnv): string | undefined {
  const pick = (value: string | undefined) => (value === undefined || value.trim() === '' ? undefined : value.trim())
  return pick(env.RPC_URL) ?? pick(env.DEVNET_RPC)
}

/** Validates the RPC URL. Error messages never include the value: it embeds a provider API key. */
function parseRpcUrl(raw: string | undefined): URL {
  if (raw === undefined) {
    throw new Error('RPC_URL is required (an https URL; for devnet load DEVNET_RPC from litesvm-diff/.env)')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(HTTPS_ONLY)
  }
  const isLocalHttp = url.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !isLocalHttp) throw new Error(HTTPS_ONLY)
  return url
}

/** Keeps printable ASCII only, so a crafted file or directory name cannot inject terminal escapes. */
const printable = (text: string): string => text.replace(/[^\x20-\x7E]/g, '?')

/** Replaces every part of the RPC URL that could identify the endpoint or carry its key. */
function redact(text: string, url: URL): string {
  const fragments = [
    url.href, url.origin, url.host, url.hostname, url.pathname, url.search, url.username, url.password,
    ...url.pathname.split('/'), ...[...url.searchParams.values()],
  ].filter((part) => part.length >= MIN_SECRET_FRAGMENT)
  const longestFirst = [...new Set(fragments)].sort((a, b) => b.length - a.length)
  return longestFirst.reduce((acc, part) => acc.split(part).join('[redacted]'), text)
}

function describeError(err: unknown, url: URL): string {
  const message = err instanceof Error ? err.message : String(err)
  const cause = err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : ''
  const firstLine = `${message}${cause}`.split('\n')[0] ?? ''
  return redact(firstLine, url).slice(0, MAX_ERROR_CHARS)
}

const wsolAtaOf = (owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0]

const walletOf = (source: string, owner: PublicKey): Wallet => ({ source: printable(source), owner, wsolAta: wsolAtaOf(owner) })

function isSecretKeyList(json: unknown): json is number[][] {
  return Array.isArray(json) && json.every((entry) =>
    Array.isArray(entry) && entry.length === SECRET_KEY_BYTES &&
    entry.every((b) => Number.isInteger(b) && b >= 0 && b <= BYTE_MAX))
}

/**
 * Derives the public key, then overwrites this function's copies of the secret bytes. Best effort only:
 * the ed25519 library and the JSON text read from disk keep their own copies until garbage collection.
 */
function publicKeyOfSecret(secret: number[], file: string, index: number): PublicKey {
  const bytes = Uint8Array.from(secret)
  try {
    return Keypair.fromSecretKey(bytes).publicKey
  } catch {
    throw new Error(`${file}: entry ${index} is not a valid ed25519 secret key`)
  } finally {
    bytes.fill(0)
    secret.fill(0)
  }
}

/** Reads one traders file (a JSON array of 64-byte secret keys, as zpvp_e2e.ts writes it). */
function readTradersFile(path: string): Wallet[] {
  const file = basename(path)
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // JSON.parse errors quote the input, which is secret key material: report the file only.
    throw new Error(`${file}: unreadable or not valid JSON`)
  }
  if (!isSecretKeyList(json)) throw new Error(`${file}: expected a JSON array of ${SECRET_KEY_BYTES}-byte secret keys`)
  const label = file.slice(0, -TRADERS_SUFFIX.length)
  return json.map((secret, i) => walletOf(`${label}#${i}`, publicKeyOfSecret(secret, file, i)))
}

function listTradersFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(TRADERS_SUFFIX)).sort().map((name) => join(dir, name))
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'read error'
    console.error(`note: skipping ${printable(dir)} (${printable(code)})`)
    return []
  }
}

function scanTraders(dirs: readonly string[]): TradersScan {
  const files = dirs.flatMap(listTradersFiles)
  return files.reduce<TradersScan>((scan, path) => {
    try {
      return { ...scan, wallets: [...scan.wallets, ...readTradersFile(path)] }
    } catch (err) {
      return { ...scan, problems: [...scan.problems, err instanceof Error ? err.message : String(err)] }
    }
  }, { wallets: [], problems: [] })
}

function tradersDirs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRADERS_DIRS
  return raw.split(',').map((d) => d.trim()).filter((d) => d !== '').map((d) => resolve(expandHome(d)))
}

/** Keeps the first occurrence of each owner, so a wallet copied into two files is counted once. */
function dedupe(wallets: readonly Wallet[]): Wallet[] {
  return wallets.filter((w, i) => wallets.findIndex((x) => x.owner.equals(w.owner)) === i)
}

async function fetchLamports(connection: Connection, keys: readonly PublicKey[]): Promise<bigint[]> {
  const batches = Array.from({ length: Math.ceil(keys.length / RPC_BATCH_SIZE) }, (_, i) =>
    keys.slice(i * RPC_BATCH_SIZE, (i + 1) * RPC_BATCH_SIZE))
  const results: bigint[][] = []
  for (const batch of batches) {
    const infos = await connection.getMultipleAccountsInfo([...batch], 'confirmed')
    results.push(infos.map((info) => BigInt(info?.lamports ?? 0)))
  }
  return results.flat()
}

function formatSol(lamports: bigint): string {
  return `${lamports / LAMPORTS_PER_SOL}.${(lamports % LAMPORTS_PER_SOL).toString().padStart(9, '0')}`
}

function renderTable(rows: readonly Row[]): string {
  const traders = rows.filter((r) => r.source !== 'payer')
  const sum = (pick: (r: Row) => bigint) => traders.reduce((acc, r) => acc + pick(r), 0n)
  const body = [
    ['source', 'pubkey', 'SOL', 'wSOL ATA SOL'],
    ...rows.map((r) => [r.source, r.owner.toBase58(), formatSol(r.lamports), formatSol(r.wsolLamports)]),
    [`traders total (${traders.length})`, '', formatSol(sum((r) => r.lamports)), formatSol(sum((r) => r.wsolLamports))],
  ]
  const widths = body[0]!.map((_, col) => Math.max(...body.map((line) => line[col]!.length)))
  return body
    .map((line) => line.map((cell, col) => (col >= 2 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!))).join('  ').trimEnd())
    .join('\n')
}

async function main(): Promise<number> {
  const url = parseRpcUrl(rawRpcUrl(process.env))
  const payerPath = process.env.PAYER_KEYPAIR?.trim() || DEFAULT_PAYER_KEYPAIR
  const payer = loadCrankKeypair(payerPath).publicKey
  const scan = scanTraders(tradersDirs(process.env.TRADERS_DIRS))
  scan.problems.forEach((problem) => console.error(`error: ${printable(problem)}`))
  const wallets = dedupe([walletOf('payer', payer), ...scan.wallets])
  const connection = new Connection(url.href, 'confirmed')
  let lamports: bigint[]
  try {
    lamports = await fetchLamports(connection, wallets.flatMap((w) => [w.owner, w.wsolAta]))
  } catch (err) {
    throw new Error(`RPC request failed: ${describeError(err, url)}`)
  }
  const rows: Row[] = wallets.map((w, i) => ({ ...w, lamports: lamports[2 * i] ?? 0n, wsolLamports: lamports[2 * i + 1] ?? 0n }))
  console.log(renderTable(rows))
  if (!payer.equals(UPGRADE_AUTHORITY)) console.log(`note: payer is not the devnet upgrade authority ${UPGRADE_AUTHORITY.toBase58()}`)
  return scan.problems.length === 0 ? 0 : 1
}

main().then(
  (code) => { process.exitCode = code },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    // Last line of defence: neither RPC URL value may reach the terminal.
    const secrets = [process.env.RPC_URL, process.env.DEVNET_RPC].filter((v): v is string => (v ?? '').length >= MIN_SECRET_FRAGMENT)
    const safe = secrets.reduce((acc, secret) => acc.split(secret).join('[redacted]'), message)
    console.error(`devnet-balance: ${printable(safe)}`)
    process.exitCode = 1
  },
)
