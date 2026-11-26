/**
 * Back-office do super_admin (§4 Billing). Usa o papel recpm_platform (sem RLS) — por isso cada
 * rota daqui exige requireSuperAdmin e toda ação que muda algo vai para platform_audit_logs.
 *
 *   GET  /platform/metrics                    MRR, tenants por situação, trials acabando
 *   GET  /platform/tenants?q=&status=&page=   lista com plano, uso do ciclo, membros
 *   POST /platform/tenants/:id/suspend        suspende (ninguém entra; nada é apagado)
 *   POST /platform/tenants/:id/reactivate     reativa (suspenso ou somente leitura)
 *   POST /platform/tenants/:id/plan           atribui plano manualmente (contratos Enterprise)
 *   POST /platform/tenants/:id/impersonation  devolve o admin a personificar (a troca de sessão é do Better Auth)
 *   GET  /platform/plans · PATCH /platform/plans/:slug   edita preços, limites e recursos
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { addMonths, DomainError } from "@recpm/core";
import { schema } from "@recpm/db";
import { PLAN_FEATURES } from "@recpm/shared";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { requireSuperAdmin } from "../middleware/platform";
import type { AppEnv } from "../types";

const json = <T extends z.ZodType>(s: T) => ({ content: { "application/json": { schema: s } } });
const TenantStatus = z.enum(["active", "read_only", "suspended"]);
const Ok = json(z.object({ ok: z.literal(true) }));
const IdParam = z.object({ id: z.uuid() });

const Limits = z.object({
  tasksPerCycle: z.number().int().min(0).nullable(),
  maxUsers: z.number().int().min(1).nullable(),
  maxClientPortalUsers: z.number().int().min(0).nullable(),
  storageGb: z.number().min(0),
  aiMessagesPerCycle: z.number().int().min(0).nullable(),
});
const Features = z.object(
  Object.fromEntries(PLAN_FEATURES.map((f) => [f, z.boolean()])) as Record<
    (typeof PLAN_FEATURES)[number],
    z.ZodBoolean
  >,
);
const PlanAdmin = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    priceMonthlyCents: z.number().int(),
    priceYearlyCents: z.number().int().nullable(),
    priceIsStartingAt: z.boolean(),
    currency: z.string(),
    limits: Limits,
    features: Features,
    stripePriceIds: z.object({ monthly: z.string().optional(), yearly: z.string().optional() }),
    asaasPlanIds: z.object({ monthly: z.string().optional(), yearly: z.string().optional() }),
    trialDays: z.number().int(),
    isPublic: z.boolean(),
    active: z.boolean(),
    sortOrder: z.number().int(),
  })
  .openapi("PlanAdmin");

const metrics = createRoute({
  method: "get",
  path: "/platform/metrics",
  tags: ["Plataforma"],
  summary: "MRR e tenants por situação",
  responses: {
    200: {
      description: "OK",
      ...json(
        z.object({
          mrrCents: z.number(),
          payingTenants: z.number(),
          tenants: z.object({
            total: z.number(),
            trialing: z.number(),
            pastDue: z.number(),
            readOnly: z.number(),
            suspended: z.number(),
          }),
          trialsEndingIn7Days: z.number(),
        }),
      ),
    },
  },
});

const TenantRow = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    status: TenantStatus,
    createdAt: z.string(),
    plan: z.object({ slug: z.string(), name: z.string() }),
    subscriptionStatus: z.string(),
    provider: z.string().nullable(),
    trialEndsAt: z.string().nullable(),
    currentPeriodEnd: z.string(),
    tasksCreated: z.number(),
    tasksLimit: z.number().nullable(),
    members: z.number(),
    adminEmail: z.string().nullable(),
  })
  .openapi("PlatformTenant");

const listTenants = createRoute({
  method: "get",
  path: "/platform/tenants",
  tags: ["Plataforma"],
  summary: "Tenants com plano, uso e situação",
  request: {
    query: z.object({
      q: z.string().optional(),
      status: z.enum(["active", "read_only", "suspended", "trialing", "past_due"]).optional(),
      page: z.coerce.number().int().min(1).default(1),
    }),
  },
  responses: {
    200: {
      description: "OK",
      ...json(
        z.object({ data: z.array(TenantRow), total: z.number(), page: z.number(), pageSize: z.number() }),
      ),
    },
  },
});

const suspend = createRoute({
  method: "post",
  path: "/platform/tenants/{id}/suspend",
  tags: ["Plataforma"],
  summary: "Suspende o tenant",
  request: { params: IdParam, body: json(z.object({ reason: z.string().trim().min(3).max(500) })) },
  responses: { 200: { description: "OK", ...Ok } },
});
const reactivate = createRoute({
  method: "post",
  path: "/platform/tenants/{id}/reactivate",
  tags: ["Plataforma"],
  summary: "Reativa o tenant",
  request: { params: IdParam },
  responses: { 200: { description: "OK", ...Ok } },
});
const assignPlan = createRoute({
  method: "post",
  path: "/platform/tenants/{id}/plan",
  tags: ["Plataforma"],
  summary: "Atribui plano manualmente (sem provedor de pagamento)",
  request: {
    params: IdParam,
    body: json(z.object({ planSlug: z.string().min(1), months: z.number().int().min(1).max(36).default(1) })),
  },
  responses: { 200: { description: "OK", ...Ok } },
});
const impersonation = createRoute({
  method: "post",
  path: "/platform/tenants/{id}/impersonation",
  tags: ["Plataforma"],
  summary: "Escolhe o admin do tenant a personificar (registra a intenção na auditoria)",
  request: { params: IdParam, body: json(z.object({ reason: z.string().trim().min(3).max(500) })) },
  responses: { 200: { description: "OK", ...json(z.object({ userId: z.uuid(), tenantId: z.uuid() })) } },
});
const listPlans = createRoute({
  method: "get",
  path: "/platform/plans",
  tags: ["Plataforma"],
  summary: "Todos os planos (inclusive ocultos)",
  responses: { 200: { description: "OK", ...json(z.object({ data: z.array(PlanAdmin) })) } },
});
const updatePlan = createRoute({
  method: "patch",
  path: "/platform/plans/{slug}",
  tags: ["Plataforma"],
  summary: "Edita um plano",
  request: {
    params: z.object({ slug: z.string() }),
    body: json(
      PlanAdmin.pick({
        name: true,
        priceMonthlyCents: true,
        priceYearlyCents: true,
        priceIsStartingAt: true,
        limits: true,
        features: true,
        stripePriceIds: true,
        asaasPlanIds: true,
        trialDays: true,
        isPublic: true,
        active: true,
        sortOrder: true,
      }).partial(),
    ),
  },
  responses: { 200: { description: "OK", ...json(PlanAdmin) } },
});

export const platformRoutes = (deps: Deps) => {
  const db = deps.dbs.platformDb;
  const r = new OpenAPIHono<AppEnv>();
  r.use("/platform/*", requireSuperAdmin);

  const audit = (
    c: { var: AppEnv["Variables"]; req: { header(n: string): string | undefined } },
    tenantId: string | null,
    action: string,
    details: Record<string, unknown>,
  ) =>
    db.insert(schema.platformAuditLogs).values({
      actorId: c.var.session!.user.id,
      tenantId,
      action,
      details,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null,
    });

  const tenantOr404 = async (id: string) => {
    const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
    if (!t) throw new DomainError(404, "TENANT_NOT_FOUND", "Tenant não encontrado.");
    return t;
  };

  const ts = schema.tenantSubscriptions;
  const planRow = (p: typeof schema.plans.$inferSelect) => ({
    ...p,
    priceMonthlyCents: Number(p.priceMonthlyCents),
    priceYearlyCents: p.priceYearlyCents === null ? null : Number(p.priceYearlyCents),
  });

  return r
    .openapi(metrics, async (c) => {
      const [m] = await db
        .execute<{
          mrr: string;
          paying: string;
          total: string;
          trialing: string;
          past_due: string;
          read_only: string;
          suspended: string;
          trials_7d: string;
        }>(sql`
        SELECT
          COALESCE(SUM(CASE
            WHEN s.status IN ('active','past_due') AND (s.provider_subscription_id IS NOT NULL OR s.provider = 'manual')
            THEN CASE WHEN s.interval = 'yearly' THEN COALESCE(p.price_yearly_cents, 0) / 12 ELSE p.price_monthly_cents END
            ELSE 0 END), 0)                                                          AS mrr,
          COUNT(*) FILTER (WHERE s.status IN ('active','past_due') AND p.price_monthly_cents > 0
                           AND (s.provider_subscription_id IS NOT NULL OR s.provider = 'manual')) AS paying,
          COUNT(*)                                                                    AS total,
          COUNT(*) FILTER (WHERE s.status = 'trialing')                               AS trialing,
          COUNT(*) FILTER (WHERE s.status = 'past_due')                               AS past_due,
          COUNT(*) FILTER (WHERE t.status = 'read_only')                              AS read_only,
          COUNT(*) FILTER (WHERE t.status = 'suspended')                              AS suspended,
          COUNT(*) FILTER (WHERE s.status = 'trialing' AND s.trial_ends_at <= now() + interval '7 days') AS trials_7d
        FROM tenants t
        JOIN tenant_subscriptions s ON s.tenant_id = t.id
        JOIN plans p ON p.id = s.plan_id
        WHERE t.deleted_at IS NULL`)
        .then((r) => r.rows);
      const n = (v: string | undefined) => Number(v ?? 0);
      return c.json(
        {
          mrrCents: n(m?.mrr),
          payingTenants: n(m?.paying),
          tenants: {
            total: n(m?.total),
            trialing: n(m?.trialing),
            pastDue: n(m?.past_due),
            readOnly: n(m?.read_only),
            suspended: n(m?.suspended),
          },
          trialsEndingIn7Days: n(m?.trials_7d),
        },
        200,
      );
    })
    .openapi(listTenants, async (c) => {
      const { q, status, page } = c.req.valid("query");
      const pageSize = 50;
      const filters = [sql`${schema.tenants.deletedAt} IS NULL`];
      if (q) filters.push(or(ilike(schema.tenants.name, `%${q}%`), ilike(schema.tenants.slug, `%${q}%`))!);
      if (status === "trialing" || status === "past_due") filters.push(eq(ts.status, status));
      else if (status) filters.push(eq(schema.tenants.status, status));
      const where = and(...filters);

      const rows = await db
        .select({
          t: schema.tenants,
          s: ts,
          plan: { slug: schema.plans.slug, name: schema.plans.name, limits: schema.plans.limits },
          tasksCreated: sql<number>`COALESCE((SELECT u.tasks_created FROM usage_counters u
              WHERE u.tenant_id = ${schema.tenants.id} AND u.period_start = ${ts.currentPeriodStart}), 0)::int`,
          members: sql<number>`(SELECT count(*) FROM memberships m WHERE m.tenant_id = ${schema.tenants.id} AND m.active)::int`,
          adminEmail: sql<string | null>`(SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.tenant_id = ${schema.tenants.id} AND m.role = 'admin' AND m.active ORDER BY m.created_at LIMIT 1)`,
        })
        .from(schema.tenants)
        .innerJoin(ts, eq(ts.tenantId, schema.tenants.id))
        .innerJoin(schema.plans, eq(schema.plans.id, ts.planId))
        .where(where)
        .orderBy(desc(schema.tenants.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.tenants)
        .innerJoin(ts, eq(ts.tenantId, schema.tenants.id))
        .where(where);

      return c.json(
        {
          page,
          pageSize,
          total,
          data: rows.map((r) => ({
            id: r.t.id,
            name: r.t.name,
            slug: r.t.slug,
            status: r.t.status,
            createdAt: r.t.createdAt.toISOString(),
            plan: { slug: r.plan.slug, name: r.plan.name },
            subscriptionStatus: r.s.status,
            provider: r.s.provider,
            trialEndsAt: r.s.trialEndsAt?.toISOString() ?? null,
            currentPeriodEnd: r.s.currentPeriodEnd.toISOString(),
            tasksCreated: r.tasksCreated,
            tasksLimit: r.plan.limits.tasksPerCycle,
            members: r.members,
            adminEmail: r.adminEmail,
          })),
        },
        200,
      );
    })
    .openapi(suspend, async (c) => {
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      await tenantOr404(id);
      await db
        .update(schema.tenants)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(schema.tenants.id, id));
      await audit(c, id, "tenant.suspend", { reason });
      return c.json({ ok: true as const }, 200);
    })
    .openapi(reactivate, async (c) => {
      const { id } = c.req.valid("param");
      const t = await tenantOr404(id);
      await db
        .update(schema.tenants)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(schema.tenants.id, id));
      await audit(c, id, "tenant.reactivate", { from: t.status });
      return c.json({ ok: true as const }, 200);
    })
    .openapi(assignPlan, async (c) => {
      const { id } = c.req.valid("param");
      const { planSlug, months } = c.req.valid("json");
      await tenantOr404(id);
      const [plan] = await db.select().from(schema.plans).where(eq(schema.plans.slug, planSlug));
      if (!plan) throw new DomainError(404, "PLAN_NOT_FOUND", "Plano não encontrado.");
      await db.transaction(async (tx) => {
        const [sub] = await tx.select().from(ts).where(eq(ts.tenantId, id)).for("update");
        if (!sub) throw new DomainError(409, "NO_SUBSCRIPTION", "Tenant sem assinatura.");
        if (sub.providerSubscriptionId && sub.provider !== "manual")
          throw new DomainError(
            409,
            "PAID_SUBSCRIPTION_ACTIVE",
            "Cancele a assinatura no provedor antes de atribuir manualmente.",
          );
        const now = new Date();
        const end = addMonths(now, months);
        await tx
          .update(ts)
          .set({
            planId: plan.id,
            pendingPlanId: null,
            status: "active",
            provider: "manual",
            trialEndsAt: null,
            cancelAtPeriodEnd: false,
            pastDueSince: null,
            graceEndsAt: null,
            currentPeriodStart: now,
            currentPeriodEnd: end,
            updatedAt: now,
          })
          .where(eq(ts.id, sub.id));
        await tx
          .insert(schema.usageCounters)
          .values({ tenantId: id, periodStart: now, periodEnd: end })
          .onConflictDoNothing();
      });
      await audit(c, id, "tenant.plan_assigned", { plan: planSlug, months });
      return c.json({ ok: true as const }, 200);
    })
    .openapi(impersonation, async (c) => {
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      await tenantOr404(id);
      const [admin] = await db
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.tenantId, id),
            eq(schema.memberships.role, "admin"),
            eq(schema.memberships.active, true),
          ),
        )
        .orderBy(asc(schema.memberships.createdAt))
        .limit(1);
      if (!admin) throw new DomainError(409, "NO_ADMIN", "Tenant sem administrador ativo.");
      await audit(c, id, "tenant.impersonate", { userId: admin.userId, reason });
      return c.json({ userId: admin.userId, tenantId: id }, 200);
    })
    .openapi(listPlans, async (c) => {
      const plans = await db.select().from(schema.plans).orderBy(asc(schema.plans.sortOrder));
      return c.json({ data: plans.map(planRow) }, 200);
    })
    .openapi(updatePlan, async (c) => {
      const { slug } = c.req.valid("param");
      const patch = c.req.valid("json");
      const [before] = await db.select().from(schema.plans).where(eq(schema.plans.slug, slug));
      if (!before) throw new DomainError(404, "PLAN_NOT_FOUND", "Plano não encontrado.");
      const [after] = await db
        .update(schema.plans)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.plans.slug, slug))
        .returning();
      await audit(c, null, "plan.update", { slug, patch });
      return c.json(planRow(after!), 200);
    });
};
