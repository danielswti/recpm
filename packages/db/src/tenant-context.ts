/**
 * Contexto de tenant por transação — a única forma de a API/worker tocar dados de tenant.
 *
 *   await withTenant(db, { tenantId, userId }, (tx) => tx.select().from(tasks));
 *
 * `set_config(..., true)` = SET LOCAL: vale só até o fim da transação, então é seguro com
 * pool de conexões e com PgBouncer em transaction pooling. Sem contexto, o RLS não devolve
 * nenhuma linha (falha fechada).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

export type AppDb = NodePgDatabase<typeof schema>;
export type AppTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

export type TenantContext = {
  tenantId: string;
  /** Usuário autenticado (ou dono da chave de API). */
  userId?: string;
  /** Preenchido SOMENTE quando a sessão é de um usuário do portal (role = 'cliente'). */
  clientId?: string;
  /** 'system' = jobs do worker (ignora as restrições de dono/participante, nunca a de tenant). */
  actor?: "user" | "system";
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(
  db: AppDb,
  ctx: TenantContext,
  fn: (tx: AppTx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(ctx.tenantId)) throw new Error("withTenant: tenantId inválido");
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT set_config('app.tenant_id', ${ctx.tenantId}, true),
             set_config('app.user_id',   ${ctx.userId ?? ""}, true),
             set_config('app.client_id', ${ctx.clientId ?? ""}, true),
             set_config('app.actor',     ${ctx.actor ?? "user"}, true)
    `);
    return fn(tx);
  });
}
