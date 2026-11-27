/**
 * Catálogos do tenant (§5, §6.12): CRUD, reordenação e ativar/desativar.
 * Leitura: qualquer membro (os formulários de projeto e tarefa usam). Escrita: `catalogs.manage`.
 * Item em uso não é apagado (409 CATALOG_IN_USE): o caminho é desativar.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { type AppTx, schema } from "@recpm/db";
import {
  catalogItemInput,
  kanbanColumnInput,
  reorderInput,
  SIMPLE_CATALOGS,
  type SimpleCatalog,
  SYSTEM_COLUMN_KEYS,
  taskTypeInput,
} from "@recpm/shared";
import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { audit, diff } from "../lib/audit";
import { AppError, isFkViolation, isUniqueViolation } from "../lib/errors";
import { router } from "../lib/router";
import { freeSlug, slugify } from "../lib/slug";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;

/** Tabelas dos catálogos simples. `labelCol` é "label" ou "name"; `slug` indica se há slug. */
const SIMPLE = {
  "project-types": { table: s.projectTypes, labelCol: "label", slug: true, entity: "project_type" },
  "report-categories": {
    table: s.reportCategories,
    labelCol: "label",
    slug: true,
    entity: "report_category",
  },
  "adjustment-reasons": {
    table: s.adjustmentReasons,
    labelCol: "label",
    slug: true,
    entity: "adjustment_reason",
  },
  tags: { table: s.tags, labelCol: "name", slug: false, entity: "tag" },
  "project-tags": { table: s.projectTags, labelCol: "name", slug: true, entity: "project_tag" },
  sectors: { table: s.sectors, labelCol: "name", slug: false, entity: "sector" },
  "task-roles": { table: s.taskRoles, labelCol: "name", slug: false, entity: "task_role" },
} as const satisfies Record<SimpleCatalog, unknown>;

// Os catálogos simples têm as mesmas colunas (id, cor, ícone, posição, ativo) + rótulo e talvez slug.
// biome-ignore lint/suspicious/noExplicitAny: acesso uniforme a tabelas de mesmo formato
type AnyTable = any;
const cfg = (kind: SimpleCatalog) =>
  SIMPLE[kind] as { table: AnyTable; labelCol: "label" | "name"; slug: boolean; entity: string };

const CatalogItem = z
  .object({
    id: z.uuid(),
    label: z.string(),
    slug: z.string().nullable(),
    color: z.string().nullable(),
    icon: z.string().nullable(),
    position: z.number(),
    active: z.boolean(),
  })
  .openapi("CatalogItem");

const TaskType = CatalogItem.extend({
  slug: z.string(),
  defaultEstimatedHours: z.number().nullable(),
  sellable: z.boolean(),
  usableAsType: z.boolean(),
  countsAsPiece: z.boolean(),
  reportCategoryId: z.uuid().nullable(),
  checklist: z.array(z.string()),
}).openapi("TaskType");

const KanbanColumn = z
  .object({
    id: z.uuid(),
    key: z.string(),
    label: z.string(),
    color: z.string().nullable(),
    emoji: z.string().nullable(),
    position: z.number(),
    active: z.boolean(),
    isFinal: z.boolean(),
    isApproval: z.boolean(),
    system: z.boolean(),
    taskCount: z.number(),
  })
  .openapi("KanbanColumn");

const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const err = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorBody } },
});
const json = <T extends z.ZodType>(schema: T) => ({ content: { "application/json": { schema } } });
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, ...json(schema) });

const Kind = z.object({ kind: z.enum(SIMPLE_CATALOGS) });
const KindId = Kind.extend({ id: z.uuid() });
const IdParam = z.object({ id: z.uuid() });
const ItemBody = z.object(catalogItemInput.shape).openapi("CatalogItemInput");
const TaskTypeBody = z.object(taskTypeInput.shape).openapi("TaskTypeInput");
const ColumnBody = z.object(kanbanColumnInput.shape).openapi("KanbanColumnInput");
const ReorderBody = z.object(reorderInput.shape).openapi("ReorderInput");
const tags = ["Cadastros"];

