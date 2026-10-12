# Trucee worker

The permissionless crank for Trucee's Zero-PvP curve. Each tick runs `finalize`, `migrate`, `claims`, then `auto-exit`, sharing a transaction budget. The payer funds transaction fees, migration costs and any associated token accounts the jobs create.

The router's floor holds until graduation: recorded basis minus the fee at cost (at most 1%) minus a 2-lamport haircut. Owner exits and due Auto-Exits happen before graduation. After graduation, finalization snapshots the buffer surplus, migration opens DAMM v2 trading, and claims pay remaining holders in proportion to their recorded basis.

## Workspace and setup

Use Node.js 24 and npm. Clone the repositories side by side with these folder names so the `file:../sdk` dependency and companion-script paths resolve:

```sh
mkdir trucee && cd trucee
git clone https://github.com/trucee-fun/trucee-programs zpvp
git clone https://github.com/trucee-fun/trucee-sdk sdk
git clone https://github.com/trucee-fun/trucee-app app
git clone https://github.com/trucee-fun/trucee-sim sim
git clone https://github.com/trucee-fun/trucee-worker worker
git clone https://github.com/trucee-fun/trucee-litesvm-diff litesvm-diff
git clone https://github.com/trucee-fun/trucee-docs gitbook
cd sdk
npm ci
npm run build
cd ../worker
npm ci
npm run typecheck
npm test
```

The worker installs a local copy of the SDK. After changing and rebuilding `sdk/`, run `npm run sdk:refresh` here to refresh that copy. Unit tests use synthetic accounts and mocked RPC responses; they send no transactions.

## Run the crank

Set `CLUSTER=devnet` and `RPC_URL` in your environment or a local, gitignored `worker/.env`. Put a funded devnet keypair at `~/.config/solana/id.json`, or set `CRANK_KEYPAIR` to its path. Then run:

```sh
npm start
```

The process logs JSON lines, redacts the RPC URL and signing secrets, and stops on SIGINT or SIGTERM. It simulates transactions before sending. A configured cluster selects SDK program IDs and quote mints; the crank itself does not verify the RPC genesis hash.

| Variable | Meaning and default |
| --- | --- |
| `CLUSTER` | Required: `devnet`, `localnet` or `mainnet-beta`; selects SDK cluster configuration. |
| `RPC_URL` | Required HTTP(S) endpoint; never printed. |
| `CRANK_KEYPAIR` | Keypair file path, or a 64-byte JSON array; defaults to `~/.config/solana/id.json`. |
| `CRANK_INTERVAL_MS` | Tick interval, default `15000`, minimum `100`. |
| `MAX_TX_PER_TICK` | Shared transaction budget, default `10`. |
| `CRANK_MIN_SOL_LAMPORTS` | Jobs stop planning below this payer balance, default `50000000`. |
| `MIN_ATA_VALUE_LAMPORTS` | Minimum wSOL payout for creating a missing owner quote ATA, default `250000000`. |
| `MAX_ATA_CREATES_PER_TICK` | Maximum owner quote ATAs each claims/Auto-Exit job creates per tick, default `2`. |
| `MIN_MIGRATE_THRESHOLD_SOL_LAMPORTS` | Minimum wSOL migration threshold: default `0` on devnet/localnet, `1000000000` on mainnet-beta. |

For xStock quotes, missing-ATA creation requires a payout of at least `10000000` raw units (0.1 share), and migration requires a threshold of at least `100000000` raw units (1 share). Small payouts with missing ATAs remain available for owners to handle themselves. The crank skips quote mints without configured minimums. Legacy router accounts are filtered by their current layout size before decoding.

| Job | What it does |
| --- | --- |
| `finalize` | Snapshots surplus in completed, unfinalized markets. |
| `migrate` | Calls DBC's permissionless DAMM v2 migration and recognizes migrations completed by another keeper. |
| `claims` | Pays each remaining holder's surplus share to their canonical quote ATA. |
| `auto-exit` | Executes due, delegated positions before graduation, using the chain clock. |

