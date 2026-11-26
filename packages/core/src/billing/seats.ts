import { type AppTx, schema } from "@recpm/db";
import { and, count, eq, gt, ne } from "drizzle-orm";
import { DomainError } from "../errors";

/**
 * Limite de usuários do plano (maxUsers para a equipe, maxClientPortalUsers para o portal).
 * `includePending`: no convite, convites pendentes também ocupam vaga; no aceite, só vínculos ativos.
 */
export async function assertSeatAvailable(tx: AppTx, role: string, opts: { includePending: boolean }) {
  const [row] = await tx
    .select({ limits: schema.plans.limits })
    .from(schema.tenantSubscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.tenantSubscriptions.planId));
  if (!row) return;
  const portal = role === "cliente";
  const limit = portal ? row.limits.maxClientPortalUsers : row.limits.maxUsers;
  if (limit === null) return;

  const roleFilter = (col: typeof schema.memberships.role | typeof schema.invitations.role) =>
    portal ? eq(col, "cliente") : ne(col, "cliente");
  const [members] = await tx
    .select({ n: count() })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.active, true), roleFilter(schema.memberships.role)));
  let used = members?.n ?? 0;
  if (opts.includePending) {
    const [pending] = await tx
      .select({ n: count() })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.status, "pending"),
          gt(schema.invitations.expiresAt, new Date()),
          roleFilter(schema.invitations.role),
        ),
      );
    used += pending?.n ?? 0;
  }
  if (used >= limit)
    throw new DomainError(402, "PLAN_USER_LIMIT_REACHED", "Limite de usuários do plano atingido.", {
      limit,
      portal,
    });
}
