/**
 * Worker de jobs (BullMQ sobre Valkey). Mesmo código de domínio da API (@recpm/core), processo separado.
 *
 * Jobs agendados:
 *   billing-cycle  a cada 15 min: fim de trial, virada de ciclo das assinaturas sem provedor
 *                  (zera a cota, aplica downgrade/cancelamento agendado) e carência vencida → somente leitura.
 *   recurrence     a cada 5 min: gera as instâncias vencidas das tarefas recorrentes (cada uma consome
 *                  cota; com a cota esgotada a série espera o próximo ciclo).
 *   client-chase   a cada 10 min: cards em "aguardando cliente" além do SLA (horas úteis) avisam o
 *                  atendimento do projeto, uma vez por espera.
 *   deadline-reminders a cada 15 min: "prazo amanhã" (24 h antes) e "prazo vencido", uma vez por prazo.
 *   holidays       diário: importa os feriados nacionais do ano corrente e do próximo (BrasilAPI) para
 *                  os workspaces com a importação ligada.
 *   finance        a cada 3 h: gera as cobranças das mensalidades e marca parcelas vencidas como
 *                  atrasadas, avisando admin e gestores (idempotente; roda várias vezes ao dia por fuso).
 * (O envio de e-mail e push das notificações roda na API, que tem o mailer e as chaves VAPID.)
 */
import {
  brasilApiHolidays,
  runBillingCycle,
  runClientChaseSla,
  runDeadlineReminders,
  runFinanceDaily,
  runHolidayImport,
  runRecurrence,
} from "@recpm/core";
import { createDbs } from "@recpm/db";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";

const logger = pino({ name: "worker", level: process.env.LOG_LEVEL ?? "info" });
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL não configurada");

const dbs = createDbs(process.env);
const { platformDb } = dbs;
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const QUEUE = "billing";
const queue = new Queue(QUEUE, { connection });
await queue.upsertJobScheduler(
  "billing-cycle",
  { every: 15 * 60_000 },
  { name: "billing-cycle", opts: { removeOnComplete: 100, removeOnFail: 500 } },
);

await queue.upsertJobScheduler(
  "recurrence",
  { every: 5 * 60_000 },
  { name: "recurrence", opts: { removeOnComplete: 100, removeOnFail: 500 } },
);

await queue.upsertJobScheduler(
  "client-chase",
  { every: 10 * 60_000 },
  { name: "client-chase", opts: { removeOnComplete: 100, removeOnFail: 500 } },
);

await queue.upsertJobScheduler(
  "deadline-reminders",
  { every: 15 * 60_000 },
  { name: "deadline-reminders", opts: { removeOnComplete: 100, removeOnFail: 500 } },
);

await queue.upsertJobScheduler(
  "holidays",
  { pattern: "0 5 * * *" },
  { name: "holidays", opts: { removeOnComplete: 30, removeOnFail: 100 } },
);

await queue.upsertJobScheduler(
  "finance",
  { every: 3 * 60 * 60_000 },
  { name: "finance", opts: { removeOnComplete: 50, removeOnFail: 200 } },
);

const worker = new Worker(
  QUEUE,
  async (job) => {
    if (job.name === "billing-cycle") {
      const report = await runBillingCycle(platformDb);
      logger.info({ job: job.name, ...report }, "ciclo de cobrança");
      return report;
    }
    if (job.name === "recurrence") {
      if (!dbs.appDb) throw new Error("DATABASE_URL_APP não configurada");
      const report = await runRecurrence({ platformDb, appDb: dbs.appDb });
      if (report.created || report.blocked) logger.info({ job: job.name, ...report }, "recorrência");
      return report;
    }
    if (job.name === "client-chase") {
      const report = await runClientChaseSla({ platformDb, appDb: dbs.appDb });
      if (report.notified) logger.info({ job: job.name, ...report }, "SLA de cobrança");
      return report;
    }
    if (job.name === "deadline-reminders") {
      const report = await runDeadlineReminders({ platformDb, appDb: dbs.appDb });
      logger.info({ job: job.name, ...report }, "lembretes de prazo");
      return report;
    }
    if (job.name === "holidays") {
      const report = await runHolidayImport({ platformDb, appDb: dbs.appDb }, brasilApiHolidays(fetch));
      logger.info({ job: job.name, ...report }, "feriados");
      return report;
    }
    if (job.name === "finance") {
      const report = await runFinanceDaily({ platformDb, appDb: dbs.appDb });
      logger.info({ job: job.name, ...report }, "financeiro");
      return report;
    }
    logger.warn({ job: job.name }, "job desconhecido");
  },
  { connection, concurrency: 1 },
);
worker.on("failed", (job, err) => logger.error({ job: job?.name, err }, "job falhou"));
logger.info("worker pronto");

const shutdown = async () => {
  logger.info("encerrando…");
  await worker.close();
  await queue.close();
  connection.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
