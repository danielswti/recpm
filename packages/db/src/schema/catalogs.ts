/**
 * Catálogos configuráveis pelo admin do tenant (§5 "Catalogs", §6.12).
 * Todos têm cor/ícone/posição/ativo e são semeados com os padrões no cadastro do tenant.
 * Itens de catálogo nunca são apagados se estiverem em uso: são desativados (`active = false`).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { catalogColumns, pk, tenantUnique, tfk, timestamps } from "./_columns";
import { reportCategory } from "./enums";
import { tenantId } from "./tenants";

/** Ex.: Avulso, Mensal, Evento, Clipe. */
export const projectTypes = pgTable(
  "project_types",
  {
    id: pk(),
    tenantId: tenantId(),
    slug: text().notNull(),
    label: text().notNull(),
    ...catalogColumns,
    ...timestamps,
  },
  (t) => [
    tenantUnique("project_types_tenant_id_uq", t),
    uniqueIndex("project_types_tenant_slug_uq").on(t.tenantId, t.slug),
  ],
);

/** Ex.: Arte digital, Capa, Captação, Edição, Filme, Fotos, Identidade visual… */
export const taskTypes = pgTable(
  "task_types",
  {
    id: pk(),
    tenantId: tenantId(),
    slug: text().notNull(),
    label: text().notNull(),
    defaultEstimatedHours: numeric({ precision: 6, scale: 2, mode: "number" }),
    /** Pode ser vendido como item de contrato (project_contract_items). */
    sellable: boolean().notNull().default(true),
    /** Aparece como opção de "tipo" ao criar tarefa. */
    usableAsType: boolean().notNull().default(true),
    /** NULL = "Outros" nos relatórios. */
    reportCategory: reportCategory(),
    /** Entregas deste tipo contam como "peças" (produtividade, contratado × entregue). */
    countsAsPiece: boolean().notNull().default(true),
    ...catalogColumns,
    ...timestamps,
  },
  (t) => [
    tenantUnique("task_types_tenant_id_uq", t),
    uniqueIndex("task_types_tenant_slug_uq").on(t.tenantId, t.slug),
  ],
);

/** Modelo de checklist copiado para task_subitems quando o tipo é aplicado à tarefa. */
export const taskTypeChecklistItems = pgTable(
  "task_type_checklist_items",
  {
    id: pk(),
    tenantId: tenantId(),
    taskTypeId: uuid().notNull(),
    text: text().notNull(),
    position: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    tfk("task_type_checklist_items_type_fk", t, t.taskTypeId, taskTypes).onDelete("cascade"),
    index("task_type_checklist_items_type_idx").on(t.tenantId, t.taskTypeId, t.position),
  ],
);

/**
 * Colunas do Kanban de tarefas. `key` é estável (as tarefas referenciam por key);
 * `label`, cor, emoji e ordem são editáveis.
 * Padrão: demandas → a_fazer → executar_primeiro → em_andamento → ajustes →
 * aguardando_aprovacao (isApproval) → enviar_cliente → aguardando_cliente → veicular → concluido (isFinal).
 * Chaves com comportamento especial no fluxo: `ajustes`, `aguardando_cliente`, `demandas`.
 */
export const kanbanColumns = pgTable(
  "kanban_columns",
  {
    id: pk(),
    tenantId: tenantId(),
    key: text().notNull(),
    label: text().notNull(),
    emoji: text(),
    isFinal: boolean().notNull().default(false),
    isApproval: boolean().notNull().default(false),
    ...catalogColumns,
    ...timestamps,
  },
  (t) => [
    tenantUnique("kanban_columns_tenant_id_uq", t),
    unique("kanban_columns_tenant_key_uq").on(t.tenantId, t.key),
    /** Exatamente uma coluna final por tenant. */
    uniqueIndex("kanban_columns_one_final_uq").on(t.tenantId).where(sql`${t.isFinal}`),
    check("kanban_columns_key_format", sql`${t.key} ~ '^[a-z0-9_]{1,48}$'`),
  ],
);

/** Motivos de ajuste (briefing errado, erro de ortografia, erro de render…). */
export const adjustmentReasons = pgTable(
  "adjustment_reasons",
  {
    id: pk(),
    tenantId: tenantId(),
    slug: text().notNull(),
    label: text().notNull(),
    ...catalogColumns,
    ...timestamps,
  },
  (t) => [
    tenantUnique("adjustment_reasons_tenant_id_uq", t),
    uniqueIndex("adjustment_reasons_tenant_slug_uq").on(t.tenantId, t.slug),
  ],
);

/** Tags de tarefa. */
export const tags = pgTable(
  "tags",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text().notNull(),
    ...catalogColumns,
    ...timestamps,
  },
  (t) => [
    tenantUnique("tags_tenant_id_uq", t),
    uniqueIndex("tags_tenant_name_uq").on(t.tenantId, sql`lower(${t.name})`),
  ],
);

/** Tags de projeto. */
export const projectTags = pgTable(
  "project_tags",
  {
    id: pk(),
    tenantId: tenantId(),
    slug: text().notNull(),
    name: text().notNull(),
    ...catalogColumns,
    ...timestamps,
  },
  (t) => [
    tenantUnique("project_tags_tenant_id_uq", t),
    uniqueIndex("project_tags_tenant_slug_uq").on(t.tenantId, t.slug),
  ],
);

/** Setores / times (placar de produtividade por setor). */
export const sectors = pgTable(
  "sectors",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text().notNull(),
    ...catalogColumns,
    ...timestamps,
  },
  (t) => [
    tenantUnique("sectors_tenant_id_uq", t),
    uniqueIndex("sectors_tenant_name_uq").on(t.tenantId, sql`lower(${t.name})`),
  ],
);

/** Funções na tarefa (editor, designer, videomaker, copywriter…). */
export const taskRoles = pgTable(
  "task_roles",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text().notNull(),
    ...catalogColumns,
    ...timestamps,
  },
  (t) => [
    tenantUnique("task_roles_tenant_id_uq", t),
    uniqueIndex("task_roles_tenant_name_uq").on(t.tenantId, sql`lower(${t.name})`),
  ],
);
