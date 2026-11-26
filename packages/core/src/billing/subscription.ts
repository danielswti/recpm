/**
 * Ciclo de vida da assinatura SaaS. Roda com o papel recpm_platform (sem RLS): webhooks de
 * cobrança chegam sem sessão, e o job de ciclo percorre todos os tenants.
 *
 * Regras (§4):
 *  - Upgrade vale na hora (o provedor cobra proporcional); downgrade só na virada do ciclo.
 *  - Falha de pagamento: past_due + carência de PAYMENT_GRACE_DAYS; depois, tenant somente leitura.
 *  - Nada é apagado automaticamente. Cancelamento devolve o tenant ao plano gratuito.
 *  - Cada ciclo novo ganha um usage_counter novo (a cota "zera").
 */
import { type AppDb, type AppTx, schema } from "@recpm/db";
import { FREE_PLAN_SLUG } from "@recpm/db/seed";
import { PAYMENT_GRACE_DAYS } from "@recpm/shared";
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { DomainError } from "../errors";
import { addDays, addMonths } from "./period";

type Provider = "stripe" | "asaas";
type Sub = typeof schema.tenantSubscriptions.$inferSelect;

/** Evento de cobrança já normalizado pelo adaptador do provedor (Stripe/Asaas). */
export type BillingEvent =
  | {
      kind: "subscription.synced";
      provider: Provider;
      eventId: string;
      tenantId: string;
      planId: string;
      interval: "monthly" | "yearly";
      providerCustomerId: string;
      providerSubscriptionId: string;
      /** O adaptador mapeia estados do provedor (ex.: incomplete/unpaid do Stripe) para past_due. */
      status: "trialing" | "active" | "past_due";
      periodStart: Date;
      periodEnd: Date;
      cancelAtPeriodEnd: boolean;
    }
  | {
      kind: "payment.succeeded";
      provider: Provider;
      eventId: string;
      providerSubscriptionId: string;
      periodStart?: Date;
      periodEnd?: Date;
    }
  | { kind: "payment.failed"; provider: Provider; eventId: string; providerSubscriptionId: string }
  | { kind: "subscription.canceled"; provider: Provider; eventId: string; providerSubscriptionId: string };

const audit = (tx: AppTx, tenantId: string, action: string, details: Record<string, unknown>) =>
  tx.insert(schema.platformAuditLogs).values({ tenantId, action, details });

async function planBySlug(tx: AppTx, slug: string) {
  const [p] = await tx.select().from(schema.plans).where(eq(schema.plans.slug, slug));
  if (!p) throw new DomainError(409, "PLAN_NOT_FOUND", `Plano ${slug} não cadastrado.`);
  return p;
}

/** Abre um ciclo novo: atualiza o período e cria o contador zerado (idempotente). */
async function openPeriod(tx: AppTx, sub: Sub, start: Date, end: Date, patch: Partial<Sub> = {}) {
  await tx
    .update(schema.tenantSubscriptions)
    .set({ ...patch, currentPeriodStart: start, currentPeriodEnd: end, updatedAt: new Date() })
    .where(eq(schema.tenantSubscriptions.id, sub.id));
  await tx
    .insert(schema.usageCounters)
    .values({ tenantId: sub.tenantId, periodStart: start, periodEnd: end })
    .onConflictDoNothing();
}

const reactivate = (tx: AppTx, tenantId: string) =>
  tx
    .update(schema.tenants)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(schema.tenants.id, tenantId), eq(schema.tenants.status, "read_only")));

async function subByProvider(tx: AppTx, provider: Provider, providerSubscriptionId: string) {
  const [s] = await tx
    .select()
    .from(schema.tenantSubscriptions)
    .where(
      and(
        eq(schema.tenantSubscriptions.provider, provider),
        eq(schema.tenantSubscriptions.providerSubscriptionId, providerSubscriptionId),
      ),
    )
    .for("update");
  return s;
}

/**
 * Aplica um evento de cobrança de forma idempotente: (provider, eventId) é registrado em
 * billing_events na mesma transação; um evento repetido não faz nada.
 * Devolve o tenant afetado (ou null se o evento não se aplica a nenhuma assinatura).
 */
