/**
 * Decide como uma troca de plano pedida pelo admin do tenant acontece. Não fala com o provedor:
 * a API usa o resultado para chamar o BillingProvider e depois grava a mudança local com
 * `recordPlanChange` (na transação do tenant).
 */
import { type AppTx, schema } from "@recpm/db";
import { eq } from "drizzle-orm";
import { DomainError } from "../errors";

type Plan = typeof schema.plans.$inferSelect;

export type PlanChange =
  /** Sem assinatura paga e plano pago → precisa de checkout no provedor. */
  | { mode: "checkout"; target: Plan }
  /** Assinatura paga: troca no provedor com cobrança proporcional; vale na hora. */
  | { mode: "upgrade"; target: Plan }
  /** Assinatura paga: o provedor cobra o plano menor a partir do próximo ciclo. */
  | { mode: "downgrade"; target: Plan }
  /** Assinatura paga → plano gratuito: cancela ao fim do ciclo. */
  | { mode: "cancel_at_period_end"; target: Plan }
  /** Sem assinatura paga → plano gratuito: agendado para a virada do ciclo. */
  | { mode: "schedule_free"; target: Plan };

export async function planChangeFor(tx: AppTx, targetSlug: string): Promise<PlanChange> {
  const [row] = await tx
    .select({ sub: schema.tenantSubscriptions, current: schema.plans })
    .from(schema.tenantSubscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.tenantSubscriptions.planId));
  if (!row) throw new DomainError(409, "NO_SUBSCRIPTION", "Workspace sem assinatura.");
  const [target] = await tx.select().from(schema.plans).where(eq(schema.plans.slug, targetSlug));
  if (!target?.active || !target.isPublic)
    throw new DomainError(404, "PLAN_NOT_FOUND", "Plano não encontrado.");
  if (target.priceIsStartingAt)
    throw new DomainError(409, "PLAN_REQUIRES_CONTACT", "Este plano é contratado com o comercial.");

  const { sub, current } = row;
  const paid = !!sub.providerSubscriptionId && (sub.provider === "stripe" || sub.provider === "asaas");
  const isFree = Number(target.priceMonthlyCents) === 0;
  const trialing = sub.status === "trialing";

  if (target.id === current.id && !trialing && !sub.pendingPlanId && !sub.cancelAtPeriodEnd)
    throw new DomainError(409, "PLAN_UNCHANGED", "Você já está neste plano.");

  if (!paid) {
    if (isFree) {
      if (trialing)
        throw new DomainError(409, "TRIAL_ENDS_ON_FREE", "Ao fim do teste o plano gratuito é aplicado.");
      return { mode: "schedule_free", target };
    }
    return { mode: "checkout", target };
  }
  if (isFree) return { mode: "cancel_at_period_end", target };
  return Number(target.priceMonthlyCents) >= Number(current.priceMonthlyCents)
    ? { mode: "upgrade", target }
    : { mode: "downgrade", target };
}

/** Grava a troca local depois que o provedor confirmou (upgrade/downgrade/cancelamento). */
export async function recordPlanChange(tx: AppTx, change: PlanChange) {
  const t = schema.tenantSubscriptions;
  const now = new Date();
  switch (change.mode) {
    case "upgrade":
      await tx
        .update(t)
        .set({ planId: change.target.id, pendingPlanId: null, cancelAtPeriodEnd: false, updatedAt: now });
      return;
    case "downgrade":
    case "schedule_free":
      await tx.update(t).set({ pendingPlanId: change.target.id, cancelAtPeriodEnd: false, updatedAt: now });
      return;
    case "cancel_at_period_end":
      await tx.update(t).set({ pendingPlanId: null, cancelAtPeriodEnd: true, updatedAt: now });
      return;
    case "checkout":
      return; // só muda quando o webhook do provedor confirmar o pagamento
  }
}

/** Desfaz downgrade/cancelamento agendado (o admin mudou de ideia). */
export async function clearScheduledChange(tx: AppTx) {
  await tx
    .update(schema.tenantSubscriptions)
    .set({ pendingPlanId: null, cancelAtPeriodEnd: false, updatedAt: new Date() });
}
