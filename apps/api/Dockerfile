# API Modulyn. Три образа (Phase 11, E8):
#   build    — сборка (TypeScript, prisma generate);
#   migrate  — одноразовые шаги: роли БД, миграции, команды администратора платформы, служебные скрипты (Prisma CLI);
#   runtime  — работающий API: только production-зависимости и собранный код, без инструментов сборки и Prisma CLI.
# Локальный стек (docker-compose.yml) собирает migrate и runtime отсюда; сервер клиента скачивает готовые образы по версии.

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
COPY packages/i18n/package.json ./packages/i18n/
RUN --mount=type=cache,id=modulyn-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @modulyn/api... build

FROM node:26.13.0-bookworm-slim AS migrate
# schema engine (prisma migrate deploy) требует OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
USER node
CMD ["sh", "-c", "node apps/api/scripts/db-roles.mjs && cd apps/api && node node_modules/prisma/build/index.js migrate deploy"]

FROM node:26.13.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY packages/config/package.json ./packages/config/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/i18n/package.json ./packages/i18n/
# Только production-зависимости API и его пакетов рабочего пространства. В том же слое: удалить pnpm, кэши
# (скачанные движки Prisma ~380 МБ и кэш npm в /root — работающему API не нужны) и отдать файлы пользователю node.
RUN --mount=type=cache,id=modulyn-pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --filter @modulyn/api... --store-dir /pnpm/store \
  && npm uninstall --global pnpm && rm -rf /root/.cache /root/.npm /tmp/* && chown -R node:node /app
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/i18n/dist ./packages/i18n/dist
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

# Ночные копии вне сервера (Phase 11, E9): pg_dump той же версии, что сервер (18), age для шифрования, rclone для выгрузки.
FROM postgres:18-bookworm AS backup
RUN apt-get update && apt-get install -y --no-install-recommends age rclone ca-certificates libstdc++6 libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=runtime --chown=postgres:postgres /app /app
COPY --from=build --chown=postgres:postgres /app/apps/api/scripts ./apps/api/scripts
ENV NODE_ENV=production BACKUP_DIRECT=1
USER postgres
CMD ["node", "apps/api/scripts/offsite-backup.mjs", "loop"]