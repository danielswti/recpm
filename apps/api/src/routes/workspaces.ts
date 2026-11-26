/**
 * Workspaces (tenants): criação no cadastro e dados do workspace ativo.
 * A criação é UMA transação: tenant + vínculo admin + catálogos padrão + trial + contador de uso.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { schema, withTenant } from "@recpm/db";
import { seedTenantDefaults, TRIAL_PLAN_SLUG } from "@recpm/db/seed";
import { createWorkspaceSchema, TRIAL_DAYS } from "@recpm/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Deps } from "../deps";
import { AppError, isUniqueViolation } from "../lib/errors";
import { requireSession } from "../middleware/session";
import { requireTenant } from "../middleware/tenant";
import type { AppEnv } from "../types";

const Workspace = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(["active", "read_only", "suspended"]),
    locale: z.string(),
    currency: z.string(),
    timezone: z.string(),
    branding: z.record(z.string(), z.unknown()),
  })
  .openapi("Workspace");

const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).openapi("Error");

const createWorkspace = createRoute({
  method: "post",
  path: "/workspaces",
  tags: ["Workspaces"],
  summary: "Cria um workspace (tenant) com trial e catálogos padrão",
  request: {
    body: {
      content: {
        "application/json": { schema: z.object(createWorkspaceSchema.shape).openapi("CreateWorkspace") },
      },
    },
  },
  responses: {
    201: {
      description: "Criado e definido como ativo",
      content: { "application/json": { schema: z.object({ id: z.uuid(), slug: z.string() }) } },
    },
    409: { description: "Slug em uso", content: { "application/json": { schema: ErrorBody } } },
  },
});

const currentWorkspace = createRoute({
  method: "get",
  path: "/workspace",
  tags: ["Workspaces"],
  summary: "Workspace ativo da sessão",
  responses: { 200: { description: "OK", content: { "application/json": { schema: Workspace } } } },
});

export const workspaceRoutes = (deps: Deps) => {
  const r = new OpenAPIHono<AppEnv>();
  r.use("/workspaces", requireSession);
  r.use("/workspace", requireTenant(deps.dbs));

  return r
    .openapi(createWorkspace, async (c) => {
      const { name, slug } = c.req.valid("json");
      const user = c.var.session!.user;
      const tenantId = uuidv7();
      const now = new Date();
      const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);

      try {
        await withTenant(deps.dbs.appDb, { tenantId, userId: user.id, actor: "system" }, async (tx) => {
          await tx.insert(schema.tenants).values({ id: tenantId, name, slug });
          await tx.insert(schema.memberships).values({ tenantId, userId: user.id, role: "admin" });
          await seedTenantDefaults(tx, tenantId);
          const [plan] = await tx
            .select({ id: schema.plans.id })
            .from(schema.plans)
            .where(eq(schema.plans.slug, TRIAL_PLAN_SLUG));
          if (!plan)
            throw new AppError(500, "PLANS_NOT_SEEDED", "Planos não cadastrados (rode as migrações).");
          await tx.insert(schema.tenantSubscriptions).values({
            tenantId,
            planId: plan.id,
            status: "trialing",
            trialEndsAt: trialEnd,
            currentPeriodStart: now,
            currentPeriodEnd: trialEnd,
          });
          await tx.insert(schema.usageCounters).values({ tenantId, periodStart: now, periodEnd: trialEnd });
          await tx.insert(schema.auditLogs).values({
            tenantId,
            actorId: user.id,
            actorName: user.name,
            actorRole: "admin",
            entity: "tenant",
            entityId: tenantId,
            entityLabel: name,
            action: "create",
            requestId: c.var.requestId,
          });
        });
      } catch (e) {
        if (isUniqueViolation(e, "tenants_slug_uq"))
          throw new AppError(409, "SLUG_TAKEN", "Este endereço já está em uso.");
        throw e;
      }

      await c.var.auth.api.setActiveOrganization({
        headers: c.req.raw.headers,
        body: { organizationId: tenantId },
      });
      return c.json({ id: tenantId, slug }, 201);
    })
    .openapi(currentWorkspace, async (c) => {
      const row = await c.var.tenant.tx(async (tx) => {
        const [t] = await tx.select().from(schema.tenants);
        const [s] = await tx.select({ branding: schema.tenantSettings.branding }).from(schema.tenantSettings);
        return t && { ...t, branding: s?.branding ?? {} };
      });
      if (!row) throw new AppError(404, "NOT_FOUND", "Workspace não encontrado.");
      return c.json(
        {
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          locale: row.locale,
          currency: row.currency,
          timezone: row.timezone,
          branding: row.branding,
        },
        200,
      );
    });
};
