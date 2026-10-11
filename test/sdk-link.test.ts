/**
 * The worker passes its own @solana/web3.js and bn.js objects into @trucee/sdk, so both must share one copy of
 * every SDK peer: the worker's. A symlinked SDK resolves its imports from ../sdk/node_modules (its dev install)
 * instead, which splits the classes: TypeScript rejects them once versions drift and `instanceof` fails at runtime.
 *
 * worker/.npmrc sets install-links=true, so npm installs `file:../sdk` as a packed copy (built by the SDK's
 * `prepare` script while packing) with no node_modules of its own; its peers resolve from worker/node_modules.
 * The copy is a snapshot: after changing sdk/, run `npm run sdk:refresh` (npm ci) here to re-pack it.
 * A plain `npm install` keeps the old copy because the version and lockfile entry are unchanged.
 */
import { existsSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import {
  ROUTER_PROGRAM_ID,
  buildZeroPvpConfigParameters,
  fetchMarket,
  findMarketPda,
  getClusterConfig,
  initMarketInstruction,
  type ClusterConfig,
  type LaunchParams,
  type PresetOptions,
} from '@trucee/sdk'
import BN from 'bn.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

const LOCAL_RPC_URL = 'http://127.0.0.1:8899'
const WEB3 = '@solana/web3.js'
const FEE_BPS = 100
const SDK_INSTALL_DIR = fileURLToPath(new URL('../node_modules/@trucee/sdk', import.meta.url))

const workerRequire = createRequire(import.meta.url)

/** The directory of the @trucee/sdk entry as the worker's runtime resolves it. */
function sdkEntryDir(): string {
  return dirname(fileURLToPath(import.meta.resolve('@trucee/sdk')))
}

function presetFor(cluster: ClusterConfig, owner: PublicKey): PresetOptions {
  const quote = cluster.quoteMints[0]
  if (quote === undefined) throw new Error(`cluster ${cluster.cluster} has no quote mint`)
  return {
    quote,
    migrationQuoteThreshold: quote.maxMigrationQuoteThreshold,
    feeBps: FEE_BPS,
    feeClaimer: owner,
    leftoverReceiver: owner,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('@trucee/sdk install', () => {
  it('is a packed copy, not a symlink, with no nested @solana/web3.js', () => {
    expect(lstatSync(SDK_INSTALL_DIR).isSymbolicLink()).toBe(false)
    expect(existsSync(`${SDK_INSTALL_DIR}/node_modules/${WEB3}`)).toBe(false)
  })

  it('resolves @solana/web3.js from the SDK entry to the worker copy', () => {
    const fromSdk = workerRequire.resolve(WEB3, { paths: [sdkEntryDir()] })

    expect(sdkEntryDir().startsWith(SDK_INSTALL_DIR)).toBe(true)
    expect(fromSdk).toBe(workerRequire.resolve(WEB3))
  })
})

describe('@trucee/sdk class identity', () => {
  it('uses the worker PublicKey class', () => {
    const sdkPublicKey: unknown = Object.getPrototypeOf(ROUTER_PROGRAM_ID).constructor

    expect(sdkPublicKey).toBe(PublicKey)
  })

  it('accepts a worker PublicKey and returns a worker PublicKey', () => {
    const pool = Keypair.generate().publicKey

    const market: PublicKey = findMarketPda(pool)

    expect(market).toBeInstanceOf(PublicKey)
    expect(market.equals(findMarketPda(pool))).toBe(true)
  })

  it('builds an instruction from worker keys as a worker TransactionInstruction', () => {
    const cluster = getClusterConfig('localnet')
    const quote = presetFor(cluster, Keypair.generate().publicKey).quote
    const payer = Keypair.generate().publicKey

    const ix: TransactionInstruction = initMarketInstruction({
      cluster,
      payer,
      pool: Keypair.generate().publicKey,
      config: Keypair.generate().publicKey,
      quoteMint: quote.mint,
      quoteTokenProgram: quote.tokenProgram,
    })

    expect(ix).toBeInstanceOf(TransactionInstruction)
    expect(ix.programId).toBeInstanceOf(PublicKey)
    expect(ix.keys[0]?.pubkey.equals(payer)).toBe(true)
  })

  it('returns worker BN values from the DBC preset', () => {
    const preset = presetFor(getClusterConfig('devnet'), Keypair.generate().publicKey)

    const params = buildZeroPvpConfigParameters(preset)

    expect(params.migrationQuoteThreshold).toBeInstanceOf(BN)
    expect(Object.getPrototypeOf(params.migrationQuoteThreshold).constructor).toBe(BN)
  })
})

describe('@trucee/sdk with a worker Connection', () => {
  it('reads through a worker Connection', async () => {
    const connection = new Connection(LOCAL_RPC_URL)
    const getAccountInfo = vi.spyOn(connection, 'getAccountInfo').mockResolvedValue(null)
    const market = findMarketPda(Keypair.generate().publicKey)

    await expect(fetchMarket(connection, market)).resolves.toBeNull()
    expect(getAccountInfo).toHaveBeenCalledWith(market)
  })

  it('types a worker Connection and PublicKey as SDK launch params', () => {
    const creator = Keypair.generate().publicKey
    const cluster = getClusterConfig('devnet')

    const params: LaunchParams = {
      connection: new Connection(LOCAL_RPC_URL),
      cluster,
      creator,
      name: 'Link',
      symbol: 'LNK',
      uri: 'https://example.invalid/lnk.json',
      preset: presetFor(cluster, creator),
    }

    expect(params.connection).toBeInstanceOf(Connection)
  })
})
