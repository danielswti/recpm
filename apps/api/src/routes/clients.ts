/**
 * Clientes (§6.7): CRUD, saldo de horas e usuários do portal.
 *
 * Horas (no mês corrente, que é o ciclo dos contratos mensais):
 * - contratadas = Σ quantidade por período × horas estimadas do tipo, nos itens de contrato dos
 *   projetos ativos do cliente;
 * - investidas = Σ horas úteis lançadas em tarefas dos projetos do cliente no mês;
 * - restantes = contratadas − investidas.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { type AppTx, schema } from "@recpm/db";
import { clientInput } from "@recpm/shared";
import { and, asc, count, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { audit, diff } from "../lib/audit";
import { AppError, isUniqueViolation } from "../lib/errors";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;
const tags = ["Clientes"];

const Client = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    document: z.string().nullable(),
    notes: z.string().nullable(),
    assetsLink: z.string().nullable(),
    active: z.boolean(),
    createdAt: z.string(),
    projectCount: z.number(),
    activeProjectCount: z.number(),
    portalUserCount: z.number(),
    hours: z.object({ contracted: z.number(), invested: z.number(), remaining: z.number() }),
  })
  .openapi("Client");

const PortalUser = z
  .object({
    kind: z.enum(["member", "invitation"]),
    id: z.uuid(),
    name: z.string().nullable(),
    email: z.string(),
    active: z.boolean(),
    expiresAt: z.string().nullable(),
  })
  .openapi("ClientPortalUser");

const ClientBody = z.object(clientInput.shape).openapi("ClientInput");
const IdParam = z.object({ id: z.uuid() });
const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});

const notFound = () => new AppError(404, "NOT_FOUND", "Cliente não encontrado.");
const dupCode = () => new AppError(409, "CLIENT_CODE_TAKEN", "Já existe um cliente com este código.");

/** Busca clientes com os números calculados; `where` filtra a lista. */
async function query(tx: AppTx, where: ReturnType<typeof and>, page = 1, pageSize = 1000) {
  const monthStart = sql`date_trunc('month', now())`;
  const projects = tx
    .select({
      clientId: s.projects.clientId,
      total: count().as("p_total"),
      active:
        sql<number>`count(*) filter (where not ${s.projects.archived} and ${s.projects.status} not in ('concluido'))`.as(
          "p_active",
        ),
    })
    .from(s.projects)
    .where(isNull(s.projects.deletedAt))
    .groupBy(s.projects.clientId)
    .as("p");
  const contracted = tx
    .select({
      clientId: s.projects.clientId,
      hours:
        sql<number>`coalesce(sum(${s.projectContractItems.quantityPerPeriod} * coalesce(${s.taskTypes.defaultEstimatedHours}, 0)), 0)`.as(
          "ch_hours",
        ),
    })
    .from(s.projectContractItems)
    .innerJoin(s.projects, eq(s.projects.id, s.projectContractItems.projectId))
    .innerJoin(s.taskTypes, eq(s.taskTypes.id, s.projectContractItems.taskTypeId))
    .where(and(isNull(s.projects.deletedAt), eq(s.projects.archived, false)))
    .groupBy(s.projects.clientId)
    .as("ch");
  const invested = tx
    .select({
      clientId: s.projects.clientId,
      ms: sql<number>`coalesce(sum(${s.timeEntries.businessMs}), 0)`.as("ih_ms"),
    })
    .from(s.timeEntries)
    .innerJoin(s.tasks, eq(s.tasks.id, s.timeEntries.taskId))
    .innerJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
    .where(sql`${s.timeEntries.startedAt} >= ${monthStart}`)
    .groupBy(s.projects.clientId)
    .as("ih");
  const portal = tx
    .select({ clientId: s.memberships.clientId, n: count().as("pu_n") })
    .from(s.memberships)
    .where(and(eq(s.memberships.role, "cliente"), eq(s.memberships.active, true)))
    .groupBy(s.memberships.clientId)
    .as("pu");

  const rows = await tx
    .select({
      c: s.clients,
      projectCount: projects.total,
      activeProjectCount: projects.active,
      contracted: contracted.hours,
      investedMs: invested.ms,
      portalUserCount: portal.n,
      total: sql<number>`count(*) over ()`,
    })
    .from(s.clients)
    .leftJoin(projects, eq(projects.clientId, s.clients.id))
    .leftJoin(contracted, eq(contracted.clientId, s.clients.id))
    .leftJoin(invested, eq(invested.clientId, s.clients.id))
    .leftJoin(portal, eq(portal.clientId, s.clients.id))
    .where(and(isNull(s.clients.deletedAt), where))
    .orderBy(asc(s.clients.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    total: Number(rows[0]?.total ?? 0),
    data: rows.map((r) => {
      const contractedH = round(Number(r.contracted ?? 0));
      const investedH = round(Number(r.investedMs ?? 0) / 3_600_000);
      return {
        id: r.c.id,
        code: r.c.code,
        name: r.c.name,
        email: r.c.email,
        phone: r.c.phone,
        document: r.c.document,
        notes: r.c.notes,
        assetsLink: r.c.assetsLink,
        active: r.c.active,
        createdAt: r.c.createdAt.toISOString(),
        projectCount: Number(r.projectCount ?? 0),
        activeProjectCount: Number(r.activeProjectCount ?? 0),
        portalUserCount: Number(r.portalUserCount ?? 0),
        hours: { contracted: contractedH, invested: investedH, remaining: round(contractedH - investedH) },
      };
    }),
  };
}

const one = async (tx: AppTx, id: string) => {
  const { data } = await query(tx, eq(s.clients.id, id));
  if (!data[0]) throw notFound();
  return data[0];
};

export const clientRoutes = (deps: Deps) => {
  const r = router();
  r.use("/clients", requireTenant(deps.dbs), requirePermission("clients.read"));
  r.use("/clients/*", requireTenant(deps.dbs), requirePermission("clients.read"));
  r.on(["POST", "PATCH", "DELETE"], ["/clients", "/clients/*"], requirePermission("clients.manage"));

  return r
    .openapi(
      createRoute({
        method: "get",
        path: "/clients",
        tags,
        summary: "Clientes (busca por nome, código, e-mail ou documento)",
        request: { query: ListQuery },
        responses: {
          200: ok(
            z.object({ data: z.array(Client), total: z.number(), page: z.number(), pageSize: z.number() }),
          ),
        },
      }),
      async (c) => {
        const { q, status, page, pageSize } = c.req.valid("query");
        const term = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
        const digits = q?.replace(/\D/g, "");
        const where = and(
          status === "all" ? undefined : eq(s.clients.active, status === "active"),
          term
            ? or(
                ilike(s.clients.name, term),
                ilike(s.clients.code, term),
                ilike(s.clients.email, term),
                digits ? ilike(s.clients.document, `%${digits}%`) : undefined,
              )
            : undefined,
        );
        const res = await c.var.tenant.tx((tx) => query(tx, where, page, pageSize));
        return c.json({ ...res, page, pageSize }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/clients/{id}",
        tags,
        summary: "Cliente",
        request: { params: IdParam },
        responses: { 200: ok(Client) },
      }),
      async (c) => c.json(await c.var.tenant.tx((tx) => one(tx, c.req.valid("param").id)), 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/clients",
        tags,
        summary: "Criar cliente",
        request: { body: { content: { "application/json": { schema: ClientBody } }, required: true } },
        responses: { 201: ok(Client, "Criado") },
      }),
      async (c) => {
        const b = clientInput.parse(c.req.valid("json"));
        try {
          const client = await c.var.tenant.tx(async (tx) => {
            const [row] = await tx
              .insert(s.clients)
              .values({ tenantId: c.var.tenant.tenantId, ...b, active: b.active ?? true })
              .returning();
            await audit(c, tx, {
              entity: "client",
              entityId: row!.id,
              entityLabel: row!.name,
              action: "create",
            });
            return one(tx, row!.id);
          });
          return c.json(client, 201);
        } catch (e) {
          if (isUniqueViolation(e)) throw dupCode();
          throw e;
        }
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/clients/{id}",
        tags,
        summary: "Editar cliente (inclui ativar/desativar)",
        request: {
          params: IdParam,
          body: { content: { "application/json": { schema: ClientBody.partial() } }, required: true },
        },
        responses: { 200: ok(Client) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = clientInput.partial().parse(c.req.valid("json"));
        const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
        try {
          const client = await c.var.tenant.tx(async (tx) => {
            const before = await one(tx, id);
            await tx
              .update(s.clients)
              .set({ ...patch, updatedAt: new Date() })
              .where(eq(s.clients.id, id));
            const changes = diff(before, patch);
            if (Object.keys(changes).length)
              await audit(c, tx, {
                entity: "client",
                entityId: id,
                entityLabel: (patch.name as string | undefined) ?? before.name,
                action: patch.active === false ? "deactivate" : patch.active === true ? "activate" : "update",
                details: changes,
              });
            return one(tx, id);
          });
          return c.json(client, 200);
        } catch (e) {
          if (isUniqueViolation(e)) throw dupCode();
          throw e;
        }
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/clients/{id}",
        tags,
        summary: "Apagar cliente sem projetos (com projetos, desative)",
        request: { params: IdParam },
        responses: { 204: { description: "Apagado" } },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await c.var.tenant.tx(async (tx) => {
          const client = await one(tx, id);
          if (client.projectCount || client.portalUserCount)
            throw new AppError(
              409,
              "CLIENT_IN_USE",
              "Este cliente tem projetos ou usuários do portal. Desative-o em vez de apagar.",
            );
          await tx
            .update(s.clients)
            .set({ deletedAt: new Date(), active: false })
            .where(eq(s.clients.id, id));
          await audit(c, tx, { entity: "client", entityId: id, entityLabel: client.name, action: "delete" });
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/clients/{id}/portal-users",
        tags,
        summary: "Usuários do portal do cliente e convites pendentes",
        request: { params: IdParam },
        responses: { 200: ok(z.object({ data: z.array(PortalUser) })) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const data = await c.var.tenant.tx(async (tx) => {
          await one(tx, id);
          const members = await tx
            .select({
              id: s.memberships.id,
              name: s.users.name,
              email: s.users.email,
              active: s.memberships.active,
            })
            .from(s.memberships)
            .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
            .where(and(eq(s.memberships.clientId, id), eq(s.memberships.role, "cliente")))
            .orderBy(asc(s.users.name));
          const invites = await tx
            .select({ id: s.invitations.id, email: s.invitations.email, expiresAt: s.invitations.expiresAt })
            .from(s.invitations)
            .where(
              and(
                eq(s.invitations.clientId, id),
                eq(s.invitations.status, "pending"),
                sql`${s.invitations.expiresAt} > now()`,
              ),
            );
          return [
            ...members.map((m) => ({ kind: "member" as const, ...m, expiresAt: null })),
            ...invites.map((i) => ({
              kind: "invitation" as const,
              id: i.id,
              name: null,
              email: i.email,
              active: true,
              expiresAt: i.expiresAt.toISOString(),
            })),
          ];
        });
        return c.json({ data }, 200);
      },
    );
};
