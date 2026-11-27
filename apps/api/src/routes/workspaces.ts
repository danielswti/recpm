/**
 * Workspaces (tenants): criação no cadastro, dados do workspace ativo e exclusão (LGPD).
 * A criação é UMA transação: tenant + vínculo admin + catálogos padrão + trial + contador de uso.
 * A exclusão apaga o tenant (todas as tabelas com tenant_id caem em cascata) e os arquivos do bucket.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { schema, withTenant } from "@recpm/db";
import { seedTenantDefaults, TRIAL_PLAN_SLUG } from "@recpm/db/seed";
import { createWorkspaceSchema, TRIAL_DAYS } from "@recpm/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Deps } from "../deps";
import { AppError, isUniqueViolation } from "../lib/errors";
import { createStorage } from "../lib/storage";
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

const deleteWorkspace = createRoute({
  method: "delete",
  path: "/workspace",
  tags: ["Workspaces"],
  summary: "Exclui o workspace ativo e todos os dados dele (só admin; irreversível)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ confirmSlug: z.string().min(1) }).openapi("DeleteWorkspace"),
        },
      },
      required: true,
    },
  },
  responses: {
    204: { description: "Excluído" },
    409: { description: "Assinatura paga ativa", content: { "application/json": { schema: ErrorBody } } },
  },
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
    })
    .openapi(deleteWorkspace, async (c) => {
      const { tenantId, userId, role } = c.var.tenant;
      if (role !== "admin")
        throw new AppError(403, "FORBIDDEN", "Só o administrador pode excluir o workspace.");
      const db = deps.dbs.platformDb;
      const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      if (!t) throw new AppError(404, "NOT_FOUND", "Workspace não encontrado.");
      if (c.req.valid("json").confirmSlug.trim().toLowerCase() !== t.slug)
        throw new AppError(400, "CONFIRMATION_MISMATCH", "Digite o endereço do workspace para confirmar.");
      const [sub] = await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(
          and(
            eq(schema.tenantSubscriptions.tenantId, tenantId),
            isNotNull(schema.tenantSubscriptions.providerSubscriptionId),
            inArray(schema.tenantSubscriptions.status, ["active", "past_due"]),
          ),
        );
      if (sub)
        throw new AppError(
          409,
          "SUBSCRIPTION_ACTIVE",
          "Cancele a assinatura em Configurações › Plano antes de excluir o workspace.",
        );
      const keys = (
        await db
          .select({ key: schema.files.storageKey })
          .from(schema.files)
          .where(eq(schema.files.tenantId, tenantId))
      ).map((f) => f.key);
      await db.transaction(async (tx) => {
        await tx.insert(schema.platformAuditLogs).values({
          actorId: userId,
          action: "tenant.delete",
          details: { tenantId, name: t.name, slug: t.slug, files: keys.length },
          ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null,
        });
        await tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
      });
      // Arquivos: depois do banco (se algo falhar aqui, o dado já não é acessível; o log registra)
      const storage = deps.storage === undefined ? createStorage(deps.env) : deps.storage;
      if (storage && keys.length) {
        const queue = [...keys];
        const worker = async () => {
          for (let k = queue.pop(); k; k = queue.pop())
            await storage
              .remove(k)
              .catch((err) => deps.logger.error({ err, key: k }, "falha ao apagar arquivo"));
        };
        await Promise.all(Array.from({ length: 8 }, worker));
      }
      deps.logger.info({ tenantId, files: keys.length }, "workspace excluído");
      return c.body(null, 204);
    });
};
