/**
 * Webhooks de saída (plano Business+) e exportações de dados do tenant (§6.13, §6.14).
 */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, tenantUnique, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { exportTrigger, jobStatus } from "./enums";
import { files } from "./files";
import { tenantId } from "./tenants";

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: pk(),
    tenantId: tenantId(),
    url: text().notNull(),
    /** Segredo HMAC, criptografado (AES-256-GCM). Exibido uma vez na criação. */
    secretEnc: text().notNull(),
    /** task.created, task.status_changed, task.completed, project.created, installment.paid */
    events: text().array().notNull(),
    active: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [tenantUnique("webhook_endpoints_tenant_id_uq", t)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: pk(),
    tenantId: tenantId(),
    endpointId: uuid().notNull(),
    event: text().notNull(),
    payload: jsonb().notNull(),
    status: jobStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: tstz(),
    responseStatus: integer(),
    lastError: text(),
    createdAt: createdAt(),
    deliveredAt: tstz(),
  },
  (t) => [
    tfk("webhook_deliveries_endpoint_fk", t, t.endpointId, webhookEndpoints).onDelete("cascade"),
    index("webhook_deliveries_endpoint_idx").on(t.tenantId, t.endpointId, t.createdAt.desc()),
    index("webhook_deliveries_retry_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('pending', 'failed') AND ${t.nextAttemptAt} IS NOT NULL`),
  ],
);

export const dataExports = pgTable(
  "data_exports",
  {
    id: pk(),
    tenantId: tenantId(),
    trigger: exportTrigger().notNull(),
    format: text().notNull().default("json"),
    status: jobStatus().notNull().default("pending"),
    fileId: uuid(),
    requestedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    startedAt: tstz(),
    finishedAt: tstz(),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [
    tfk("data_exports_file_fk", t, t.fileId, files),
    index("data_exports_tenant_idx").on(t.tenantId, t.createdAt.desc()),
  ],
);