export async function applyBillingEvent(
  db: AppDb,
  ev: BillingEvent,
  payload: unknown,
  now = new Date(),
): Promise<{ tenantId: string | null; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(schema.billingEvents)
      .values({ provider: ev.provider, eventId: ev.eventId, type: ev.kind, payload: payload ?? {} })
      .onConflictDoNothing()
      .returning({ id: schema.billingEvents.id });
    if (!fresh) return { tenantId: null, duplicate: true };

    const tenantId = await handle(tx, ev, now);
    await tx
      .update(schema.billingEvents)
      .set({ tenantId, processedAt: now })
      .where(eq(schema.billingEvents.id, fresh.id));
    return { tenantId, duplicate: false };
  });
}

async function handle(tx: AppTx, ev: BillingEvent, now: Date): Promise<string | null> {
  if (ev.kind === "subscription.synced") {
    const [sub] = await tx
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, ev.tenantId))
      .for("update");
    if (!sub) return null;

    const newCycle = sub.currentPeriodStart.getTime() !== ev.periodStart.getTime();
    // Downgrade agendado: o provedor já cobra o plano menor no próximo ciclo, mas aqui o plano
    // atual vale até a virada.
    let planId = ev.planId;
    let pendingPlanId = sub.pendingPlanId;
    if (sub.pendingPlanId && ev.planId === sub.pendingPlanId && !newCycle) planId = sub.planId;
    if (newCycle && sub.pendingPlanId) {
      planId = sub.pendingPlanId;
      pendingPlanId = null;
    }
    if (ev.planId !== sub.pendingPlanId && ev.planId !== sub.planId) pendingPlanId = null; // upgrade/troca

    const patch: Partial<Sub> = {
      planId,
      pendingPlanId,
      status: ev.status,
      interval: ev.interval,
      provider: ev.provider,
      providerCustomerId: ev.providerCustomerId,
      providerSubscriptionId: ev.providerSubscriptionId,
      cancelAtPeriodEnd: ev.cancelAtPeriodEnd,
      trialEndsAt: ev.status === "trialing" ? sub.trialEndsAt : null,
      ...(ev.status === "active" ? { pastDueSince: null, graceEndsAt: null } : {}),
    };
    await openPeriod(tx, sub, ev.periodStart, ev.periodEnd, patch);
    if (ev.status === "active") await reactivate(tx, sub.tenantId);
    if (ev.status === "past_due") await markPastDue(tx, { ...sub, ...patch }, now);
    if (planId !== sub.planId || newCycle)
      await audit(tx, sub.tenantId, "billing.subscription_synced", { planId, newCycle, status: ev.status });
    return sub.tenantId;
  }

  const sub = await subByProvider(tx, ev.provider, ev.providerSubscriptionId);
  if (!sub) return null;

  if (ev.kind === "payment.succeeded") {
    const patch: Partial<Sub> = {
      status: "active",
      pastDueSince: null,
      graceEndsAt: null,
      trialEndsAt: null,
    };
    if (ev.periodStart && ev.periodEnd && ev.periodStart.getTime() !== sub.currentPeriodStart.getTime()) {
      if (sub.pendingPlanId) Object.assign(patch, { planId: sub.pendingPlanId, pendingPlanId: null });
      await openPeriod(tx, sub, ev.periodStart, ev.periodEnd, patch);
    } else {
      await tx
        .update(schema.tenantSubscriptions)
        .set({ ...patch, updatedAt: now })
        .where(eq(schema.tenantSubscriptions.id, sub.id));
    }
    await reactivate(tx, sub.tenantId);
    return sub.tenantId;
  }

  if (ev.kind === "payment.failed") {
    await markPastDue(tx, sub, now);
    await audit(tx, sub.tenantId, "billing.payment_failed", { provider: ev.provider });
    return sub.tenantId;
  }

  // subscription.canceled → volta ao plano gratuito, ciclo novo, dados intactos.
  const free = await planBySlug(tx, FREE_PLAN_SLUG);
  await openPeriod(tx, sub, now, addMonths(now, 1), {
    planId: free.id,
    pendingPlanId: null,
    status: "active",
    provider: null,
    providerSubscriptionId: null,
    cancelAtPeriodEnd: false,
    canceledAt: now,
    pastDueSince: null,
    graceEndsAt: null,
    trialEndsAt: null,
  });
  await reactivate(tx, sub.tenantId);
  await audit(tx, sub.tenantId, "billing.subscription_canceled", { provider: ev.provider });
  return sub.tenantId;
}

