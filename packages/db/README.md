# @recpm/db

Schema Drizzle, migrações, políticas RLS e helper de contexto de tenant do Rec PM.

| Caminho | Conteúdo |
| --- | --- |
| `src/schema/` | 73 tabelas, um arquivo por domínio (§5 da especificação) |
| `src/tenant-context.ts` | `withTenant()`: única forma de a API/worker tocar dados de tenant |
| `src/client.ts` | Três pools: `recpm_app` (RLS), `recpm_auth` (Better Auth), `recpm_platform` (super admin) |
| `migrations/0000_init.sql` | Gerada pelo drizzle-kit a partir do schema |
| `sql/rls.sql` | Funções `app.*`, políticas RLS e GRANTs (idempotente; vira a migração custom `0001_rls`) |
| `test/rls.test.ts` | Isolamento entre tenants, portal do cliente, chat, timer único e cota concorrente |
| `../../infra/postgres/init/01-roles.sql` | Papéis do Postgres (roda uma vez, como superusuário) |

## Rodar os testes de isolamento

```bash
# banco criado + 01-roles.sql aplicado como superusuário, depois como recpm_owner:
psql "$DATABASE_URL_OWNER" -f migrations/0000_init.sql   # (ou pnpm db:migrate)
psql "$DATABASE_URL_OWNER" -f sql/rls.sql
DATABASE_URL_OWNER=... DATABASE_URL_APP=... pnpm test:rls
```

Na Fase 1 isto passa a rodar com Vitest + Testcontainers no CI.
