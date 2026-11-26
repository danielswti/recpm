/**
 * Planos, assinatura SaaS do tenant, cupons, contador de uso (cota de tarefas) e eventos
 * de webhook de cobrança.
 *
 * `plans` e `coupons` são globais (configurados pelo super_admin, nunca hard-coded).
 * `billing_events` é global porque o webhook chega antes de sabermos o tenant.
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cents, createdAt, pk, timestamps, tstz } from "./_columns";
import { billingInterval, billingProvider, subscriptionStatus } from "./enums";
import { tenantId, tenants } from "./tenants";

export type PlanLimits = {
  /** Principal diferencial. null = ilimitado. */
  tasksPerCycle: number | null;
  maxUsers: number | null;
  maxClientPortalUsers: number | null;
  storageGb: number;
  aiMessagesPerCycle: number | null;
};
export type PlanFeatures = {
  clientPortal: boolean;
  eSignature: boolean;
  publicApi: boolean;
  aiAssistant: boolean;
  customDomain: boolean;
  advancedReports: boolean;
  outgoingWebhooks: boolean;
  sso: boolean;
};

export const plans = pgTable(
  "plans",
  {
    id: pk(),
    name: text().notNull(),
    slug: text().notNull(),
    priceMonthlyCents: cents().notNull(),
    priceYearlyCents: cents().notNull(),
    currency: text().notNull().default("BRL"),
    limits: jsonb().$type<PlanLimits>().notNull(),
    features: jsonb().$type<PlanFeatures>().notNull(),
    stripePriceIds: jsonb().$type<{ monthly?: string; yearly?: string }>().notNull().default({}),
    asaasPlanIds: jsonb().$type<{ monthly?: string; yearly?: string }>().notNull().default({}),
    trialDays: integer().notNull().default(14),
    /** Planos ocultos (ex.: contratos sob medida) não aparecem na página de preços. */
    isPublic: boolean().notNull().default(true),
    active: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("plans_slug_uq").on(t.slug)],
);

export const coupons = pgTable(
  "coupons",
  {
    id: pk(),
    code: text().notNull(),
    percentOff: integer(),
    amountOffCents: cents(),
    durationMonths: integer(),
    maxRedemptions: integer(),
    redeemedCount: integer().notNull().default(0),
    validUntil: tstz(),
    stripeCouponId: text(),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("coupons_code_uq").on(sql`upper(${t.code})`),
    check("coupons_one_discount", sql`(${t.percentOff} IS NULL) <> (${t.amountOffCents} IS NULL)`),
  ],
);

/**
 * Assinatura atual do tenant (1 linha por tenant). Histórico de mudanças vai para
 * platform_audit_logs + billing_events.
 * - Upgrade: troca `planId` na hora (proporcional no provedor).
 * - Downgrade: grava `pendingPlanId`, aplicado na virada do ciclo.
 * - Falha de pagamento: `past_due` + `graceEndsAt`; depois disso tenants.status = 'read_only'.
 */
export const tenantSubscriptions = pgTable(
  "tenant_subscriptions",
  {
    id: pk(),
    tenantId: tenantId(),
    planId: uuid()
      .notNull()
      .references(() => plans.id),
    pendingPlanId: uuid().references(() => plans.id),
    status: subscriptionStatus().notNull().default("trialing"),
    interval: billingInterval().notNull().default("monthly"),
    provider: billingProvider(),
    providerCustomerId: text(),
    providerSubscriptionId: text(),
    couponId: uuid().references(() => coupons.id),
    trialEndsAt: tstz(),
    currentPeriodStart: tstz().notNull(),
    currentPeriodEnd: tstz().notNull(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    canceledAt: tstz(),
    pastDueSince: tstz(),
    graceEndsAt: tstz(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tenant_subscriptions_tenant_uq").on(t.tenantId),
    uniqueIndex("tenant_subscriptions_provider_uq").on(t.provider, t.providerSubscriptionId),
    index("tenant_subscriptions_period_end_idx").on(t.currentPeriodEnd),
  ],
);

/**
 * Contador do ciclo de cobrança. A criação de tarefa faz, NA MESMA TRANSAÇÃO do INSERT:
 *   UPDATE usage_counters SET tasks_created = tasks_created + 1
 *    WHERE tenant_id = $1 AND period_start = $2 AND (tasks_created < $limit OR $limit IS NULL)
 *   RETURNING tasks_created;
 * 0 linhas → 402 PLAN_TASK_LIMIT_REACHED. Exclusão/arquivamento não decrementa.
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    id: pk(),
    tenantId: tenantId(),
    periodStart: tstz().notNull(),
    periodEnd: tstz().notNull(),
    tasksCreated: integer().notNull().default(0),
    aiMessages: integer().notNull().default(0),
    /** Avisos de 80/90/100% enviados uma única vez por ciclo. */
    warned80At: tstz(),
    warned90At: tstz(),
    warned100At: tstz(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("usage_counters_tenant_period_uq").on(t.tenantId, t.periodStart),
    check("usage_counters_non_negative", sql`${t.tasksCreated} >= 0 AND ${t.aiMessages} >= 0`),
  ],
);

/** Idempotência de webhooks (Stripe/Asaas): (provider, eventId) único. */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: pk(),
    provider: billingProvider().notNull(),
    eventId: text().notNull(),
    type: text().notNull(),
    tenantId: uuid().references(() => tenants.id, { onDelete: "set null" }),
    payload: jsonb().notNull(),
    receivedAt: createdAt(),
    processedAt: tstz(),
    error: text(),
  },
  (t) => [
    uniqueIndex("billing_events_provider_event_uq").on(t.provider, t.eventId),
    index("billing_events_tenant_idx").on(t.tenantId, t.receivedAt),
  ],
);
