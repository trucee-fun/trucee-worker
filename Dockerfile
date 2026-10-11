# Trucee crank worker: runs the crank loop with tsx (no build step).
#
# Build from the repo root, because worker/ installs the SDK from ../sdk:
#   docker build -f worker/Dockerfile -t trucee-worker .
#
# Runtime env (set on the container, never baked into the image):
#   CLUSTER        devnet
#   RPC_URL        upstream RPC (holds a provider key: SSM only)
#   CRANK_KEYPAIR  crank signing key (SSM only): a path to a solana-keygen JSON keypair file, or the keypair
#                  itself inline as its JSON array of 64 numbers, written like [1,2,...] with all 64 (the SSM form)

# The worker runs on ECS Fargate arm64; the default keeps a build on an arm64 Mac native.
ARG PLATFORM=linux/arm64

# ---------------------------------------------------------------- builder
FROM --platform=${PLATFORM} node:20-bookworm-slim AS builder

# SDK first: worker/.npmrc sets install-links=true, so worker's npm ci packs ../sdk,
# which runs the SDK's prepare script (tsc) with sdk/node_modules.
WORKDIR /repo/sdk
COPY sdk/ ./
RUN npm ci --no-audit --no-fund

# Dev dependencies stay: `start` runs the TypeScript sources through tsx.
WORKDIR /repo/worker
COPY worker/package.json worker/package-lock.json worker/.npmrc ./
RUN npm ci --no-audit --no-fund

COPY worker/ ./

# ----------------------------------------------------------------- runner
FROM --platform=${PLATFORM} node:20-bookworm-slim AS runner
ENV NODE_ENV=production \
    CLUSTER=devnet

WORKDIR /srv/worker
COPY --from=builder /repo/worker ./

USER node
# Same as `npm start` (tsx src/index.ts), without npm in between so SIGTERM reaches node.
CMD ["node", "--import", "tsx", "src/index.ts"]
