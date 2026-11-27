import type { Actor } from "@recpm/core";
import { can } from "@recpm/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import { AppError } from "./errors";

type Ctx = { var: AppEnv["Variables"]; req: { header: (n: string) => string | undefined } };

/** Quem age no request, no formato das regras do núcleo (@recpm/core). */
export const actorOf = (c: Ctx): Actor => {
  const t = c.var.tenant;
  return {
    tenantId: t.tenantId,
    userId: t.userId,
    name: c.var.session?.user.name ?? null,
    role: t.role,
    impersonatorId:
      (c.var.session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy ?? null,
    requestId: c.var.requestId,
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null,
    can: (p) => can(t.role, p),
  };
};

/** Rotas internas da equipe: o cliente usa o portal (rotas próprias, Fase 7). */
export const teamOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.tenant?.role === "cliente") throw new AppError(403, "FORBIDDEN", "Use o portal do cliente.");
  await next();
});