async function markPastDue(tx: AppTx, sub: Sub, now: Date) {
  await tx
    .update(schema.tenantSubscriptions)
    .set({
      status: "past_due",
      pastDueSince: sub.pastDueSince ?? now,
      graceEndsAt: sub.graceEndsAt ?? addDays(now, PAYMENT_GRACE_DAYS),
      updatedAt: now,
    })
    .where(eq(schema.tenantSubscriptions.id, sub.id));
}

export type CycleReport = { trialsEnded: number; periodsRolled: number; readOnly: number };

/**
 * Job periódico (worker, a cada 15 min). Cuida do que não tem webhook:
 *  1. trial vencido sem assinatura paga → plano gratuito;
 *  2. assinaturas sem provedor (gratuita/manual) com ciclo vencido → ciclo novo (aplica downgrade agendado
 *     e cancelamento ao fim do ciclo);
 *  3. carência de pagamento vencida → tenant somente leitura.
 * Cada tenant é processado na sua própria transação; o job é seguro para rodar em paralelo (FOR UPDATE SKIP LOCKED).
 */
export async function runBillingCycle(db: AppDb, now = new Date()): Promise<CycleReport> {
  const report: CycleReport = { trialsEnded: 0, periodsRolled: 0, readOnly: 0 };
  const ts = schema.tenantSubscriptions;
  const unpaid = or(isNull(ts.providerSubscriptionId), eq(ts.provider, "manual"));

  const due = await db
    .select({ id: ts.id })
    .from(ts)
    .where(
      or(
        and(eq(ts.status, "trialing"), lte(ts.trialEndsAt, now), unpaid),
        and(inArray(ts.status, ["active", "canceled"]), lte(ts.currentPeriodEnd, now), unpaid),
        and(eq(ts.status, "past_due"), isNotNull(ts.graceEndsAt), lte(ts.graceEndsAt, now)),
      ),
    );

  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [sub] = await tx.select().from(ts).where(eq(ts.id, id)).for("update", { skipLocked: true });
      if (!sub) return;
      const isUnpaid = !sub.providerSubscriptionId || sub.provider === "manual";

      if (sub.status === "trialing" && sub.trialEndsAt && sub.trialEndsAt <= now && isUnpaid) {
        const free = await planBySlug(tx, FREE_PLAN_SLUG);
        await openPeriod(tx, sub, now, addMonths(now, 1), {
          planId: free.id,
          pendingPlanId: null,
          status: "active",
          trialEndsAt: null,
        });
        await audit(tx, sub.tenantId, "billing.trial_ended", { plan: FREE_PLAN_SLUG });
        report.trialsEnded++;
        return;
      }

      if (sub.status === "past_due" && sub.graceEndsAt && sub.graceEndsAt <= now) {
        const changed = await tx
          .update(schema.tenants)
          .set({ status: "read_only", updatedAt: now })
          .where(and(eq(schema.tenants.id, sub.tenantId), eq(schema.tenants.status, "active")))
          .returning({ id: schema.tenants.id });
        if (changed.length) {
          await audit(tx, sub.tenantId, "billing.read_only", { graceEndsAt: sub.graceEndsAt });
          report.readOnly++;
        }
        return;
      }

      if ((sub.status === "active" || sub.status === "canceled") && sub.currentPeriodEnd <= now && isUnpaid) {
        let start = sub.currentPeriodEnd;
        let end = addMonths(start, 1);
        while (end <= now) {
          start = end;
          end = addMonths(start, 1);
        }
        const patch: Partial<Sub> = {};
        if (sub.cancelAtPeriodEnd) {
          const free = await planBySlug(tx, FREE_PLAN_SLUG);
          Object.assign(patch, {
            planId: free.id,
            pendingPlanId: null,
            cancelAtPeriodEnd: false,
            canceledAt: now,
          });
        } else if (sub.pendingPlanId) {
          Object.assign(patch, { planId: sub.pendingPlanId, pendingPlanId: null });
        }
        if (sub.status === "canceled") patch.status = "active";
        await openPeriod(tx, sub, start, end, patch);
        report.periodsRolled++;
      }
    });
  }
  return report;
}
