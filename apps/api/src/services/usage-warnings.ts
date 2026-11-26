/**
 * Avisos de uso da cota (80/90/100%): e-mail para os admins do workspace. Chamado DEPOIS do commit
 * da transação que consumiu a cota (consumeTaskQuota devolve cada limiar uma única vez por ciclo).
 * O banner no app vem dos entitlements (usage.tasksPercent).
 */
import { schema, withTenant } from "@recpm/db";
import type { UsageWarning } from "@recpm/shared";
import { and, eq } from "drizzle-orm";
import { usageWarningEmail } from "../auth/emails";
import type { Deps } from "../deps";

export async function sendUsageWarnings(
  deps: Deps,
  tenantId: string,
  warnings: UsageWarning[],
  used: number,
  limit: number,
) {
  if (!warnings.length) return;
  const top = Math.max(...warnings) as UsageWarning;
  const { admins, tenant } = await withTenant(deps.dbs.appDb, { tenantId, actor: "system" }, async (tx) => ({
    admins: await tx
      .select({ email: schema.users.email, name: schema.users.name })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(and(eq(schema.memberships.role, "admin"), eq(schema.memberships.active, true))),
    tenant: (await tx.select({ name: schema.tenants.name }).from(schema.tenants))[0],
  }));
  const url = `${deps.env.WEB_URL}/assinatura`;
  await Promise.all(
    admins.map((a) =>
      deps.mailer
        .send(usageWarningEmail(a.email, a.name, tenant?.name ?? "", top, used, limit, url))
        .catch((err) => deps.logger.error({ err, tenantId }, "falha ao enviar aviso de cota")),
    ),
  );
}
