import { OpenAPIHono } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { createAuth } from "./auth/auth";
import type { Deps } from "./deps";
import { AppError, errorBody } from "./lib/errors";
import { requireTrustedOrigin } from "./middleware/origin";
import { loadSession } from "./middleware/session";
import { meRoutes } from "./routes/me";
import { memberRoutes } from "./routes/members";
import { workspaceRoutes } from "./routes/workspaces";
import type { AppEnv } from "./types";

export const createApp = (deps: Deps) => {
  const auth = createAuth(deps);
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody("VALIDATION", "Dados inválidos.", { issues: result.error.issues }), 400);
      }
    },
  });

  app.use("*", requestId());
  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    const start = performance.now();
    c.set("auth", auth);
    await next();
    deps.logger.info(
      {
        requestId: c.var.requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      },
      "request",
    );
  });

  app.get("/health", async (c) => {
    const db = await deps.dbs.appDb.execute(sql`SELECT 1`).then(
      () => true,
      () => false,
    );
    const redis = deps.redis
      ? await deps.redis.ping().then(
          () => true,
          () => false,
        )
      : null;
    return c.json({ ok: db && redis !== false, db, redis }, db && redis !== false ? 200 : 503);
  });

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Rotas da aplicação (cookie de sessão) — CSRF por Origin em métodos que alteram estado.
  app.use("/api/v1/*", requireTrustedOrigin([deps.env.WEB_URL, deps.env.API_URL]));
  app.use("/api/v1/*", loadSession);

  const routes = app
    .route("/api/v1", meRoutes(deps))
    .route("/api/v1", workspaceRoutes(deps))
    .route("/api/v1", memberRoutes(deps));

  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Rec PM API", version: "0.1.0" },
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(errorBody(err.code, err.message), err.status);
    if (err instanceof HTTPException) return c.json(errorBody("HTTP_ERROR", err.message), err.status);
    deps.logger.error({ err, requestId: c.var.requestId }, "erro não tratado");
    return c.json(errorBody("INTERNAL", "Erro inesperado. Tente novamente."), 500);
  });
  app.notFound((c) => c.json(errorBody("NOT_FOUND", "Rota não encontrada."), 404));

  return Object.assign(routes, { auth });
};

export type App = ReturnType<typeof createApp>;
