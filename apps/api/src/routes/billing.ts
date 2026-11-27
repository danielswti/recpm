/**
 * Plano e cobrança do workspace.
 *   GET  /entitlements            qualquer membro: o que o plano libera + uso (useEntitlements no front)
 *   GET  /billing                 admin: assinatura, planos públicos, se a cobrança está configurada
 *   POST /billing/change-plan     admin: checkout, upgrade (na hora), downgrade/cancelamento (no fim do ciclo)
 *   POST /billing/undo-scheduled  admin: desfaz downgrade/cancelamento agendado
 *   POST /billing/portal          admin: portal de pagamento do provedor
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  clearScheduledChange,
  DomainError,
  loadEntitlements,
  planChangeFor,
  recordPlanChange,
} from "@recpm/core";
import { schema } from "@recpm/db";
import { PLAN_FEATURES, SUBSCRIPTION_STATUSES } from "@recpm/shared";
import { and, asc, eq } from "drizzle-orm";
import type { BillingProviders } from "../billing";
import type { Deps } from "../deps";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";
import type { AppEnv } from "../types";

const Limits = z.object({
  tasksPerCycle: z.number().nullable(),
  maxUsers: z.number().nullable(),
  maxClientPortalUsers: z.number().nullable(),
  storageGb: z.number(),
  aiMessagesPerCycle: z.number().nullable(),
});
const Features = z.object(
  Object.fromEntries(PLAN_FEATURES.map((f) => [f, z.boolean()])) as Record<
    (typeof PLAN_FEATURES)[number],
    z.ZodBoolean
  >,
);

const Entitlements = z
  .object({
    plan: z.object({
      id: z.uuid(),
      slug: z.string(),
      name: z.string(),
      priceMonthlyCents: z.number(),
      priceIsStartingAt: z.boolean(),
      currency: z.string(),
    }),
    pendingPlan: z.object({ slug: z.string(), name: z.string() }).nullable(),
    status: z.enum(SUBSCRIPTION_STATUSES),
    provider: z.enum(["stripe", "asaas", "manual"]).nullable(),
    hasPaidSubscription: z.boolean(),
    trialEndsAt: z.string().nullable(),
    currentPeriodStart: z.string(),
    currentPeriodEnd: z.string(),
    cancelAtPeriodEnd: z.boolean(),
    graceEndsAt: z.string().nullable(),
    readOnly: z.boolean(),
    limits: Limits,
    features: Features,
    usage: z.object({ tasksCreated: z.number(), tasksPercent: z.number().nullable() }),
  })
  .openapi("Entitlements");

const PublicPlan = z
  .object({
    slug: z.string(),
    name: z.string(),
    priceMonthlyCents: z.number(),
    priceYearlyCents: z.number().nullable(),
    priceIsStartingAt: z.boolean(),
    currency: z.string(),
    limits: Limits,
    features: Features,
  })
  .openapi("PublicPlan");

const Err = {
  content: {
    "application/json": { schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }) },
  },
};
const json = <T extends z.ZodType>(s: T) => ({ content: { "application/json": { schema: s } } });

const getEntitlements = createRoute({
  method: "get",
  path: "/entitlements",
  tags: ["Cobrança"],
  summary: "Plano, recursos liberados e uso da cota do workspace ativo",
  responses: { 200: { description: "OK", ...json(Entitlements) } },
});

const getBilling = createRoute({
  method: "get",
  path: "/billing",
  tags: ["Cobrança"],
  summary: "Assinatura, planos disponíveis e status da cobrança",
  responses: {
    200: {
      description: "OK",
      ...json(
        z.object({ entitlements: Entitlements, plans: z.array(PublicPlan), billingEnabled: z.boolean() }),
      ),
    },
  },
});

const changePlan = createRoute({
  method: "post",
  path: "/billing/change-plan",
  tags: ["Cobrança"],
  summary: "Troca de plano (checkout, upgrade imediato ou downgrade no próximo ciclo)",
  request: {
    body: json(
      z.object({ planSlug: z.string().min(1), interval: z.enum(["monthly", "yearly"]).default("monthly") }),
    ),
  },
  responses: {
    200: {
      description: "OK",
      ...json(
        z.object({
          mode: z.enum(["checkout", "upgrade", "downgrade", "cancel_at_period_end", "schedule_free"]),
          url: z.string().nullable(),
        }),
      ),
    },
    402: { description: "Recurso de cobrança indisponível", ...Err },
    409: { description: "Troca inválida", ...Err },
    503: { description: "Cobrança não configurada", ...Err },
  },
});

const undoScheduled = createRoute({
  method: "post",
  path: "/billing/undo-scheduled",
  tags: ["Cobrança"],
  summary: "Desfaz downgrade ou cancelamento agendado",
  responses: { 200: { description: "OK", ...json(z.object({ ok: z.literal(true) })) } },
});

const portal = createRoute({
  method: "post",
  path: "/billing/portal",
  tags: ["Cobrança"],
  summary: "Link do portal de pagamento (cartão, faturas)",
  responses: {
    200: { description: "OK", ...json(z.object({ url: z.string() })) },
    404: { description: "Sem portal", ...Err },
  },
});

export const billingRoutes = (deps: Deps, providers: BillingProviders) => {
  const r = new OpenAPIHono<AppEnv>();
  r.use("/entitlements", requireTenant(deps.dbs));
  r.use("/billing", requireTenant(deps.dbs), requirePermission("tenant.billing"));
  r.use("/billing/*", requireTenant(deps.dbs), requirePermission("tenant.billing"));

  const subscriptionRow = (c: { var: AppEnv["Variables"] }) =>
    c.var.tenant.tx(async (tx) => {
      const [row] = await tx
        .select({ sub: schema.tenantSubscriptions, plan: schema.plans })
        .from(schema.tenantSubscriptions)
        .innerJoin(schema.plans, eq(schema.plans.id, schema.tenantSubscriptions.planId));
      if (!row) throw new DomainError(409, "NO_SUBSCRIPTION", "Workspace sem assinatura.");
      return row;
    });

  /** Provedor da assinatura paga atual (ou o padrão, para novos checkouts). */
  const providerFor = (name: string | null) => {
    const p = name === "stripe" || name === "asaas" ? providers[name] : providers.default;
    if (!p) throw new DomainError(503, "BILLING_NOT_CONFIGURED", "Cobrança online ainda não configurada.");
    return p;
  };

  const audit = (c: { var: AppEnv["Variables"] }, action: string, details: Record<string, unknown>) =>
    c.var.tenant.tx((tx) =>
      tx.insert(schema.auditLogs).values({
        tenantId: c.var.tenant.tenantId,
        actorId: c.var.tenant.userId,
        actorName: c.var.session?.user.name,
        actorRole: c.var.tenant.role,
        entity: "subscription",
        action,
        details: details as never,
        requestId: c.var.requestId,
      }),
    );

  return r
    .openapi(getEntitlements, async (c) => c.json(await c.var.tenant.tx(loadEntitlements), 200))
    .openapi(getBilling, async (c) => {
      const { entitlements, plans } = await c.var.tenant.tx(async (tx) => ({
        entitlements: await loadEntitlements(tx),
        plans: await tx
          .select()
          .from(schema.plans)
          .where(and(eq(schema.plans.active, true), eq(schema.plans.isPublic, true)))
          .orderBy(asc(schema.plans.sortOrder)),
      }));
      return c.json(
        {
          entitlements,
          billingEnabled: !!providers.default,
          plans: plans.map((p) => ({
            slug: p.slug,
            name: p.name,
            priceMonthlyCents: Number(p.priceMonthlyCents),
            priceYearlyCents: p.priceYearlyCents === null ? null : Number(p.priceYearlyCents),
            priceIsStartingAt: p.priceIsStartingAt,
            currency: p.currency,
            limits: p.limits,
            features: p.features,
          })),
        },
        200,
      );
    })
    .openapi(changePlan, async (c) => {
      const { planSlug, interval } = c.req.valid("json");
      const change = await c.var.tenant.tx((tx) => planChangeFor(tx, planSlug));
      if (interval === "yearly" && change.target.priceYearlyCents === null)
        throw new DomainError(409, "INTERVAL_UNAVAILABLE", "Este plano não tem opção anual.");
      const { sub, plan: current } = await subscriptionRow(c);
      let url: string | null = null;

      if (change.mode === "checkout") {
        const p = providerFor(null);
        const email = c.var.session!.user.email;
        const [t] = await c.var.tenant.tx((tx) =>
          tx.select({ name: schema.tenants.name }).from(schema.tenants),
        );
        ({ url } = await p.createCheckout({
          tenantId: c.var.tenant.tenantId,
          tenantName: t?.name ?? "",
          email,
          plan: change.target,
          interval,
          customerId: sub.provider === p.name ? sub.providerCustomerId : null,
          successUrl: `${deps.env.WEB_URL}/assinatura?checkout=ok`,
          cancelUrl: `${deps.env.WEB_URL}/assinatura`,
        }));
      } else if (change.mode === "upgrade" || change.mode === "downgrade") {
        await providerFor(sub.provider).changePlan({
          subscriptionId: sub.providerSubscriptionId!,
          tenantId: c.var.tenant.tenantId,
          plan: change.target,
          currentPlan: current,
          interval: sub.interval,
          mode: change.mode,
          periodStart: sub.currentPeriodStart,
          periodEnd: sub.currentPeriodEnd,
        });
      } else if (change.mode === "cancel_at_period_end") {
        await providerFor(sub.provider).setCancelAtPeriodEnd({
          subscriptionId: sub.providerSubscriptionId!,
          cancel: true,
          periodEnd: sub.currentPeriodEnd,
        });
      }
      await c.var.tenant.tx((tx) => recordPlanChange(tx, change));
      await audit(c, `plan.${change.mode}`, { from: current.slug, to: change.target.slug, interval });
      return c.json({ mode: change.mode, url }, 200);
    })
    .openapi(undoScheduled, async (c) => {
      const { sub, plan } = await subscriptionRow(c);
      const paid = !!sub.providerSubscriptionId && (sub.provider === "stripe" || sub.provider === "asaas");
      if (paid && sub.cancelAtPeriodEnd)
        await providerFor(sub.provider).setCancelAtPeriodEnd({
          subscriptionId: sub.providerSubscriptionId!,
          cancel: false,
          periodEnd: sub.currentPeriodEnd,
        });
      if (paid && sub.pendingPlanId)
        // volta o preço do plano atual no provedor (sem cobrança extra)
        await providerFor(sub.provider).changePlan({
          subscriptionId: sub.providerSubscriptionId!,
          tenantId: c.var.tenant.tenantId,
          plan,
          currentPlan: plan,
          interval: sub.interval,
          mode: "downgrade",
          periodStart: sub.currentPeriodStart,
          periodEnd: sub.currentPeriodEnd,
        });
      await c.var.tenant.tx(clearScheduledChange);
      await audit(c, "plan.undo_scheduled", {});
      return c.json({ ok: true as const }, 200);
    })
    .openapi(portal, async (c) => {
      const { sub } = await subscriptionRow(c);
      if (!sub.providerCustomerId || (sub.provider !== "stripe" && sub.provider !== "asaas"))
        throw new DomainError(404, "NO_PORTAL", "Ainda não há assinatura paga.");
      const res = await providerFor(sub.provider).createPortal({
        customerId: sub.providerCustomerId,
        subscriptionId: sub.providerSubscriptionId,
        returnUrl: `${deps.env.WEB_URL}/assinatura`,
      });
      if (!res) throw new DomainError(404, "NO_PORTAL", "Nenhuma fatura em aberto.");
      return c.json(res, 200);
    });
};
