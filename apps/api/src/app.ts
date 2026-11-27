import { OpenAPIHono } from "@hono/zod-openapi";
import { DomainError } from "@recpm/core";
import { schema } from "@recpm/db";
import { Scalar } from "@scalar/hono-api-reference";
import { or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { createAuth } from "./auth/auth";
import { createBillingProviders } from "./billing";
import type { Deps } from "./deps";
import { apiDescription } from "./lib/api-docs";
import { AppError, errorBody } from "./lib/errors";
import { createLiveHub } from "./lib/live";
import { createPushSender } from "./lib/push";
import { captureError } from "./lib/sentry";
import { apiKeyAuth } from "./middleware/api-key";
import { requireTrustedOrigin } from "./middleware/origin";
import { loadSession } from "./middleware/session";
import { billingRoutes } from "./routes/billing";
import { briefingRoutes } from "./routes/briefings";
import { calendarRoutes } from "./routes/calendar";
import { catalogRoutes } from "./routes/catalogs";
import { chatRoutes } from "./routes/chat";
import { clientRoutes } from "./routes/clients";
import { fileRoutes } from "./routes/files";
import { financeRoutes } from "./routes/finance";
import { integrationRoutes } from "./routes/integrations";
import { meRoutes } from "./routes/me";
import { memberRoutes } from "./routes/members";
import { notificationRoutes } from "./routes/notifications";
import { platformRoutes } from "./routes/platform";
import { portalRoutes } from "./routes/portal";
import { projectRoutes } from "./routes/projects";
import { publicPlanRoutes } from "./routes/public-plans";
import { reportRoutes } from "./routes/reports";
import { settingsRoutes } from "./routes/settings";
import { signatureRoutes } from "./routes/signatures";
import { taskRoutes } from "./routes/tasks";
import { timeRoutes } from "./routes/time";
import { webhookRoutes } from "./routes/webhooks";
import { workspaceRoutes } from "./routes/workspaces";
import type { AppEnv } from "./types";

export const createApp = (deps: Deps) => {
  const auth = createAuth(deps);
  const live = deps.live ?? createLiveHub(deps.env.DATABASE_URL_APP, deps.logger);
  const push = deps.push === undefined ? createPushSender(deps.env) : deps.push;
  const rt = { ...deps, live, push };
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

  const health = async (c: import("hono").Context<AppEnv>) => {
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
    c.header("Cache-Control", "no-store");
    return c.json({ ok: db && redis !== false, db, redis }, db && redis !== false ? 200 : 503);
  };
  // /health para o Docker (rede interna) e /api/v1/health para monitores externos (via Caddy)
  app.get("/health", health);
  app.get("/api/v1/health", health);

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  const billing =
    deps.billing ??
    createBillingProviders(deps.env, async (priceId) => {
      const [p] = await deps.dbs.platformDb
        .select({ id: schema.plans.id })
        .from(schema.plans)
        .where(
          or(
            sql`${schema.plans.stripePriceIds}->>'monthly' = ${priceId}`,
            sql`${schema.plans.stripePriceIds}->>'yearly' = ${priceId}`,
          ),
        );
      return p?.id ?? null;
    });
  app.route("/api/webhooks", webhookRoutes(deps, billing));

  // Rotas da aplicação (cookie de sessão) — CSRF por Origin em métodos que alteram estado.
  app.use("/api/v1/*", requireTrustedOrigin([deps.env.WEB_URL, deps.env.API_URL]));
  app.use("/api/v1/*", apiKeyAuth(deps));
  app.use("/api/v1/*", loadSession);

  const routes = app
    .route("/api/v1", meRoutes(deps))
    .route("/api/v1", workspaceRoutes(deps))
    .route("/api/v1", memberRoutes(deps))
    .route("/api/v1", billingRoutes(deps, billing))
    .route("/api/v1", platformRoutes(deps))
    .route("/api/v1", catalogRoutes(deps))
    .route("/api/v1", briefingRoutes(deps))
    .route("/api/v1", clientRoutes(deps))
    .route("/api/v1", projectRoutes(deps))
    .route("/api/v1", taskRoutes(deps))
    .route("/api/v1", timeRoutes(rt))
    .route("/api/v1", notificationRoutes(rt))
    .route("/api/v1", calendarRoutes(rt))
    .route("/api/v1", chatRoutes(rt))
    .route("/api/v1", financeRoutes(rt))
    .route("/api/v1", signatureRoutes(rt))
    .route("/api/v1", reportRoutes(rt))
    .route("/api/v1", settingsRoutes(deps))
    .route("/api/v1", integrationRoutes(deps))
    .route("/api/v1", portalRoutes(deps))
    .route("/api/v1", publicPlanRoutes(deps))
    .route("/api/v1", fileRoutes(deps));

  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "pk_live_…",
    description: "Chave de API criada em Configurações › Chaves de API.",
  });
  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Rec PM API", version: "1.0.0", description: apiDescription(deps.env.API_URL) },
    servers: [{ url: deps.env.API_URL }],
    security: [{ apiKey: [] }],
  });

  // Referência navegável da API (Scalar, carregada do CDN jsDelivr; o Caddy libera o CDN só nesta rota)
  app.get("/api/docs", Scalar({ url: "/api/openapi.json", pageTitle: "Rec PM API", hideClientButton: true }));

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(errorBody(err.code, err.message), err.status);
    if (err instanceof DomainError) return c.json(errorBody(err.code, err.message, err.details), err.status);
    if (err instanceof HTTPException) return c.json(errorBody("HTTP_ERROR", err.message), err.status);
    deps.logger.error({ err, requestId: c.var.requestId }, "erro não tratado");
    captureError(err, { requestId: c.var.requestId, route: c.req.routePath, method: c.req.method });
    if (process.env.DEBUG_ERRORS) console.error(err);
    return c.json(errorBody("INTERNAL", "Erro inesperado. Tente novamente."), 500);
  });
  app.notFound((c) => c.json(errorBody("NOT_FOUND", "Rota não encontrada."), 404));

  return Object.assign(routes, { auth, live, push });
};

export type App = ReturnType<typeof createApp>;
