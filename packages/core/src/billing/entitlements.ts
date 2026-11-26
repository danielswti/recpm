import { type AppTx, schema } from "@recpm/db";
import type { Entitlements, PlanFeature } from "@recpm/shared";
import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DomainError } from "../errors";

const pending = alias(schema.plans, "pending_plan");

/**
 * Entitlements do tenant do contexto (a transação já está com o RLS do tenant).
 * Fonte única para o PlanGuard da API e para o `useEntitlements()` do front.
 */
export async function loadEntitlements(tx: AppTx): Promise<Entitlements> {
  const [row] = await tx
    .select({ sub: schema.tenantSubscriptions, plan: schema.plans, pending: pending, tenant: schema.tenants })
    .from(schema.tenantSubscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.tenantSubscriptions.planId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantSubscriptions.tenantId))
    .leftJoin(pending, eq(pending.id, schema.tenantSubscriptions.pendingPlanId));
  if (!row) throw new DomainError(409, "NO_SUBSCRIPTION", "Workspace sem assinatura.");
  const { sub, plan, tenant } = row;

  const [counter] = await tx
    .select({ tasksCreated: schema.usageCounters.tasksCreated })
    .from(schema.usageCounters)
    .where(
      and(
        eq(schema.usageCounters.tenantId, sub.tenantId),
        eq(schema.usageCounters.periodStart, sub.currentPeriodStart),
      ),
    );
  const used = counter?.tasksCreated ?? 0;
  const limit = plan.limits.tasksPerCycle;

  return {
    plan: {
      id: plan.id,
      slug: plan.slug,
      name: plan.name,
      priceMonthlyCents: Number(plan.priceMonthlyCents),
      priceIsStartingAt: plan.priceIsStartingAt,
      currency: plan.currency,
    },
    pendingPlan: row.pending ? { slug: row.pending.slug, name: row.pending.name } : null,
    status: sub.status,
    provider: sub.provider,
    hasPaidSubscription:
      !!sub.providerSubscriptionId && (sub.provider === "stripe" || sub.provider === "asaas"),
    trialEndsAt: sub.status === "trialing" ? (sub.trialEndsAt?.toISOString() ?? null) : null,
    currentPeriodStart: sub.currentPeriodStart.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    graceEndsAt: sub.graceEndsAt?.toISOString() ?? null,
    readOnly: tenant.status === "read_only",
    limits: plan.limits,
    features: plan.features as Record<PlanFeature, boolean>,
    usage: {
      tasksCreated: used,
      tasksPercent:
        limit === null ? null : limit === 0 ? 100 : Math.min(100, Math.floor((used * 100) / limit)),
    },
  };
}

/** PlanGuard: lança 402 FEATURE_NOT_IN_PLAN quando o plano não inclui o recurso. */
export function assertFeature(e: Entitlements, feature: PlanFeature) {
  if (!e.features[feature])
    throw new DomainError(402, "FEATURE_NOT_IN_PLAN", "Recurso não incluído no seu plano.", { feature });
}
