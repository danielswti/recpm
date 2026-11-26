/**
 * Projetos e tudo que pendura neles (§5 "Projects", §6.2).
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
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { cents, createdAt, pk, softDelete, tenantUnique, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { kanbanColumns, projectTags, projectTypes, taskRoles, taskTypes } from "./catalogs";
import { clients } from "./clients";
import { priority, projectModality, projectPeriodicity, projectStatus } from "./enums";
import { files } from "./files";
import { tenantId } from "./tenants";

/** Conteúdo TipTap (ProseMirror JSON). Sempre acompanhado de uma versão texto para busca. */
export type RichText = { type: "doc"; content?: unknown[] };

export const projects = pgTable(
  "projects",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text().notNull(),
    /** NULL só para projetos internos. */
    clientId: uuid(),
    internal: boolean().notNull().default(false),
    modality: projectModality().notNull(),
    periodicity: projectPeriodicity(),
    typeId: uuid(),
    photoFileId: uuid(),
    status: projectStatus().notNull().default("planejamento"),
    waitingClient: boolean().notNull().default(false),
    priority: priority().notNull().default("media"),

    // Datas do contrato/cronograma (datas de calendário, sem hora)
    startDate: date(),
    deliveryDeadline: date(),
    clientDeliveryDate: date(),
    signedAt: date(),
    devTimeDays: integer(),
    contractEnd: date(),
    contractIndefinite: boolean().notNull().default(false),
    deadlineText: text(),
    firstDeliveryDate: date(),
    feedbackDeadline: date(),
    feedbackReceivedAt: tstz(),
    supportStart: date(),
    supportEnd: date(),

    // Valores (centavos)
    valueCents: cents(),
    recurringValueCents: cents(),
    extraCostCents: cents(),
    extraCostDescription: text(),

    /** Atendente / gerente de conta. */
    managerId: uuid().references(() => users.id, { onDelete: "set null" }),
    description: jsonb().$type<RichText>(),
    descriptionText: text(),
    /** Resumo exibido no portal do cliente. */
    publicSummary: text(),
    notes: text(),
    /** Projeto de origem quando duplicado (ciclos mensais "Cliente | Mensal | Dez26"). */
    duplicatedFromId: uuid(),
    archived: boolean().notNull().default(false),
    archivedAt: tstz(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    tenantUnique("projects_tenant_id_uq", t),
    tfk("projects_client_fk", t, t.clientId, clients),
    tfk("projects_type_fk", t, t.typeId, projectTypes),
    tfk("projects_photo_fk", t, t.photoFileId, files),
    tfk("projects_duplicated_from_fk", t, t.duplicatedFromId, t),
    index("projects_list_idx")
      .on(t.tenantId, t.status, t.deliveryDeadline)
      .where(sql`${t.deletedAt} IS NULL AND NOT ${t.archived}`),
    index("projects_client_idx").on(t.tenantId, t.clientId),
    index("projects_manager_idx").on(t.tenantId, t.managerId),
    check("projects_client_unless_internal", sql`${t.internal} OR ${t.clientId} IS NOT NULL`),
    check("projects_periodicity_if_monthly", sql`${t.modality} = 'mensal' OR ${t.periodicity} IS NULL`),
  ],
);

/** Quem participa do projeto (funcionario só enxerga projetos em que é membro). */
export const projectMembers = pgTable(
  "project_members",
  {
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "project_members_pk", columns: [t.projectId, t.userId] }),
    tfk("project_members_project_fk", t, t.projectId, projects).onDelete("cascade"),
    tfk("project_members_role_fk", t, t.roleId, taskRoles),
    index("project_members_user_idx").on(t.tenantId, t.userId),
  ],
);

export const projectTagLinks = pgTable(
  "project_tag_links",
  {
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    projectTagId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ name: "project_tag_links_pk", columns: [t.projectId, t.projectTagId] }),
    tfk("project_tag_links_project_fk", t, t.projectId, projects).onDelete("cascade"),
    tfk("project_tag_links_tag_fk", t, t.projectTagId, projectTags).onDelete("cascade"),
    index("project_tag_links_tag_idx").on(t.tenantId, t.projectTagId),
  ],
);

