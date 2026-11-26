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
      const [m] = await tx
        .select({
          role: schema.memberships.role,
          clientId: schema.memberships.clientId,
          active: schema.memberships.active,
        })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.userId, userId)));
      const [t] = await tx.select({ status: schema.tenants.status }).from(schema.tenants);
      return { m, t };
    });
    if (!found.m?.active) throw new AppError(403, "NOT_A_MEMBER", "Você não faz parte deste workspace.");
    if (found.t?.status === "suspended") throw new AppError(403, "TENANT_SUSPENDED", "Workspace suspenso.");

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
      context,
      tx: (fn) => withTenant(dbs.appDb, context, fn),
    });
    await next();
  });
