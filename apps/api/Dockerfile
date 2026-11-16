FROM node:26.13.0-bookworm-slim AS build
# Prisma определяет версию OpenSSL для загрузки schema engine; в slim-образе её нет.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
COPY packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,id=modulyn-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @modulyn/api... build

FROM node:26.13.0-bookworm-slim AS runtime
# schema engine (prisma migrate deploy в сервисе migrate) требует OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

