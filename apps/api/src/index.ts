/**
 * Processo da API. Com API_WORKERS > 1 (produção: um por vCPU, menos um para o Postgres), o
 * processo principal só cria e reinicia os filhos (node:cluster), que dividem a porta. Os
 * despachantes de avisos, webhooks e exportações rodam em um filho só (RECPM_DISPATCH=1).
 */
import cluster from "node:cluster";
import { serve } from "@hono/node-server";
import { createDbs } from "@recpm/db";
import { createApp } from "./app";
import { parseEnv } from "./env";
import { createLogger } from "./lib/logger";
import { createMailer } from "./lib/mailer";
import { createRedis } from "./lib/redis";
import { flushSentry, initSentry } from "./lib/sentry";
import { createDataExporter } from "./services/data-export";
import { createNotificationDispatcher } from "./services/notification-dispatch";
import { createWebhookDispatcher } from "./services/webhook-dispatch";

const env = parseEnv();
const logger = createLogger(env.LOG_LEVEL);
const workers = Number(process.env.API_WORKERS ?? 1);

if (cluster.isPrimary && workers > 1) {
  const fork = (dispatch: boolean) =>
    cluster.fork({ RECPM_DISPATCH: dispatch ? "1" : "0" }).on("exit", (code, signal) => {
      if (stopping) return;
      logger.error({ code, signal }, "processo da API caiu; reiniciando");
      setTimeout(() => fork(dispatch), 1000);
    });
  let stopping = false;
  for (let i = 0; i < workers; i++) fork(i === 0);
  logger.info(`API com ${workers} processos`);
  const stop = () => {
    stopping = true;
    for (const w of Object.values(cluster.workers ?? {})) w?.process.kill("SIGTERM");
    setTimeout(() => process.exit(0), 10_000).unref();
    cluster.on("exit", () => {
      if (!Object.keys(cluster.workers ?? {}).length) process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  await startServer();
}

async function startServer() {
  if (initSentry(env.SENTRY_DSN, "api")) logger.info("Sentry ligado");
  const dbs = createDbs(process.env);
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : undefined;
  const mailer = createMailer({
    resendApiKey: env.RESEND_API_KEY,
    smtpUrl: env.SMTP_URL,
    from: env.EMAIL_FROM,
    production: env.NODE_ENV === "production",
  });

  const app = createApp({ env, dbs, redis, mailer, logger });
  const dispatch = process.env.RECPM_DISPATCH !== "0";
  const noop = () => {};
  const stopDispatcher = dispatch
    ? createNotificationDispatcher({ env, dbs, redis, mailer, logger, live: app.live }, app.push).start()
    : noop;
  const jobDeps = { env, dbs, redis, mailer, logger, live: app.live };
  const stopWebhooks = dispatch ? createWebhookDispatcher(jobDeps).start() : noop;
  const stopExports = dispatch ? createDataExporter(jobDeps).start() : noop;

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) =>
    logger.info(`API em http://localhost:${info.port}`),
  );

  const shutdown = () => {
    logger.info("encerrando…");
    stopDispatcher();
    stopWebhooks();
    stopExports();
    server.close(async () => {
      redis?.disconnect();
      void app.live.close();
      await flushSentry();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
