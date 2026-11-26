/**
 * Tarefas (cards do Kanban) e tudo que pendura nelas (§5 "Tasks", §6.3).
 * O histórico da tarefa (mudanças de status e de campos) vai para `audit_logs` com entity = 'task'.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, softDelete, tenantUnique, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { adjustmentReasons, kanbanColumns, tags, taskRoles, taskTypes } from "./catalogs";
import { adjustmentKind, priority, recurrence, taskSource } from "./enums";
import { files } from "./files";
import { projectPhases, projects, type RichText } from "./projects";
import { tenantId } from "./tenants";

export type RecurrenceRule = {
  /** A cada N dias/semanas/meses. */
  interval: number;
  /** semanal: dias da semana (0 = domingo). */
  weekdays?: number[];
  /** mensal: dia do mês (1–31; meses curtos usam o último dia). */
  dayOfMonth?: number;
  /** Hora local de criação "HH:mm" e fim opcional. */
  at?: string;
  until?: string;
  /** Deslocamento do prazo a partir da geração, em dias. */
  deadlineOffsetDays?: number;
};

export const tasks = pgTable(
  "tasks",
  {
    id: pk(),
    tenantId: tenantId(),
    /** Tarefa avulsa (sem projeto) é permitida. */
    projectId: uuid(),
    phaseId: uuid(),
    title: text().notNull(),
    description: jsonb().$type<RichText>(),
    descriptionText: text(),
    /** → kanban_columns(tenant_id, key) */
    statusKey: text().notNull(),
    statusSince: tstz().defaultNow().notNull(),
    /** Ordem dentro da coluna: chave fracionária (fractional-indexing), reordenar = 1 UPDATE. */
    rank: text().notNull(),
    /** Responsável principal. Todos os envolvidos (com função) ficam em task_assignees. */
    assigneeId: uuid().references(() => users.id, { onDelete: "set null" }),
    mainRoleId: uuid(),
    taskTypeId: uuid(),
    approverId: uuid().references(() => users.id, { onDelete: "set null" }),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    source: taskSource().notNull().default("ui"),
    driveLink: text(),

    // Prazos
    deadline: tstz(),
    /** Prazo original, preservado para medir atrasos quando o prazo é remarcado. */
    originalDeadline: tstz(),
    deadlineHasTime: boolean().notNull().default(false),
    clientDeliveryDate: date(),
    completedAt: tstz(),

    priority: priority().notNull().default("media"),
    visibleToClient: boolean().notNull().default(false),
    estimatedHours: numeric({ precision: 6, scale: 2, mode: "number" }),
    pieceQuantity: integer().notNull().default(1),

    // Recorrência (o job do BullMQ gera a próxima instância em nextGenerationAt)
    recurrence: recurrence(),
    recurrenceRule: jsonb().$type<RecurrenceRule>(),
    recurrenceParentId: uuid(),
    nextGenerationAt: tstz(),

    // Arquivamento (funcionario solicita; gestor aprova)
    archived: boolean().notNull().default(false),
    archivedAt: tstz(),
    archivedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    archiveRequestBy: uuid().references(() => users.id, { onDelete: "set null" }),
    archiveRequestReason: text(),
    archiveRequestAt: tstz(),

    // SLA de cobrança do cliente (coluna aguardando_cliente)
    lastClientChaseAt: tstz(),
    chaseSlaNotifiedAt: tstz(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    tenantUnique("tasks_tenant_id_uq", t),
    tfk("tasks_project_fk", t, t.projectId, projects),
    tfk("tasks_phase_fk", t, t.phaseId, projectPhases),
    tfk("tasks_main_role_fk", t, t.mainRoleId, taskRoles),
    tfk("tasks_type_fk", t, t.taskTypeId, taskTypes),
    tfk("tasks_recurrence_parent_fk", t, t.recurrenceParentId, t),
    foreignKey({
      name: "tasks_status_fk",
      columns: [t.tenantId, t.statusKey],
      foreignColumns: [kanbanColumns.tenantId, kanbanColumns.key],
    }),
    // Índices exigidos na §8 (parciais: só tarefas vivas)
    index("tasks_status_deadline_idx")
      .on(t.tenantId, t.statusKey, t.deadline)
      .where(sql`${t.deletedAt} IS NULL AND NOT ${t.archived}`),
    index("tasks_project_idx").on(t.tenantId, t.projectId),
    index("tasks_assignee_idx").on(t.tenantId, t.assigneeId),
    // Kanban: cards de uma coluna em ordem
    index("tasks_board_idx")
      .on(t.tenantId, t.projectId, t.statusKey, t.rank)
      .where(sql`${t.deletedAt} IS NULL AND NOT ${t.archived}`),
    index("tasks_approver_idx").on(t.tenantId, t.approverId),
    index("tasks_recurrence_due_idx")
      .on(t.nextGenerationAt)
      .where(sql`${t.recurrence} IS NOT NULL AND ${t.deletedAt} IS NULL AND NOT ${t.archived}`),
    index("tasks_completed_idx").on(t.tenantId, t.completedAt),
    index("tasks_archive_requests_idx")
      .on(t.tenantId, t.archiveRequestAt)
      .where(sql`${t.archiveRequestAt} IS NOT NULL AND NOT ${t.archived}`),
    check("tasks_piece_quantity_positive", sql`${t.pieceQuantity} >= 0`),
    check("tasks_recurrence_has_rule", sql`(${t.recurrence} IS NULL) = (${t.recurrenceRule} IS NULL)`),
  ],
);

/** Várias pessoas por tarefa, cada uma com uma função (editor, designer…). */
export const taskAssignees = pgTable(
  "task_assignees",
  {
    tenantId: tenantId(),
    taskId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "task_assignees_pk", columns: [t.taskId, t.userId] }),
    tfk("task_assignees_task_fk", t, t.taskId, tasks).onDelete("cascade"),
    tfk("task_assignees_role_fk", t, t.roleId, taskRoles),
    index("task_assignees_user_idx").on(t.tenantId, t.userId),
  ],
);

