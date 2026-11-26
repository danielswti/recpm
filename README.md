# Rec PM

SaaS multi-tenant de gestão de projetos, tarefas e entregas para agências criativas.

Stack: Node.js 22, pnpm + Turborepo, Hono (OpenAPI), Drizzle + PostgreSQL 17 com RLS, Better Auth, Valkey, React 19 + Vite, TanStack Router/Query, Tailwind v4.

## Estrutura

```
apps/
  api/        API Hono: /api/auth (Better Auth) e /api/v1 (rotas da aplicação, OpenAPI em /api/openapi.json)
  web/        SPA React (equipe e, na Fase 9, portal do cliente)
packages/
  db/         schema Drizzle, migrations, sql/rls.sql, withTenant(), seeds, banco de teste
  shared/     papéis, matriz de permissões (RBAC) e schemas zod usados pela API e pela web
  ui/         tema (tokens CSS, escuro por padrão, cor do tenant) e componentes base
  config/     tsconfig base
infra/        docker-compose (Postgres, Valkey, MinIO, Gotenberg, Mailpit) e init do Postgres
```

## Rodando localmente

Pré-requisitos: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env          # ajuste BETTER_AUTH_SECRET (openssl rand -base64 32)
pnpm infra:up                 # Postgres 17, Valkey, MinIO, Gotenberg, Mailpit
pnpm db:migrate               # migrations + políticas RLS + checagem de cobertura + planos
pnpm dev                      # API em :3000 e web em http://localhost:5173
```

E-mails de desenvolvimento (convite, confirmação, senha) chegam no Mailpit: http://localhost:8025.
Sem `SMTP_URL` nem `RESEND_API_KEY`, a API imprime os e-mails no console (só fora de produção).

## Testes

Os testes de banco e de API criam um banco descartável (e os papéis `recpm_*`) a partir de uma conexão de admin:

```bash
export TEST_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres
pnpm test        # isolamento RLS, permissões e fluxos da API
pnpm lint        # Biome
pnpm typecheck
```

A CI (`.github/workflows/ci.yml`) roda lint, typecheck, testes (com Postgres 17) e build em cada PR.

## Multi-tenancy em uma frase

Toda consulta de dados de tenant passa por `withTenant(db, { tenantId, userId }, tx => …)`, que define o contexto
da transação para o RLS do Postgres; sem contexto, nenhuma linha volta. A API usa quatro papéis do Postgres
(`recpm_owner`, `recpm_app`, `recpm_auth`, `recpm_platform`); detalhes em `packages/db/README.md`.
