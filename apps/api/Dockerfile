# Stage 1: Base & Dependencies
FROM node:24-bookworm-slim AS base
WORKDIR /app

# Install pnpm and essentials
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

# Stage 2: Builder
FROM base AS builder
WORKDIR /app

# Copy repo configuration and manifests
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/utils/package.json ./packages/utils/
COPY packages/ui/package.json ./packages/ui/
COPY apps/api/package.json ./apps/api/

# Install all dependencies
RUN pnpm install --frozen-lockfile=false

# Copy source files
COPY packages/contracts ./packages/contracts
COPY packages/utils ./packages/utils
COPY apps/api ./apps/api

# Build shared packages and api
RUN pnpm --filter @bodo/contracts build
RUN pnpm --filter @bodo/utils build
RUN pnpm --filter @bodo/api build

# Stage 3: Runner
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install postgresql-client-16 and curl for healthcheck
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

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

# Copy production artifacts
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY packages/utils ./packages/utils
COPY apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile=false

WORKDIR /app/apps/api
EXPOSE 3000

CMD ["node", "dist/main.js"]
