import { createMiddleware } from "hono/factory";
import { AppError } from "../lib/errors";
import type { AppEnv } from "../types";

/** Back-office: só super_admin (users.role), e nunca dentro de uma sessão personificada. */
export const requireSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const s = c.var.session;
  if (!s) throw new AppError(401, "UNAUTHENTICATED", "Faça login para continuar.");
  const role = (s.user as { role?: string }).role;
  if (role !== "super_admin" || (s.session as { impersonatedBy?: string | null }).impersonatedBy)
    throw new AppError(403, "FORBIDDEN", "Acesso restrito à plataforma.");
  await next();
});
