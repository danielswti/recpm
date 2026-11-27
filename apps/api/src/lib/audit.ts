import type { AppTx } from "@recpm/db";
import { schema } from "@recpm/db";
import type { AppEnv } from "../types";

type Ctx = { var: AppEnv["Variables"]; req: { header: (n: string) => string | undefined } };

/** Registra uma ação no log de auditoria do tenant (§6.15), na mesma transação da mudança. */
export const audit = (
  c: Ctx,
  tx: AppTx,
  entry: {
    entity: string;
    entityId?: string | null;
    entityLabel?: string | null;
    action: string;
    details?: Record<string, unknown>;
  },
) =>
  tx.insert(schema.auditLogs).values({
    tenantId: c.var.tenant.tenantId,
    actorId: c.var.tenant.userId,
    actorName: c.var.session?.user.name,
    actorRole: c.var.tenant.role,
    impersonatorId:
      (c.var.session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy ?? null,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    entityLabel: entry.entityLabel ?? null,
    action: entry.action,
    details: (entry.details ?? null) as never,
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.var.requestId,
  });

/** Mostra só os campos que mudaram: { campo: { from, to } }. */
export const diff = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    const a = before[k];
    const b = after[k];
    if (b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
};
