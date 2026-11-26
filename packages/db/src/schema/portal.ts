/**
 * Demandas abertas pelo cliente no portal (§6.11). Ao ser aceita, vira tarefa na coluna
 * `demandas` (source = 'portal_demand') e conta na cota do plano — a cota é consumida no aceite,
 * não na abertura.
 */
import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { pk, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { briefingResponses } from "./briefings";
import { clients } from "./clients";
import { demandStatus } from "./enums";
import { projects } from "./projects";
import { tasks } from "./tasks";
import { tenantId } from "./tenants";

export const demandRequests = pgTable(
  "demand_requests",
  {
    id: pk(),
    tenantId: tenantId(),
    clientId: uuid().notNull(),
    projectId: uuid(),
    requestedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    title: text().notNull(),
    description: text(),
    desiredDate: tstz(),
    briefingResponseId: uuid(),
    status: demandStatus().notNull().default("pending"),
    taskId: uuid(),
    reviewedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    reviewedAt: tstz(),
    rejectionReason: text(),
    ...timestamps,
  },
  (t) => [
    tfk("demand_requests_client_fk", t, t.clientId, clients),
    tfk("demand_requests_project_fk", t, t.projectId, projects),
    tfk("demand_requests_briefing_fk", t, t.briefingResponseId, briefingResponses),
    tfk("demand_requests_task_fk", t, t.taskId, tasks),
    index("demand_requests_queue_idx").on(t.tenantId, t.status, t.createdAt),
    index("demand_requests_client_idx").on(t.tenantId, t.clientId),
  ],
);
