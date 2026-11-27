import { type AppTx, schema } from "@recpm/db";
import { USAGE_WARNING_THRESHOLDS, type UsageWarning } from "@recpm/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DomainError } from "../errors";

export type QuotaResult = {
  used: number;
  limit: number | null;
  /** Limiares cruzados AGORA (cada um é devolvido uma única vez por ciclo) — o chamador avisa os admins. */
  warnings: UsageWarning[];
};

const WARNED_COLUMN = {
  80: schema.usageCounters.warned80At,
  90: schema.usageCounters.warned90At,
  100: schema.usageCounters.warned100At,
} as const;

/**
 * Consome cota de tarefas do ciclo atual. DEVE rodar na mesma transação do INSERT da tarefa:
 * se o INSERT falhar, o consumo é desfeito junto. Toda via de criação passa por aqui
 * (UI, duplicar, recorrência, API pública, demanda do portal, importação).
 *
 * Atômico sob concorrência: um UPDATE condicional por linha do contador; nunca passa do limite.
 * Excluir/arquivar tarefa não devolve cota.
 */
export async function consumeTaskQuota(tx: AppTx, count = 1): Promise<QuotaResult> {
  if (!Number.isInteger(count) || count < 1) throw new Error("consumeTaskQuota: count inválido");

  const [row] = await tx
    .select({
      tenantId: schema.tenantSubscriptions.tenantId,
      periodStart: schema.tenantSubscriptions.currentPeriodStart,
      periodEnd: schema.tenantSubscriptions.currentPeriodEnd,
      limits: schema.plans.limits,
      tenantStatus: schema.tenants.status,
    })
    .from(schema.tenantSubscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.tenantSubscriptions.planId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantSubscriptions.tenantId));
  if (!row) throw new DomainError(409, "NO_SUBSCRIPTION", "Workspace sem assinatura.");
  if (row.tenantStatus !== "active")
    throw new DomainError(403, "TENANT_READ_ONLY", "Workspace em modo somente leitura.");

  const limit = row.limits.tasksPerCycle;

  // O contador do ciclo normalmente já existe (criado na virada do ciclo); garante por segurança.
  await tx
    .insert(schema.usageCounters)
    .values({ tenantId: row.tenantId, periodStart: row.periodStart, periodEnd: row.periodEnd })
    .onConflictDoNothing();

  const where = and(
    eq(schema.usageCounters.tenantId, row.tenantId),
    eq(schema.usageCounters.periodStart, row.periodStart),
  );
  const [updated] = await tx
    .update(schema.usageCounters)
    .set({ tasksCreated: sql`${schema.usageCounters.tasksCreated} + ${count}` })
    .where(
      limit === null ? where : and(where, sql`${schema.usageCounters.tasksCreated} + ${count} <= ${limit}`),
    )
    .returning({ used: schema.usageCounters.tasksCreated });

  if (!updated)
    throw new DomainError(
      402,
      "PLAN_TASK_LIMIT_REACHED",
      "Limite de tarefas do plano atingido neste ciclo.",
      {
        limit,
      },
    );

  const warnings: UsageWarning[] = [];
  if (limit !== null && limit > 0) {
    const pct = (updated.used * 100) / limit;
    for (const t of USAGE_WARNING_THRESHOLDS) {
      if (pct < t) continue;
      const col = WARNED_COLUMN[t];
      const [marked] = await tx
        .update(schema.usageCounters)
        .set({ [`warned${t}At`]: new Date() })
        .where(and(where, isNull(col)))
        .returning({ id: schema.usageCounters.id });
      if (marked) warnings.push(t);
    }
  }
  return { used: updated.used, limit, warnings };
}
