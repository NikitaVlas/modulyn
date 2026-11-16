FROM node:26.13.0-bookworm-slim AS build
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
RUN pnpm --filter @modulyn/web... build

FROM node:26.13.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0"]

