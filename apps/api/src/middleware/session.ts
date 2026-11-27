import { createMiddleware } from "hono/factory";
import { AppError } from "../lib/errors";
import type { AppEnv } from "../types";

/** Carrega a sessão do Better Auth (cookie httpOnly) para todo request da API. */
export const loadSession = createMiddleware<AppEnv>(async (c, next) => {
  // a chave de API já montou a sessão (middleware api-key)
  if (c.var.apiKeyId) {
    await next();
    return;
  }
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  c.set("session", session);
  await next();
});

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.session) throw new AppError(401, "UNAUTHENTICATED", "Faça login para continuar.");
  await next();
});
