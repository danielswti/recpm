import { serve } from "@hono/node-server";
import { createDbs } from "@recpm/db";
import { createApp } from "./app";
import { parseEnv } from "./env";
import { createLogger } from "./lib/logger";
import { createMailer } from "./lib/mailer";
import { createRedis } from "./lib/redis";
import { createNotificationDispatcher } from "./services/notification-dispatch";

const env = parseEnv();
const logger = createLogger(env.LOG_LEVEL);
const dbs = createDbs(process.env);
const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : undefined;
const mailer = createMailer({
  resendApiKey: env.RESEND_API_KEY,
  smtpUrl: env.SMTP_URL,
  from: env.EMAIL_FROM,
  production: env.NODE_ENV === "production",
});

const app = createApp({ env, dbs, redis, mailer, logger });
const stopDispatcher = createNotificationDispatcher(
  { env, dbs, redis, mailer, logger, live: app.live },
  app.push,
).start();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) =>
  logger.info(`API em http://localhost:${info.port}`),
);

const shutdown = () => {
  logger.info("encerrando…");
  stopDispatcher();
  server.close(() => {
    redis?.disconnect();
    void app.live.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