export const taskTags = pgTable(
  "task_tags",
  {
    tenantId: tenantId(),
    taskId: uuid().notNull(),
    tagId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ name: "task_tags_pk", columns: [t.taskId, t.tagId] }),
    tfk("task_tags_task_fk", t, t.taskId, tasks).onDelete("cascade"),
    tfk("task_tags_tag_fk", t, t.tagId, tags).onDelete("cascade"),
    index("task_tags_tag_idx").on(t.tenantId, t.tagId),
  ],
);

/** Checklist da tarefa (NÃO conta na cota do plano). */
export const taskSubitems = pgTable(
  "task_subitems",
  {
    id: pk(),
    tenantId: tenantId(),
    taskId: uuid().notNull(),
    text: text().notNull(),
    done: boolean().notNull().default(false),
    doneAt: tstz(),
    doneBy: uuid().references(() => users.id, { onDelete: "set null" }),
    position: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    tfk("task_subitems_task_fk", t, t.taskId, tasks).onDelete("cascade"),
    index("task_subitems_task_idx").on(t.tenantId, t.taskId, t.position),
  ],
);

export const taskAttachments = pgTable(
  "task_attachments",
  {
    id: pk(),
    tenantId: tenantId(),
    taskId: uuid().notNull(),
    fileId: uuid(),
    url: text(),
    name: text().notNull(),
    visibleToClient: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    ...softDelete,
  },
  (t) => [
    tfk("task_attachments_task_fk", t, t.taskId, tasks).onDelete("cascade"),
    tfk("task_attachments_file_fk", t, t.fileId, files),
    index("task_attachments_task_idx").on(t.tenantId, t.taskId),
    check("task_attachments_file_xor_url", sql`(${t.fileId} IS NULL) <> (${t.url} IS NULL)`),
  ],
);

/** Thread de comentários/feedback da tarefa. O cliente vê e responde só os `visibleToClient`. */
export const taskFeedback = pgTable(
  "task_feedback",
  {
    id: pk(),
    tenantId: tenantId(),
    taskId: uuid().notNull(),
    authorId: uuid().references(() => users.id, { onDelete: "set null" }),
    body: jsonb().$type<RichText>().notNull(),
    bodyText: text().notNull(),
    visibleToClient: boolean().notNull().default(false),
    editedAt: tstz(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    tfk("task_feedback_task_fk", t, t.taskId, tasks).onDelete("cascade"),
    index("task_feedback_task_idx").on(t.tenantId, t.taskId, t.createdAt),
  ],
);

/** Ajustes (retrabalho): motivo obrigatório + classificação interno/cliente. */
export const taskAdjustments = pgTable(
  "task_adjustments",
  {
    id: pk(),
    tenantId: tenantId(),
    taskId: uuid().notNull(),
    reasonId: uuid().notNull(),
    kind: adjustmentKind().notNull(),
    description: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Responsável pela peça no momento do ajuste (relatório "ajustes por pessoa"). */
    responsibleId: uuid().references(() => users.id, { onDelete: "set null" }),
    resolvedAt: tstz(),
    resolvedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    tfk("task_adjustments_task_fk", t, t.taskId, tasks).onDelete("cascade"),
    tfk("task_adjustments_reason_fk", t, t.reasonId, adjustmentReasons),
    index("task_adjustments_task_idx").on(t.tenantId, t.taskId),
    index("task_adjustments_report_idx").on(t.tenantId, t.createdAt, t.kind),
  ],
);

/**
 * Botão "Concluído": registra peças entregues ao longo do tempo, independente da coluna final.
 * Fonte ÚNICA de "peças entregues" para todos os relatórios (critério de reconciliação da §9).
 */
export const taskDeliveries = pgTable(
  "task_deliveries",
  {
    id: pk(),
    tenantId: tenantId(),
    taskId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    quantity: integer().notNull(),
    deliveredAt: tstz().defaultNow().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    tfk("task_deliveries_task_fk", t, t.taskId, tasks).onDelete("cascade"),
    index("task_deliveries_period_idx").on(t.tenantId, t.deliveredAt),
    index("task_deliveries_user_idx").on(t.tenantId, t.userId, t.deliveredAt),
    index("task_deliveries_task_idx").on(t.tenantId, t.taskId),
    check("task_deliveries_quantity_positive", sql`${t.quantity} > 0`),
  ],
);
