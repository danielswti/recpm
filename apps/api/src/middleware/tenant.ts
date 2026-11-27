/**
 * Resolve o tenant ativo da sessão, confere o vínculo (membership ativa) e expõe `c.var.tenant`
 * com `tx()` — a transação com o contexto RLS (tenant, usuário e, no portal, o cliente).
 */
import { schema, type TenantContext, withTenant } from "@recpm/db";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Dbs } from "../deps";
import { AppError } from "../lib/errors";
import type { AppEnv } from "../types";

export const requireTenant = (dbs: Dbs) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const session = c.var.session;
    if (!session) throw new AppError(401, "UNAUTHENTICATED", "Faça login para continuar.");
    const tenantId = session.session.activeOrganizationId;
    if (!tenantId) throw new AppError(409, "NO_ACTIVE_TENANT", "Escolha um workspace.");
    const userId = session.user.id;

    const found = await withTenant(dbs.appDb, { tenantId, userId }, async (tx) => {
      // uma consulta só (roda em todo pedido): vínculo + situação do tenant
      const [row] = await tx
        .select({
          role: schema.memberships.role,
          clientId: schema.memberships.clientId,
          active: schema.memberships.active,
          status: schema.tenants.status,
        })
        .from(schema.memberships)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
        .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.userId, userId)));
      return { m: row, t: row && { status: row.status } };
    });
    if (!found.m?.active) throw new AppError(403, "NOT_A_MEMBER", "Você não faz parte deste workspace.");
    if (found.t?.status === "suspended") throw new AppError(403, "TENANT_SUSPENDED", "Workspace suspenso.");
    // Somente leitura (pagamento em atraso após a carência): leitura liberada, escrita só na cobrança.
    if (
      found.t?.status === "read_only" &&
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      !c.req.path.startsWith("/api/v1/billing") &&
      // exportar os dados e excluir o workspace (LGPD) seguem liberados
      !c.req.path.startsWith("/api/v1/exports") &&
      !(c.req.method === "DELETE" && c.req.path === "/api/v1/workspace")
    )
      throw new AppError(
        403,
        "TENANT_READ_ONLY",
        "Workspace em modo somente leitura. Regularize a assinatura.",
      );

    const context: TenantContext = {
      tenantId,
      userId,
      clientId: found.m.role === "cliente" ? (found.m.clientId ?? undefined) : undefined,
    };
    c.set("tenant", {
      tenantId,
      userId,
      role: found.m.role,
      clientId: found.m.clientId,
      status: found.t?.status ?? "active",
      context,
      tx: (fn) => withTenant(dbs.appDb, context, fn),
    });
    await next();
  });
