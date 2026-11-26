/**
 * Controle de tempo ("Estou nessa"), ajustes de tempo e presença (§5, §6.3, §6.8).
 *
 * "Tarefa atual" do usuário (spec: User.currentTaskId/currentTaskSince) é DERIVADA da entrada
 * de tempo aberta — não guardamos uma cópia que pode divergir. O índice único parcial abaixo
 * garante no banco a regra "uma tarefa ativa por pessoa", mesmo com dois cliques simultâneos.
 */
import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pk, tenantUnique, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { reviewStatus } from "./enums";
import { tasks } from "./tasks";
import { tenantId } from "./tenants";

export const timeEntries = pgTable(
  "time_entries",
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    taskId: uuid().notNull(),
    startedAt: tstz().notNull(),
    /** NULL = timer rodando. */
    endedAt: tstz(),
    /** Só horas úteis (agenda do membro, fuso, feriados). Calculado ao fechar a entrada. */
    businessMs: bigint({ mode: "number" }),
    /** Coluna em que a tarefa estava ao iniciar (tempo em `ajustes` = retrabalho). */
    statusAtStart: text().notNull(),
    ...timestamps,
  },
  (t) => [
    tenantUnique("time_entries_tenant_id_uq", t),
    tfk("time_entries_task_fk", t, t.taskId, tasks),
    uniqueIndex("time_entries_one_running_uq")
      .on(t.tenantId, t.userId)
      .where(sql`${t.endedAt} IS NULL`),
    index("time_entries_user_period_idx").on(t.tenantId, t.userId, t.startedAt),
    index("time_entries_task_idx").on(t.tenantId, t.taskId),
    check(
      "time_entries_range",
      sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`,
    ),
  ],
);

/** Pedido de ajuste de tempo: só conta nos relatórios depois de aprovado. */
export const timeAdjustmentRequests = pgTable(
  "time_adjustment_requests",
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    taskId: uuid().notNull(),
    /** Ajuste de uma entrada existente (novo intervalo) OU acréscimo/desconto (deltaMs). */
    timeEntryId: uuid(),
    deltaMs: bigint({ mode: "number" }),
    newStartedAt: tstz(),
    newEndedAt: tstz(),
    reason: text().notNull(),
    status: reviewStatus().notNull().default("pending"),
    reviewerId: uuid().references(() => users.id, { onDelete: "set null" }),
    reviewedAt: tstz(),
    reviewNote: text(),
    ...timestamps,
  },
  (t) => [
    tfk("time_adjustment_requests_task_fk", t, t.taskId, tasks),
    tfk("time_adjustment_requests_entry_fk", t, t.timeEntryId, timeEntries),
    index("time_adjustment_requests_queue_idx")
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      "time_adjustment_requests_shape",
      sql`(${t.deltaMs} IS NOT NULL) <> (${t.newStartedAt} IS NOT NULL AND ${t.newEndedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Presença. A fonte "quente" é o Valkey (TTL); esta tabela é gravada com throttle
 * (no máx. 1×/min por usuário) para "visto por último" e histórico.
 */
export const presence = pgTable(
  "presence",
  {
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastSeenAt: tstz().notNull(),
  },
  (t) => [primaryKey({ name: "presence_pk", columns: [t.tenantId, t.userId] })],
);
