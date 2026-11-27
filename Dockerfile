# syntax=docker/dockerfile:1.7
# Imagens de produção do Rec PM (uma por alvo): api, worker e web (Caddy com o app e o site).
# Imagens base fixadas por digest (builds reproduzíveis); atualize o digest para pegar correções.
#   docker build --target api -t recpm-api .
#   docker build --target worker -t recpm-worker .
#   docker build --target web -t recpm-web .

FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /repo

# ── dependências (cache por lockfile) ──
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/site/package.json apps/site/
COPY apps/e2e/package.json apps/e2e/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
# CA extra opcional (só para builds atrás de proxy corporativo): --secret id=ca,src=ca.crt
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=ca,required=false \
    { [ -f /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca; true; } \
 && pnpm install --frozen-lockfile

# ── build ──
FROM deps AS build
COPY . .
ARG VITE_SENTRY_DSN=""
ARG VITE_RELEASE=""
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN VITE_RELEASE=$VITE_RELEASE
RUN pnpm --filter @recpm/api --filter @recpm/worker --filter @recpm/web --filter @recpm/site build
RUN node scripts/precompress.mjs apps/web/dist apps/site/dist
# pastas de produção autocontidas (node_modules achatado, só dependências de runtime)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=ca,required=false \
    { [ -f /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca; true; } \
 && pnpm --filter @recpm/api deploy --prod --legacy --config.node-linker=hoisted /out/api \
 && pnpm --filter @recpm/worker deploy --prod --legacy --config.node-linker=hoisted /out/worker \
 && cp -r packages/db/migrations packages/db/sql /out/api/
RUN cp -r apps/api/dist /out/api/ && cp -r apps/worker/dist /out/worker/ \
 && node scripts/check-externals.mjs /out/api && node scripts/check-externals.mjs /out/worker

# ── API (também roda as migrações: node dist/migrate.js) ──
FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api/node_modules ./node_modules
COPY --from=build /out/api/migrations ./migrations
COPY --from=build /out/api/sql ./sql
COPY --from=build /out/api/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ── worker ──
FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/worker/node_modules ./node_modules
COPY --from=build /out/worker/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ── web: Caddy servindo o app (SPA), o site e o proxy para a API ──
FROM caddy:2-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 AS web
COPY infra/prod/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv/app
COPY --from=build /repo/apps/site/dist /srv/site