Mainnet smoke: `RPC_URL=… PAYER_KEYPAIR=/path/to/payer.json APP_BASE_URL=https://trucee.fun npx tsx scripts/mainnet-smoke.ts` runs a read-only preflight; add `--execute` to launch, buy 0.01 SOL and exit before graduation, check the floor until graduation with its 2-lamport haircut, then close wSOL; spend stays under 0.05 SOL, output is `out/mainnet-smoke.json` plus `HIDDEN_MARKETS=<market>`.

## Devnet scripts

These commands run from `worker/`. Supply `RPC_URL` or `DEVNET_RPC` through the environment; `node --env-file=../litesvm-diff/.env --import tsx scripts/NAME.ts` can load a companion env file. The scripts do not load `worker/.env` themselves. `PAYER_KEYPAIR` defaults to `~/.config/solana/id.json`.

The three scripts that send transactions (`seed-devnet.ts`, `e2e-devnet.ts`, `graduate-devnet.ts`) require the RPC genesis hash to equal devnet's `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` before loading signing keys. They preserve a 5 SOL payer balance, save their generated trader keys to gitignored `out/*.traders.json` with mode `0600` before funding, and reuse existing trader files. RPC URLs and private keys are redacted from output. The balance script is read-only and does not perform that genesis check.

| Script / mode | What it does |
| --- | --- |
| `seed-devnet.ts` | Creates two live demo markets and one graduated, claimed, migrated market; writes `out/seed-devnet.json` and returns generated traders' SOL to the payer. |
| `e2e-devnet.ts` | Tests 13 steps from launch through before-graduation exits, hook/cap rejections, graduation, migration and claims; writes `out/e2e-devnet.json`. |
| `graduate-devnet.ts` | Graduates a fresh market and leaves finalization, migration and claims for the unattended crank. |
| `graduate-devnet.ts --record` | Reads `out/crank-run.log` (or `CRANK_LOG`) and records the crank's transaction outcomes in `out/crank-run-devnet.json`. |
| `graduate-devnet.ts --sweep` | Counts remaining positions and returns the generated traders' wallet and wSOL-account SOL to the payer. |
| `devnet-balance.ts` | Prints payer and generated trader balances without sending; `TRADERS_DIRS` overrides the default `worker/out` and sibling `litesvm-diff/out` scan directories. |

For seeding, run the companion app with its metadata endpoint available and point `METADATA_BASE_URL` at it:

```sh
METADATA_BASE_URL=http://localhost:3124 npx tsx scripts/seed-devnet.ts
npx tsx scripts/e2e-devnet.ts
CLUSTER=devnet npx tsx scripts/graduate-devnet.ts
```

After graduation preparation, run the crank with devnet configuration and capture its log; stop it after the jobs complete, then record and reclaim:

```sh
npm start > out/crank-run.log 2>&1
CLUSTER=devnet npx tsx scripts/graduate-devnet.ts --record
CLUSTER=devnet npx tsx scripts/graduate-devnet.ts --sweep
npx tsx scripts/devnet-balance.ts
```

Seeding refuses a completed `out/seed-devnet.json`; remove that public result file only when intentionally creating a new demo seed. The E2E and seed scripts return generated traders' SOL on failure; live demo positions and their base-token accounts remain as demo data. A successful graduation-preparation run keeps trader funds available for the crank until `--sweep`.

The recorded [final devnet E2E result](https://github.com/trucee-fun/trucee-worker/blob/main/out/e2e-devnet-final.json) contains accounts, step outcomes and signatures. It describes that recorded run. The [router v5 security review](https://github.com/trucee-fun/trucee-docs/blob/main/security/router-v5-review.md) documents findings and remaining limitations.

## License

MIT; see [LICENSE](https://github.com/trucee-fun/trucee-worker/blob/main/LICENSE).