const notFound = () => new AppError(404, "NOT_FOUND", "Item não encontrado.");
const inUse = () =>
  new AppError(409, "CATALOG_IN_USE", "Este item está em uso. Desative-o em vez de apagar.");
const duplicate = () => new AppError(409, "DUPLICATE", "Já existe um item com este nome.");

/** Grava a ordem: position = índice na lista enviada (ids de outro tenant são ignorados pelo RLS). */
async function reorder(tx: AppTx, table: AnyTable, ids: string[]) {
  await tx
    .update(table)
    .set({
      position: sql`array_position(${sql`ARRAY[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`}, ${table.id}) - 1`,
    })
    .where(inArray(table.id, ids));
}

async function nextPosition(tx: AppTx, table: AnyTable) {
  const [r] = await tx.select({ p: sql<number>`coalesce(max(${table.position}), -1) + 1` }).from(table);
  return Number(r?.p ?? 0);
}

/** Apaga dentro de um savepoint: FK violada vira 409 sem derrubar a transação. */
async function deleteOr409(tx: AppTx, fn: (tx: AppTx) => Promise<unknown>) {
  try {
    await tx.transaction(async (sp) => {
      await fn(sp as AppTx);
    });
  } catch (e) {
    if (isFkViolation(e)) throw inUse();
    throw e;
  }
}

const toItem = (row: Record<string, unknown>, c: { labelCol: string; slug: boolean }) => ({
  id: row.id as string,
  label: row[c.labelCol] as string,
  slug: c.slug ? (row.slug as string) : null,
  color: (row.color as string | null) ?? null,
  icon: (row.icon as string | null) ?? null,
  position: row.position as number,
  active: row.active as boolean,
});

export const catalogRoutes = (deps: Deps) => {
  const r = router();
  const manage = requirePermission("catalogs.manage");
  r.use("/catalogs/*", requireTenant(deps.dbs));
  r.on(["POST", "PATCH", "PUT", "DELETE"], "/catalogs/*", manage);

  // ── Tipos de tarefa ────────────────────────────────────────────────────────
  const loadTaskTypes = async (tx: AppTx, id?: string) => {
    const rows = await tx
      .select()
      .from(s.taskTypes)
      .where(id ? eq(s.taskTypes.id, id) : undefined)
      .orderBy(asc(s.taskTypes.position), asc(s.taskTypes.label));
    const items = rows.length
      ? await tx
          .select({ taskTypeId: s.taskTypeChecklistItems.taskTypeId, text: s.taskTypeChecklistItems.text })
          .from(s.taskTypeChecklistItems)
          .where(
            inArray(
              s.taskTypeChecklistItems.taskTypeId,
              rows.map((t) => t.id),
            ),
          )
          .orderBy(asc(s.taskTypeChecklistItems.position))
      : [];
    return rows.map((t) => ({
      id: t.id,
      label: t.label,
      slug: t.slug,
      color: t.color,
      icon: t.icon,
      position: t.position,
      active: t.active,
      defaultEstimatedHours: t.defaultEstimatedHours,
      sellable: t.sellable,
      usableAsType: t.usableAsType,
      countsAsPiece: t.countsAsPiece,
      reportCategoryId: t.reportCategoryId,
      checklist: items.filter((i) => i.taskTypeId === t.id).map((i) => i.text),
    }));
  };
  const writeChecklist = async (tx: AppTx, tenantId: string, taskTypeId: string, list: string[]) => {
    await tx.delete(s.taskTypeChecklistItems).where(eq(s.taskTypeChecklistItems.taskTypeId, taskTypeId));
    if (list.length)
      await tx
        .insert(s.taskTypeChecklistItems)
        .values(list.map((text, position) => ({ tenantId, taskTypeId, text, position })));
  };

  // ── Colunas do Kanban ──────────────────────────────────────────────────────
  const loadColumns = async (tx: AppTx) => {
    const counts = tx
      .select({ key: s.tasks.statusKey, n: count().as("n") })
      .from(s.tasks)
      .where(isNull(s.tasks.deletedAt))
      .groupBy(s.tasks.statusKey)
      .as("counts");
    const rows = await tx
      .select({ c: s.kanbanColumns, n: counts.n })
      .from(s.kanbanColumns)
      .leftJoin(counts, eq(counts.key, s.kanbanColumns.key))
      .orderBy(asc(s.kanbanColumns.position));
    return rows.map(({ c, n }) => ({
      id: c.id,
      key: c.key,
      label: c.label,
      color: c.color,
      emoji: c.emoji,
      position: c.position,
      active: c.active,
      isFinal: c.isFinal,
      isApproval: c.isApproval,
      system: (SYSTEM_COLUMN_KEYS as readonly string[]).includes(c.key),
      taskCount: Number(n ?? 0),
    }));
  };
  const columnById = async (tx: AppTx, id: string) => {
    const col = (await loadColumns(tx)).find((c) => c.id === id);
    if (!col) throw notFound();
    return col;
  };

  return (
    r
      // Rotas específicas antes das genéricas /catalogs/{kind}.
      .openapi(
        createRoute({
          method: "get",
          path: "/catalogs/task-types",
          tags,
          summary: "Tipos de tarefa (com modelo de checklist)",
          responses: { 200: ok(z.object({ data: z.array(TaskType) })) },
        }),
        async (c) => c.json({ data: await c.var.tenant.tx((tx) => loadTaskTypes(tx)) }, 200),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/catalogs/task-types",
          tags,
          summary: "Criar tipo de tarefa",
          request: { body: { ...json(TaskTypeBody), required: true } },
          responses: { 201: ok(TaskType, "Criado"), 409: err("Nome repetido") },
        }),
        async (c) => {
          const b = c.req.valid("json");
          const { tenantId } = c.var.tenant;
          try {
            const item = await c.var.tenant.tx(async (tx) => {
              const taken = await tx.select({ slug: s.taskTypes.slug }).from(s.taskTypes);
              const [row] = await tx
                .insert(s.taskTypes)
                .values({
                  tenantId,
                  slug: freeSlug(
                    slugify(b.label),
                    taken.map((t) => t.slug),
                  ),
                  label: b.label,
                  color: b.color ?? null,
                  icon: b.icon ?? null,
                  active: b.active ?? true,
                  defaultEstimatedHours: b.defaultEstimatedHours ?? null,
                  sellable: b.sellable ?? true,
                  usableAsType: b.usableAsType ?? true,
                  countsAsPiece: b.countsAsPiece ?? true,
                  reportCategoryId: b.reportCategoryId ?? null,
                  position: await nextPosition(tx, s.taskTypes),
                })
                .returning();
              await writeChecklist(tx, tenantId, row!.id, b.checklist ?? []);
              await audit(c, tx, {
                entity: "task_type",
                entityId: row!.id,
                entityLabel: b.label,
                action: "create",
              });
              return (await loadTaskTypes(tx, row!.id))[0]!;
            });
            return c.json(item, 201);
          } catch (e) {
            if (isUniqueViolation(e)) throw duplicate();
            if (isFkViolation(e))
              throw new AppError(400, "INVALID_REFERENCE", "Categoria de relatório inválida.");
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/catalogs/task-types/{id}",
          tags,
          summary: "Editar tipo de tarefa",
          request: { params: IdParam, body: { ...json(TaskTypeBody.partial()), required: true } },
          responses: { 200: ok(TaskType), 404: err("Não encontrado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { checklist, ...b } = c.req.valid("json");
          try {
            const item = await c.var.tenant.tx(async (tx) => {
              const [before] = await loadTaskTypes(tx, id);
              if (!before) throw notFound();
              if (Object.keys(b).length)
                await tx
                  .update(s.taskTypes)
                  .set({ ...b, updatedAt: new Date() })
                  .where(eq(s.taskTypes.id, id));
              if (checklist) await writeChecklist(tx, c.var.tenant.tenantId, id, checklist);
              const changes = diff(before, { ...b, checklist });
              if (Object.keys(changes).length)
                await audit(c, tx, {
                  entity: "task_type",
                  entityId: id,
                  entityLabel: b.label ?? before.label,
                  action: "update",
                  details: changes,
                });
              return (await loadTaskTypes(tx, id))[0]!;
            });
            return c.json(item, 200);
          } catch (e) {
            if (isUniqueViolation(e)) throw duplicate();
            if (isFkViolation(e))
              throw new AppError(400, "INVALID_REFERENCE", "Categoria de relatório inválida.");
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/catalogs/task-types/{id}",
          tags,
          summary: "Apagar tipo de tarefa (só se nunca usado)",
          request: { params: IdParam },
          responses: { 204: { description: "Apagado" }, 409: err("Em uso") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          await c.var.tenant.tx(async (tx) => {
            const [row] = await tx.select().from(s.taskTypes).where(eq(s.taskTypes.id, id));
            if (!row) throw notFound();
            await deleteOr409(tx, async (sp) => {
              await sp.delete(s.taskTypeChecklistItems).where(eq(s.taskTypeChecklistItems.taskTypeId, id));
              await sp.delete(s.taskTypes).where(eq(s.taskTypes.id, id));
            });
            await audit(c, tx, {
              entity: "task_type",
              entityId: id,
              entityLabel: row.label,
              action: "delete",
            });
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/catalogs/task-types/order",
          tags,
          summary: "Reordenar tipos de tarefa",
          request: { body: { ...json(ReorderBody), required: true } },
          responses: { 204: { description: "OK" } },
        }),
        async (c) => {
          const { ids } = c.req.valid("json");
          await c.var.tenant.tx((tx) => reorder(tx, s.taskTypes, ids));
          return c.body(null, 204);
        },
      )

      // ── Colunas do Kanban ─────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/catalogs/kanban-columns",
          tags,
          summary: "Colunas do Kanban de tarefas (fluxo)",
          responses: { 200: ok(z.object({ data: z.array(KanbanColumn) })) },
        }),
        async (c) => c.json({ data: await c.var.tenant.tx(loadColumns) }, 200),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/catalogs/kanban-columns",
          tags,
          summary: "Criar coluna (a chave é gerada do nome e não muda depois)",
          request: { body: { ...json(ColumnBody), required: true } },
          responses: { 201: ok(KanbanColumn, "Criada") },
        }),
        async (c) => {
          const b = c.req.valid("json");
          const { tenantId } = c.var.tenant;
          const col = await c.var.tenant.tx(async (tx) => {
            const taken = await tx.select({ key: s.kanbanColumns.key }).from(s.kanbanColumns);
            if (b.isFinal)
              await tx
                .update(s.kanbanColumns)
                .set({ isFinal: false })
                .where(eq(s.kanbanColumns.isFinal, true));
            const [row] = await tx
              .insert(s.kanbanColumns)
              .values({
                tenantId,
                key: freeSlug(
                  slugify(b.label, "_"),
                  taken.map((t) => t.key),
                  "_",
                ),
                label: b.label,
                color: b.color ?? null,
                emoji: b.emoji ?? null,
                isApproval: b.isApproval ?? false,
                isFinal: b.isFinal ?? false,
                active: true,
                position: await nextPosition(tx, s.kanbanColumns),
              })
              .returning();
            await audit(c, tx, {
              entity: "kanban_column",
              entityId: row!.id,
              entityLabel: b.label,
              action: "create",
            });
            return columnById(tx, row!.id);
          });
          return c.json(col, 201);
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/catalogs/kanban-columns/{id}",
          tags,
          summary: "Editar coluna",
          request: { params: IdParam, body: { ...json(ColumnBody.partial()), required: true } },
          responses: { 200: ok(KanbanColumn), 409: err("Regra do fluxo") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const col = await c.var.tenant.tx(async (tx) => {
            const before = await columnById(tx, id);
            if (b.active === false) {
              if (before.system || before.isFinal)
                throw new AppError(
                  409,
                  "COLUMN_REQUIRED",
                  "Esta coluna faz parte do fluxo e não pode ser desativada.",
                );
              if (before.taskCount)
                throw new AppError(
                  409,
                  "COLUMN_HAS_TASKS",
                  "Mova as tarefas desta coluna antes de desativá-la.",
                );
            }
            if (b.isFinal === false && before.isFinal)
              throw new AppError(
                409,
                "FINAL_REQUIRED",
                "Marque outra coluna como final em vez de desmarcar esta.",
              );
            if (b.isFinal && !before.isFinal)
              await tx
                .update(s.kanbanColumns)
                .set({ isFinal: false })
                .where(eq(s.kanbanColumns.isFinal, true));
            await tx
              .update(s.kanbanColumns)
              .set({ ...b, ...(b.isFinal ? { active: true } : {}), updatedAt: new Date() })
              .where(eq(s.kanbanColumns.id, id));
            const changes = diff(before, b);
            if (Object.keys(changes).length)
              await audit(c, tx, {
                entity: "kanban_column",
                entityId: id,
                entityLabel: b.label ?? before.label,
                action: "update",
                details: changes,
              });
            return columnById(tx, id);
          });
          return c.json(col, 200);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/catalogs/kanban-columns/{id}",
          tags,
          summary: "Apagar coluna vazia que não faz parte do fluxo",
          request: { params: IdParam },
          responses: { 204: { description: "Apagada" }, 409: err("Regra do fluxo") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          await c.var.tenant.tx(async (tx) => {
            const col = await columnById(tx, id);
            if (col.system || col.isFinal)
              throw new AppError(
                409,
                "COLUMN_REQUIRED",
                "Esta coluna faz parte do fluxo e não pode ser apagada.",
              );
            if (col.taskCount)
              throw new AppError(409, "COLUMN_HAS_TASKS", "Mova as tarefas desta coluna antes de apagá-la.");
            const [{ n } = { n: 0 }] = await tx
              .select({ n: count() })
              .from(s.kanbanColumns)
              .where(and(eq(s.kanbanColumns.active, true), ne(s.kanbanColumns.id, id)));
            if (n < 2)
              throw new AppError(409, "COLUMN_REQUIRED", "O fluxo precisa de pelo menos duas colunas.");
            await deleteOr409(tx, (sp) => sp.delete(s.kanbanColumns).where(eq(s.kanbanColumns.id, id)));
            await audit(c, tx, {
              entity: "kanban_column",
              entityId: id,
              entityLabel: col.label,
              action: "delete",
            });
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/catalogs/kanban-columns/order",
          tags,
          summary: "Reordenar colunas",
          request: { body: { ...json(ReorderBody), required: true } },
          responses: { 204: { description: "OK" } },
        }),
        async (c) => {
          const { ids } = c.req.valid("json");
          await c.var.tenant.tx(async (tx) => {
            await reorder(tx, s.kanbanColumns, ids);
            await audit(c, tx, { entity: "kanban_column", action: "reorder", details: { to: ids } });
          });
          return c.body(null, 204);
        },
      )

      // ── Catálogos simples ─────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/catalogs/{kind}",
          tags,
          summary: "Listar um catálogo (ativos e inativos, na ordem)",
          request: { params: Kind },
          responses: { 200: ok(z.object({ data: z.array(CatalogItem) })) },
        }),
        async (c) => {
          const k = cfg(c.req.valid("param").kind);
          const rows = await c.var.tenant.tx((tx) =>
            tx.select().from(k.table).orderBy(asc(k.table.position), asc(k.table[k.labelCol])),
          );
          return c.json({ data: rows.map((row: Record<string, unknown>) => toItem(row, k)) }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/catalogs/{kind}",
          tags,
          summary: "Criar item",
          request: { params: Kind, body: { ...json(ItemBody), required: true } },
          responses: { 201: ok(CatalogItem, "Criado"), 409: err("Nome repetido") },
        }),
        async (c) => {
          const k = cfg(c.req.valid("param").kind);
          const b = c.req.valid("json");
          try {
            const row = await c.var.tenant.tx(async (tx) => {
              const values: Record<string, unknown> = {
                tenantId: c.var.tenant.tenantId,
                [k.labelCol]: b.label,
                color: b.color ?? null,
                icon: b.icon ?? null,
                active: b.active ?? true,
                position: await nextPosition(tx, k.table),
              };
              if (k.slug) {
                const taken = await tx.select({ slug: k.table.slug }).from(k.table);
                values.slug = freeSlug(
                  slugify(b.label),
                  taken.map((t: { slug: string }) => t.slug),
                );
              }
              const [row] = (await tx.insert(k.table).values(values).returning()) as ({ id: string } & Record<
                string,
                unknown
              >)[];
              await audit(c, tx, {
                entity: k.entity,
                entityId: row!.id,
                entityLabel: b.label,
                action: "create",
              });
              return row;
            });
            return c.json(toItem(row!, k), 201);
          } catch (e) {
            if (isUniqueViolation(e)) throw duplicate();
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/catalogs/{kind}/{id}",
          tags,
          summary: "Editar item (inclui ativar/desativar)",
          request: { params: KindId, body: { ...json(ItemBody.partial()), required: true } },
          responses: { 200: ok(CatalogItem), 404: err("Não encontrado"), 409: err("Nome repetido") },
        }),
        async (c) => {
          const { kind, id } = c.req.valid("param");
          const k = cfg(kind);
          const { label, ...rest } = c.req.valid("json");
          try {
            const row = await c.var.tenant.tx(async (tx) => {
              const [before] = await tx.select().from(k.table).where(eq(k.table.id, id));
              if (!before) throw notFound();
              const set = {
                ...rest,
                ...(label !== undefined ? { [k.labelCol]: label } : {}),
                updatedAt: new Date(),
              };
              const [row] = (await tx
                .update(k.table)
                .set(set)
                .where(eq(k.table.id, id))
                .returning()) as Record<string, unknown>[];
              const changes = diff(toItem(before, k), { label, ...rest });
              if (Object.keys(changes).length)
                await audit(c, tx, {
                  entity: k.entity,
                  entityId: id,
                  entityLabel: label ?? before[k.labelCol],
                  action: "update",
                  details: changes,
                });
              return row;
            });
            return c.json(toItem(row!, k), 200);
          } catch (e) {
            if (isUniqueViolation(e)) throw duplicate();
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/catalogs/{kind}/{id}",
          tags,
          summary: "Apagar item (só se não estiver em uso)",
          request: { params: KindId },
          responses: { 204: { description: "Apagado" }, 409: err("Em uso") },
        }),
        async (c) => {
          const { kind, id } = c.req.valid("param");
          const k = cfg(kind);
          await c.var.tenant.tx(async (tx) => {
            const [row] = await tx.select().from(k.table).where(eq(k.table.id, id));
            if (!row) throw notFound();
            await deleteOr409(tx, (sp) => sp.delete(k.table).where(eq(k.table.id, id)));
            await audit(c, tx, {
              entity: k.entity,
              entityId: id,
              entityLabel: row[k.labelCol],
              action: "delete",
            });
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/catalogs/{kind}/order",
          tags,
          summary: "Reordenar (ids na nova ordem)",
          request: { params: Kind, body: { ...json(ReorderBody), required: true } },
          responses: { 204: { description: "OK" } },
        }),
        async (c) => {
          const k = cfg(c.req.valid("param").kind);
          const { ids } = c.req.valid("json");
          await c.var.tenant.tx((tx) => reorder(tx, k.table, ids));
          return c.body(null, 204);
        },
      )
  );
};
