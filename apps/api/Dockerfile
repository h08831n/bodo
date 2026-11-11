# Stage 1: Base & Dependencies
FROM node:24-bookworm-slim AS base
WORKDIR /app
# NODE_OPTIONS is strictly limited to build stages to resolve IPv4 precedence during dependency download
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

# Stage 2: Builder
FROM base AS builder
WORKDIR /app

# Copy all workspace manifests so pnpm lockfile matches 100% with --frozen-lockfile
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/utils/package.json ./packages/utils/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile

COPY packages/contracts ./packages/contracts
COPY packages/utils ./packages/utils
COPY apps/api ./apps/api

RUN pnpm --filter @bodo/contracts build
RUN pnpm --filter @bodo/utils build
RUN pnpm --filter @bodo/api build

# Stage 3: Runner (Clean runtime image, NODE_OPTIONS is NOT set here)
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install PostgreSQL 16 client for backup/restore pg_dump/pg_restore
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    lsb-release \
    ca-certificates \
    && echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg \
    && apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app ./

WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
