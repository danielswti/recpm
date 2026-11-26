/**
 * Formulários de briefing (construtor no admin, preenchidos pela equipe ou pelo cliente no portal).
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, softDelete, tenantUnique, tfk, timestamps } from "./_columns";
import { users } from "./auth";
import { projectTypes, taskTypes } from "./catalogs";
import { clients } from "./clients";
import { briefingFieldType } from "./enums";
import { projects } from "./projects";
import { tasks } from "./tasks";
import { tenantId } from "./tenants";

export const briefingForms = pgTable(
  "briefing_forms",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text().notNull(),
    description: text(),
    /** Sugere o formulário para este tipo de tarefa e/ou tipo de projeto. */
    taskTypeId: uuid(),
    projectTypeId: uuid(),
    active: boolean().notNull().default(true),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    tenantUnique("briefing_forms_tenant_id_uq", t),
    tfk("briefing_forms_task_type_fk", t, t.taskTypeId, taskTypes),
    tfk("briefing_forms_project_type_fk", t, t.projectTypeId, projectTypes),
  ],
);

export const briefingFields = pgTable(
  "briefing_fields",
  {
    id: pk(),
    tenantId: tenantId(),
    formId: uuid().notNull(),
    label: text().notNull(),
    type: briefingFieldType().notNull(),
    /** Opções para escolha_unica / caixas. */
    options: text().array().notNull().default(sql`'{}'::text[]`),
    allowOther: boolean().notNull().default(false),
    required: boolean().notNull().default(false),
    help: text(),
    position: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    tenantUnique("briefing_fields_tenant_id_uq", t),
    tfk("briefing_fields_form_fk", t, t.formId, briefingForms).onDelete("cascade"),
    index("briefing_fields_form_idx").on(t.tenantId, t.formId, t.position),
  ],
);

/**
 * Resposta. `answers` guarda { [fieldId]: string | string[] } e `snapshot` congela
 * rótulos/tipos dos campos no momento do envio (o formulário pode mudar depois).
 */
export const briefingResponses = pgTable(
  "briefing_responses",
  {
    id: pk(),
    tenantId: tenantId(),
    formId: uuid().notNull(),
    clientId: uuid(),
    projectId: uuid(),
    taskId: uuid(),
    respondentId: uuid().references(() => users.id, { onDelete: "set null" }),
    answers: jsonb().$type<Record<string, string | string[]>>().notNull(),
    snapshot: jsonb()
      .$type<{ id: string; label: string; type: string; options: string[] }[]>()
      .notNull(),
    submittedAt: createdAt(),
  },
  (t) => [
    tenantUnique("briefing_responses_tenant_id_uq", t),
    tfk("briefing_responses_form_fk", t, t.formId, briefingForms),
    tfk("briefing_responses_client_fk", t, t.clientId, clients),
    tfk("briefing_responses_project_fk", t, t.projectId, projects),
    tfk("briefing_responses_task_fk", t, t.taskId, tasks),
    index("briefing_responses_task_idx").on(t.tenantId, t.taskId),
    index("briefing_responses_client_idx").on(t.tenantId, t.clientId),
    check("briefing_responses_has_subject", sql`num_nonnulls(${t.clientId}, ${t.projectId}, ${t.taskId}) > 0`),
  ],
);
