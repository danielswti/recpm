import { can, type Permission } from "@recpm/shared";
import { createMiddleware } from "hono/factory";
import { AppError } from "../lib/errors";
import type { AppEnv } from "../types";

/** Exige uma permissão do mapa central (packages/shared/permissions). Use depois de requireTenant. */
export const requirePermission = (permission: Permission) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!can(c.var.tenant?.role, permission)) {
      throw new AppError(403, "FORBIDDEN", "Você não tem permissão para esta ação.");
    }
    c.set("permission", permission);
    await next();
  });
