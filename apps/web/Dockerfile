# Stage 1: Base & Dependencies
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

# Stage 2: Builder
FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/utils/package.json ./packages/utils/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile=false

COPY packages/contracts ./packages/contracts
COPY packages/utils ./packages/utils
COPY packages/ui ./packages/ui
COPY apps/web ./apps/web

RUN pnpm --filter @bodo/contracts build
RUN pnpm --filter @bodo/utils build
RUN pnpm --filter @bodo/ui build
RUN pnpm --filter @bodo/web build

# Stage 3: Runner (Nginx)
FROM nginx:alpine AS runner
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