/** O que foi vendido: ex. 11× Edição, 100× Fotos por período. Base do "Contratado × Entregue". */
export const projectContractItems = pgTable(
  "project_contract_items",
  {
    id: pk(),
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    taskTypeId: uuid().notNull(),
    quantityPerPeriod: integer().notNull(),
    /** Ex.: ["Vertical", "Horizontal"]. */
    formats: text().array().notNull().default(sql`'{}'::text[]`),
    position: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    tfk("project_contract_items_project_fk", t, t.projectId, projects).onDelete("cascade"),
    tfk("project_contract_items_type_fk", t, t.taskTypeId, taskTypes),
    index("project_contract_items_project_idx").on(t.tenantId, t.projectId),
    check("project_contract_items_qty_positive", sql`${t.quantityPerPeriod} > 0`),
  ],
);

/** Fases (barra de progresso por fase). Tarefas podem apontar para uma fase. */
export const projectPhases = pgTable(
  "project_phases",
  {
    id: pk(),
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    startDate: date(),
    endDate: date(),
    completedAt: tstz(),
    position: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    tenantUnique("project_phases_tenant_id_uq", t),
    tfk("project_phases_project_fk", t, t.projectId, projects).onDelete("cascade"),
    index("project_phases_project_idx").on(t.tenantId, t.projectId, t.position),
  ],
);

/**
 * Marcos personalizados. Os marcos "padrão" (início, 1ª entrega, prazo de feedback, validado,
 * entrega final, início/fim do suporte) são virtuais: derivados das colunas de `projects`.
 */
export const projectMilestones = pgTable(
  "project_milestones",
  {
    id: pk(),
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    title: text().notNull(),
    date: date().notNull(),
    completedAt: tstz(),
    visibleToClient: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    tfk("project_milestones_project_fk", t, t.projectId, projects).onDelete("cascade"),
    index("project_milestones_date_idx").on(t.tenantId, t.date),
  ],
);

export const projectFolders = pgTable(
  "project_folders",
  {
    id: pk(),
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    parentId: uuid(),
    name: text().notNull(),
    visibleToClient: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    tenantUnique("project_folders_tenant_id_uq", t),
    tfk("project_folders_project_fk", t, t.projectId, projects).onDelete("cascade"),
    tfk("project_folders_parent_fk", t, t.parentId, t).onDelete("cascade"),
    index("project_folders_project_idx").on(t.tenantId, t.projectId),
  ],
);

/** Arquivo enviado (fileId) OU link externo (url) dentro da aba Arquivos. */
export const projectAttachments = pgTable(
  "project_attachments",
  {
    id: pk(),
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    folderId: uuid(),
    fileId: uuid(),
    url: text(),
    name: text().notNull(),
    visibleToClient: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    ...softDelete,
  },
  (t) => [
    tfk("project_attachments_project_fk", t, t.projectId, projects).onDelete("cascade"),
    tfk("project_attachments_folder_fk", t, t.folderId, projectFolders).onDelete("cascade"),
    tfk("project_attachments_file_fk", t, t.fileId, files),
    index("project_attachments_project_idx").on(t.tenantId, t.projectId, t.folderId),
    check("project_attachments_file_xor_url", sql`(${t.fileId} IS NULL) <> (${t.url} IS NULL)`),
  ],
);

export const projectComments = pgTable(
  "project_comments",
  {
    id: pk(),
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    authorId: uuid().references(() => users.id, { onDelete: "set null" }),
    body: jsonb().$type<RichText>().notNull(),
    bodyText: text().notNull(),
    visibleToClient: boolean().notNull().default(false),
    editedAt: tstz(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    tfk("project_comments_project_fk", t, t.projectId, projects).onDelete("cascade"),
    index("project_comments_project_idx").on(t.tenantId, t.projectId, t.createdAt),
  ],
);

/** Personalização das colunas do Kanban por projeto (visibilidade, rótulo, ordem). */
export const projectKanbanColumns = pgTable(
  "project_kanban_columns",
  {
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    columnKey: text().notNull(),
    visible: boolean().notNull().default(true),
    labelOverride: text(),
    position: integer(),
  },
  (t) => [
    primaryKey({ name: "project_kanban_columns_pk", columns: [t.projectId, t.columnKey] }),
    tfk("project_kanban_columns_project_fk", t, t.projectId, projects).onDelete("cascade"),
    foreignKey({
      name: "project_kanban_columns_column_fk",
      columns: [t.tenantId, t.columnKey],
      foreignColumns: [kanbanColumns.tenantId, kanbanColumns.key],
    }).onDelete("cascade"),
  ],
);
