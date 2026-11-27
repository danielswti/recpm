/**
 * Worker de jobs (BullMQ sobre Valkey). Mesmo código de domínio da API (@recpm/core), processo separado.
 *
 * Jobs agendados:
 *   billing-cycle  a cada 15 min: fim de trial, virada de ciclo das assinaturas sem provedor
 *                  (zera a cota, aplica downgrade/cancelamento agendado) e carência vencida → somente leitura.
 * As próximas fases acrescentam aqui: recorrência de tarefas, e-mails, notificações, backups.
 */
import { runBillingCycle } from "@recpm/core";
import { createDbs } from "@recpm/db";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";

const logger = pino({ name: "worker", level: process.env.LOG_LEVEL ?? "info" });
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL não configurada");

const { platformDb } = createDbs(process.env);
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const QUEUE = "billing";
const queue = new Queue(QUEUE, { connection });
await queue.upsertJobScheduler(
  "billing-cycle",
  { every: 15 * 60_000 },
  { name: "billing-cycle", opts: { removeOnComplete: 100, removeOnFail: 500 } },
);

const worker = new Worker(
  QUEUE,
  async (job) => {
    if (job.name === "billing-cycle") {
      const report = await runBillingCycle(platformDb);
      logger.info({ job: job.name, ...report }, "ciclo de cobrança");
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
