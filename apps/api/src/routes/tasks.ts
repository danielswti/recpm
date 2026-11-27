/**
 * Tarefas (§6.3): visões globais (lista detalhada / Kanban / compacta) com filtros na URL,
 * gaveta da tarefa (checklist, feedback, anexos, ajustes, histórico), fluxo do Kanban,
 * duplicação, ações em massa e o pedido de arquivamento (funcionário pede, gestor decide).
 *
 * Quem vê: gestores (tasks.readAll) veem tudo; os demais, as tarefas em que estão envolvidos e
 * as dos projetos dos quais são membros. Quem altera: tasks.manage ou quem está envolvido.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  type Actor,
  approveTask,
  assertCanEdit,
  assertCanSee,
  createTask,
  isInvolved,
  loadTask,
  moveTask,
  nextOccurrence,
  notify,
  rejectTask,
} from "@recpm/core";
import { type AppTx, schema } from "@recpm/db";
import {
  adjustmentInput,
  archiveDecisionInput,
  archiveRequestInput,
  attachmentInput,
  bulkTaskInput,
  checklistItemInput,
  commentInput,
  moveTaskInput,
  PRIORITIES,
  RECURRENCES,
  reorderInput,
  richTextToPlain,
  taskFilters,
  taskInput,
} from "@recpm/shared";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError, isFkViolation } from "../lib/errors";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";
import { sendUsageWarnings } from "../services/usage-warnings";

const s = schema;
const tags = ["Tarefas"];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const IdParam = z.object({ id: z.uuid() });
const SubParam = z.object({ id: z.uuid(), subId: z.uuid() });
const noContent = { 204: { description: "OK" } };
const badRef = () => new AppError(400, "INVALID_REFERENCE", "Algum item selecionado não existe mais.");

const Person = z.object({ id: z.uuid(), name: z.string(), image: z.string().nullable() });

const TaskItem = z
  .object({
    id: z.uuid(),
    title: z.string(),
    project: z
      .object({
        id: z.uuid(),
        name: z.string(),
        clientCode: z.string().nullable(),
        clientName: z.string().nullable(),
      })
      .nullable(),
    phaseId: z.uuid().nullable(),
    statusKey: z.string(),
    statusSince: z.string(),
    rank: z.string(),
    priority: z.enum(PRIORITIES),
    deadline: z.string().nullable(),
    deadlineHasTime: z.boolean(),
    completedAt: z.string().nullable(),
    overdue: z.boolean(),
    assignee: Person.nullable(),
    participantCount: z.number(),
    approverId: z.uuid().nullable(),
    taskType: z.object({ id: z.uuid(), label: z.string(), color: z.string().nullable() }).nullable(),
    tags: z.array(z.object({ id: z.uuid(), name: z.string(), color: z.string().nullable() })),
    checklist: z.object({ total: z.number(), done: z.number() }),
    pieceQuantity: z.number(),
    visibleToClient: z.boolean(),
    recurrence: z.enum(RECURRENCES).nullable(),
    archived: z.boolean(),
    archiveRequestAt: z.string().nullable(),
    openAdjustments: z.number(),
    createdAt: z.string(),
  })
  .openapi("TaskItem");

const ChecklistItem = z.object({
  id: z.uuid(),
  text: z.string(),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  position: z.number(),
});

const TaskDetail = TaskItem.extend({
  description: z.any().nullable(),
  mainRoleId: z.uuid().nullable(),
  taskTypeId: z.uuid().nullable(),
  assigneeId: z.uuid().nullable(),
  approver: Person.nullable(),
  createdBy: Person.nullable(),
  source: z.string(),
  assignees: z.array(Person.extend({ roleId: z.uuid().nullable(), roleName: z.string().nullable() })),
  tagIds: z.array(z.uuid()),
  driveLink: z.string().nullable(),
  originalDeadline: z.string().nullable(),
  clientDeliveryDate: z.string().nullable(),
  estimatedHours: z.number().nullable(),
  recurrenceRule: z.any().nullable(),
  nextGenerationAt: z.string().nullable(),
  recurrenceParentId: z.uuid().nullable(),
  items: z.array(ChecklistItem),
  attachments: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      url: z.string().nullable(),
      fileId: z.uuid().nullable(),
      mimeType: z.string().nullable(),
      sizeBytes: z.number().nullable(),
      scanStatus: z.string().nullable(),
      visibleToClient: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  adjustments: z.array(
    z.object({
      id: z.uuid(),
      reason: z.string(),
      kind: z.enum(["internal", "client"]),
      description: z.string().nullable(),
      createdBy: z.string().nullable(),
      createdAt: z.string(),
      resolvedAt: z.string().nullable(),
    }),
  ),
  archiveRequest: z
    .object({ by: Person.nullable(), reason: z.string().nullable(), at: z.string() })
    .nullable(),
  lastClientChaseAt: z.string().nullable(),
  can: z.object({
    edit: z.boolean(),
    approve: z.boolean(),
    archive: z.boolean(),
    requestArchive: z.boolean(),
    delete: z.boolean(),
  }),
}).openapi("TaskDetail");

const Feedback = z
  .object({
    id: z.uuid(),
    author: Person.nullable(),
    body: z.any(),
    bodyText: z.string(),
    visibleToClient: z.boolean(),
    editedAt: z.string().nullable(),
    createdAt: z.string(),
    mine: z.boolean(),
  })
  .openapi("TaskFeedback");

const HistoryEntry = z
  .object({
    id: z.uuid(),
    action: z.string(),
    actorName: z.string().nullable(),
    details: z.any().nullable(),
    createdAt: z.string(),
  })
  .openapi("TaskHistoryEntry");

/** Envolvido = responsável, criador, aprovador ou participante. */
const involvedSql = (uid: string) =>
  or(
    eq(s.tasks.assigneeId, uid),
    eq(s.tasks.createdById, uid),
    eq(s.tasks.approverId, uid),
    exists(
      sql`(select 1 from ${s.taskAssignees} ta where ta.task_id = ${s.tasks.id} and ta.user_id = ${uid})`,
    ),
  )!;
const memberOfProjectSql = (uid: string) =>
  exists(
    sql`(select 1 from ${s.projectMembers} pm where pm.project_id = ${s.tasks.projectId} and pm.user_id = ${uid})`,
  );

const visibleTo = (actor: Actor): SQL | undefined =>
  actor.can("tasks.readAll") || !actor.userId
    ? undefined
    : or(involvedSql(actor.userId), memberOfProjectSql(actor.userId));

type Filters = z.infer<typeof taskFilters>;

function whereOf(actor: Actor, f: Filters, tz: string): SQL | undefined {
  const uid = actor.userId!;
  const term = f.q ? `%${f.q.replace(/[%_\\]/g, "\\$&")}%` : null;
  // Datas do filtro são dias de calendário no fuso do workspace.
  const dayStart = (d: string) => sql`(${d}::date)::timestamp AT TIME ZONE ${tz}`;
  return and(
    isNull(s.tasks.deletedAt),
    visibleTo(actor),
    f.scope === "mine"
      ? or(
          eq(s.tasks.assigneeId, uid),
          exists(
            sql`(select 1 from ${s.taskAssignees} ta where ta.task_id = ${s.tasks.id} and ta.user_id = ${uid})`,
          ),
        )
      : undefined,
    f.scope === "team" && !actor.can("tasks.readAll") ? memberOfProjectSql(uid) : undefined,
    eq(s.tasks.archived, f.archived ?? false),
    f.archiveRequested ? isNotNull(s.tasks.archiveRequestAt) : undefined,
    f.status ? eq(s.tasks.statusKey, f.status) : undefined,
    f.overdue ? and(isNull(s.tasks.completedAt), sql`${s.tasks.deadline} < now()`) : undefined,
    f.due24h
      ? and(
          isNull(s.tasks.completedAt),
          sql`${s.tasks.deadline} between now() and now() + interval '24 hours'`,
        )
      : undefined,
    f.waitingClient ? eq(s.tasks.statusKey, "aguardando_cliente") : undefined,
    f.projectId ? eq(s.tasks.projectId, f.projectId) : undefined,
    f.standalone ? isNull(s.tasks.projectId) : undefined,
    f.clientId ? eq(s.projects.clientId, f.clientId) : undefined,
    f.assigneeId
      ? or(
          eq(s.tasks.assigneeId, f.assigneeId),
          exists(
            sql`(select 1 from ${s.taskAssignees} ta where ta.task_id = ${s.tasks.id} and ta.user_id = ${f.assigneeId})`,
          ),
        )
      : undefined,
    f.typeId ? eq(s.tasks.taskTypeId, f.typeId) : undefined,
    f.tagId
      ? exists(
          sql`(select 1 from ${s.taskTags} tt where tt.task_id = ${s.tasks.id} and tt.tag_id = ${f.tagId})`,
        )
      : undefined,
    f.priority ? eq(s.tasks.priority, f.priority) : undefined,
    f.from ? sql`${s.tasks.deadline} >= ${dayStart(f.from)}` : undefined,
    f.to ? sql`${s.tasks.deadline} < ${dayStart(f.to)} + interval '1 day'` : undefined,
    term
      ? or(ilike(s.tasks.title, term), ilike(s.tasks.descriptionText, term), ilike(s.projects.name, term))
      : undefined,
  );
}

async function listTasks(
  tx: AppTx,
  where: SQL | undefined,
  sort: Filters["sort"],
  page = 1,
  pageSize = 1000,
) {
  const check = tx
    .select({
      taskId: s.taskSubitems.taskId,
      total: sql<number>`count(*)`.as("ck_total"),
      done: sql<number>`count(*) filter (where ${s.taskSubitems.done})`.as("ck_done"),
    })
    .from(s.taskSubitems)
    .groupBy(s.taskSubitems.taskId)
    .as("ck");
  const people = tx
    .select({ taskId: s.taskAssignees.taskId, n: sql<number>`count(*)`.as("pp_n") })
    .from(s.taskAssignees)
    .groupBy(s.taskAssignees.taskId)
    .as("pp");
  const adj = tx
    .select({ taskId: s.taskAdjustments.taskId, n: sql<number>`count(*)`.as("aj_n") })
    .from(s.taskAdjustments)
    .where(isNull(s.taskAdjustments.resolvedAt))
    .groupBy(s.taskAdjustments.taskId)
    .as("aj");

  const order =
    sort === "board"
      ? [sql`${s.tasks.rank} COLLATE "C" asc`]
      : sort === "recent"
        ? [desc(s.tasks.createdAt)]
        : sort === "priority"
          ? [
              sql`case ${s.tasks.priority} when 'alta' then 0 when 'media' then 1 else 2 end`,
              sql`${s.tasks.deadline} asc nulls last`,
            ]
          : [sql`${s.tasks.deadline} asc nulls last`, desc(s.tasks.createdAt)];

  const rows = await tx
    .select({
      t: s.tasks,
      projectName: s.projects.name,
      clientCode: s.clients.code,
      clientName: s.clients.name,
      assigneeName: s.users.name,
      assigneeImage: s.users.image,
      typeLabel: s.taskTypes.label,
      typeColor: s.taskTypes.color,
      ckTotal: check.total,
      ckDone: check.done,
      people: people.n,
      openAdj: adj.n,
      count: sql<number>`count(*) over ()`,
    })
    .from(s.tasks)
    .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
    .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .leftJoin(s.users, eq(s.users.id, s.tasks.assigneeId))
    .leftJoin(s.taskTypes, eq(s.taskTypes.id, s.tasks.taskTypeId))
    .leftJoin(check, eq(check.taskId, s.tasks.id))
    .leftJoin(people, eq(people.taskId, s.tasks.id))
    .leftJoin(adj, eq(adj.taskId, s.tasks.id))
    .where(where)
    .orderBy(...order)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const ids = rows.map((r) => r.t.id);
  const tagRows = ids.length
    ? await tx
        .select({ taskId: s.taskTags.taskId, id: s.tags.id, name: s.tags.name, color: s.tags.color })
        .from(s.taskTags)
        .innerJoin(s.tags, eq(s.tags.id, s.taskTags.tagId))
        .where(inArray(s.taskTags.taskId, ids))
    : [];
  const now = Date.now();
  return {
    total: Number(rows[0]?.count ?? 0),
    data: rows.map(({ t, ...r }) => ({
      id: t.id,
      title: t.title,
      project: t.projectId
        ? { id: t.projectId, name: r.projectName ?? "", clientCode: r.clientCode, clientName: r.clientName }
        : null,
      phaseId: t.phaseId,
      statusKey: t.statusKey,
      statusSince: t.statusSince.toISOString(),
      rank: t.rank,
      priority: t.priority,
      deadline: iso(t.deadline),
      deadlineHasTime: t.deadlineHasTime,
      completedAt: iso(t.completedAt),
      overdue: !t.completedAt && !!t.deadline && t.deadline.getTime() < now,
      assignee: t.assigneeId
        ? { id: t.assigneeId, name: r.assigneeName ?? "", image: r.assigneeImage }
        : null,
      participantCount: Number(r.people ?? 0),
      approverId: t.approverId,
      taskType: t.taskTypeId ? { id: t.taskTypeId, label: r.typeLabel ?? "", color: r.typeColor } : null,
      tags: tagRows.filter((x) => x.taskId === t.id).map(({ taskId: _, ...x }) => x),
      checklist: { total: Number(r.ckTotal ?? 0), done: Number(r.ckDone ?? 0) },
      pieceQuantity: t.pieceQuantity,
      visibleToClient: t.visibleToClient,
      recurrence: t.recurrence,
      archived: t.archived,
      archiveRequestAt: iso(t.archiveRequestAt),
      openAdjustments: Number(r.openAdj ?? 0),
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

async function tenantTz(tx: AppTx) {
  const [t] = await tx.select({ tz: s.tenants.timezone }).from(s.tenants);
  return t?.tz ?? "America/Sao_Paulo";
}

async function taskDetail(tx: AppTx, actor: Actor, id: string) {
  const t = await loadTask(tx, id);
  await assertCanSee(tx, actor, t);
  const { data } = await listTasks(tx, eq(s.tasks.id, id), "deadline");
  const item = data[0]!;
  const person = async (uid: string | null) => {
    if (!uid) return null;
    const [u] = await tx
      .select({ id: s.users.id, name: s.users.name, image: s.users.image })
      .from(s.users)
      .where(eq(s.users.id, uid));
    return u ?? null;
  };
  const assignees = await tx
    .select({
      id: s.users.id,
      name: s.users.name,
      image: s.users.image,
      roleId: s.taskAssignees.roleId,
      roleName: s.taskRoles.name,
    })
    .from(s.taskAssignees)
    .innerJoin(s.users, eq(s.users.id, s.taskAssignees.userId))
    .leftJoin(s.taskRoles, eq(s.taskRoles.id, s.taskAssignees.roleId))
    .where(eq(s.taskAssignees.taskId, id))
    .orderBy(asc(s.users.name));
  const items = await tx
    .select()
    .from(s.taskSubitems)
    .where(eq(s.taskSubitems.taskId, id))
    .orderBy(asc(s.taskSubitems.position), asc(s.taskSubitems.createdAt));
  const attachments = await tx
    .select({ a: s.taskAttachments, f: s.files })
    .from(s.taskAttachments)
    .leftJoin(s.files, eq(s.files.id, s.taskAttachments.fileId))
    .where(and(eq(s.taskAttachments.taskId, id), isNull(s.taskAttachments.deletedAt)))
    .orderBy(desc(s.taskAttachments.createdAt));
  const adjustments = await tx
    .select({ a: s.taskAdjustments, reason: s.adjustmentReasons.label, by: s.users.name })
    .from(s.taskAdjustments)
    .innerJoin(s.adjustmentReasons, eq(s.adjustmentReasons.id, s.taskAdjustments.reasonId))
    .leftJoin(s.users, eq(s.users.id, s.taskAdjustments.createdBy))
    .where(eq(s.taskAdjustments.taskId, id))
    .orderBy(desc(s.taskAdjustments.createdAt));

  const involved = await isInvolved(tx, t, actor.userId);
  const canEdit = actor.can("tasks.manage") || involved;
  return {
    ...item,
    description: t.description,
    mainRoleId: t.mainRoleId,
    taskTypeId: t.taskTypeId,
    assigneeId: t.assigneeId,
    approver: await person(t.approverId),
    createdBy: await person(t.createdById),
    source: t.source,
    assignees,
    tagIds: item.tags.map((x) => x.id),
    driveLink: t.driveLink,
    originalDeadline: iso(t.originalDeadline),
    clientDeliveryDate: t.clientDeliveryDate,
    estimatedHours: t.estimatedHours,
    recurrenceRule: t.recurrenceRule,
    nextGenerationAt: iso(t.nextGenerationAt),
    recurrenceParentId: t.recurrenceParentId,
    items: items.map((i) => ({
      id: i.id,
      text: i.text,
      done: i.done,
      doneAt: iso(i.doneAt),
      position: i.position,
    })),
    attachments: attachments.map(({ a, f }) => ({
      id: a.id,
      name: a.name,
      url: a.url,
      fileId: a.fileId,
      mimeType: f?.mimeType ?? null,
      sizeBytes: f?.sizeBytes ?? null,
      scanStatus: f?.scanStatus ?? null,
      visibleToClient: a.visibleToClient,
      createdAt: a.createdAt.toISOString(),
    })),
    adjustments: adjustments.map(({ a, reason, by }) => ({
      id: a.id,
      reason,
      kind: a.kind,
      description: a.description,
      createdBy: by,
      createdAt: a.createdAt.toISOString(),
      resolvedAt: iso(a.resolvedAt),
    })),
    archiveRequest:
      t.archiveRequestAt && !t.archived
        ? {
            by: await person(t.archiveRequestBy),
            reason: t.archiveRequestReason,
            at: t.archiveRequestAt.toISOString(),
          }
        : null,
    lastClientChaseAt: iso(t.lastClientChaseAt),
    can: {
      edit: canEdit,
      approve: actor.can("tasks.approve") || t.approverId === actor.userId,
      archive: actor.can("tasks.archive"),
      requestArchive: canEdit && actor.can("tasks.requestArchive"),
      delete: actor.can("tasks.manage") || t.createdById === actor.userId,
    },
  };
}

type TaskBody = z.infer<typeof taskInput>;

/** Confere que as pessoas citadas são da equipe (ativos, não-cliente). */
async function assertTeamUsers(tx: AppTx, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return;
  const found = await tx
    .select({ u: s.memberships.userId })
    .from(s.memberships)
    .where(
      and(
        inArray(s.memberships.userId, want),
        eq(s.memberships.active, true),
        sql`${s.memberships.role} <> 'cliente'`,
      ),
    );
  if (found.length !== want.length) throw badRef();
}

/** Campos editáveis do PATCH (status muda só pelo /move). */
function patchColumns(
  b: Partial<TaskBody>,
  before: { deadline: Date | null; originalDeadline: Date | null },
) {
  const {
    assignees: _a,
    tagIds: _t,
    checklist: _c,
    statusKey: _s,
    projectId: _p,
    description,
    deadline,
    driveLink,
    ...rest
  } = b;
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  );
  if (description !== undefined) {
    out.description = description;
    out.descriptionText = description ? richTextToPlain(description) : null;
  }
  if (deadline !== undefined) {
    out.deadline = deadline ? new Date(deadline) : null;
    // O prazo original fica guardado (atrasos medem contra ele).
    if (!before.originalDeadline && deadline) out.originalDeadline = new Date(deadline);
  }
  if (driveLink !== undefined) out.driveLink = driveLink || null;
  if (b.recurrence === null) out.recurrenceRule = null;
  return out;
}

export const taskRoutes = (deps: Deps) => {
  const r = router();
  r.use("/tasks", requireTenant(deps.dbs), teamOnly, requirePermission("tasks.read"));
  r.use("/tasks/*", requireTenant(deps.dbs), teamOnly, requirePermission("tasks.read"));
  r.on(["POST"], ["/tasks", "/tasks/:id/duplicate"], requirePermission("tasks.create"));
  r.on(["POST"], ["/tasks/:id/archive", "/tasks/:id/archive-decision"], requirePermission("tasks.archive"));
  r.on(["POST"], ["/tasks/:id/archive-request"], requirePermission("tasks.requestArchive"));

  const tx = <T>(c: Parameters<typeof actorOf>[0], fn: (tx: AppTx, actor: Actor) => Promise<T>) =>
    c.var.tenant.tx((t) => fn(t, actorOf(c)));

  /** Carrega a tarefa e exige poder editá-la. */
  const editable = async (t: AppTx, actor: Actor, id: string) => {
    const task = await loadTask(t, id);
    await assertCanEdit(t, actor, task);
    return task;
  };

  const history = async (
    t: AppTx,
    actor: Actor,
    taskId: string,
    action: string,
    details?: Record<string, unknown>,
    label?: string,
  ) =>
    t.insert(s.auditLogs).values({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      impersonatorId: actor.impersonatorId ?? null,
      entity: "task",
      entityId: taskId,
      entityLabel: label ?? null,
      action,
      details: (details ?? null) as never,
      ip: actor.ip ?? null,
      requestId: actor.requestId ?? null,
    });

  return (
    r
      .openapi(
        createRoute({
          method: "get",
          path: "/tasks",
          tags,
          summary:
            "Tarefas (filtros: escopo, status, atrasadas, 24h, aguardando cliente, projeto, cliente, …)",
          request: { query: taskFilters },
          responses: {
            200: ok(
              z.object({
                data: z.array(TaskItem),
                total: z.number(),
                page: z.number(),
                pageSize: z.number(),
              }),
            ),
          },
        }),
        async (c) => {
          const f = c.req.valid("query");
          const res = await tx(c, async (t, actor) =>
            listTasks(t, whereOf(actor, f, await tenantTz(t)), f.sort, f.page, f.pageSize),
          );
          return c.json({ ...res, page: f.page, pageSize: f.pageSize }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/tasks/summary",
          tags,
          summary: "Contadores do dia (minhas tarefas): atrasadas, vencendo em 24h, em ajuste, aprovações",
          responses: {
            200: ok(
              z.object({
                open: z.number(),
                overdue: z.number(),
                due24h: z.number(),
                adjustments: z.number(),
                approvals: z.number(),
                waitingClient: z.number(),
                archiveRequests: z.number(),
              }),
            ),
          },
        }),
        async (c) => {
          const res = await tx(c, async (t, actor) => {
            const uid = actor.userId!;
            const mine = or(
              eq(s.tasks.assigneeId, uid),
              exists(
                sql`(select 1 from ${s.taskAssignees} ta where ta.task_id = ${s.tasks.id} and ta.user_id = ${uid})`,
              ),
            );
            const [m] = await t
              .select({
                open: sql<number>`count(*) filter (where ${s.tasks.completedAt} is null)`,
                overdue: sql<number>`count(*) filter (where ${s.tasks.completedAt} is null and ${s.tasks.deadline} < now())`,
                due24h: sql<number>`count(*) filter (where ${s.tasks.completedAt} is null and ${s.tasks.deadline} between now() and now() + interval '24 hours')`,
                adjustments: sql<number>`count(*) filter (where ${s.tasks.statusKey} = 'ajustes')`,
                waitingClient: sql<number>`count(*) filter (where ${s.tasks.statusKey} = 'aguardando_cliente')`,
              })
              .from(s.tasks)
              .where(and(isNull(s.tasks.deletedAt), eq(s.tasks.archived, false), mine));
            const approvalCols = t
              .select({ key: s.kanbanColumns.key })
              .from(s.kanbanColumns)
              .where(eq(s.kanbanColumns.isApproval, true));
            const [a] = await t
              .select({ n: sql<number>`count(*)` })
              .from(s.tasks)
              .where(
                and(
                  isNull(s.tasks.deletedAt),
                  eq(s.tasks.archived, false),
                  inArray(s.tasks.statusKey, approvalCols),
                  actor.can("tasks.approve") ? visibleTo(actor) : eq(s.tasks.approverId, uid),
                ),
              );
            const [ar] = actor.can("tasks.archive")
              ? await t
                  .select({ n: sql<number>`count(*)` })
                  .from(s.tasks)
                  .where(
                    and(
                      isNull(s.tasks.deletedAt),
                      eq(s.tasks.archived, false),
                      isNotNull(s.tasks.archiveRequestAt),
                    ),
                  )
              : [{ n: 0 }];
            return {
              open: Number(m?.open ?? 0),
              overdue: Number(m?.overdue ?? 0),
              due24h: Number(m?.due24h ?? 0),
              adjustments: Number(m?.adjustments ?? 0),
              waitingClient: Number(m?.waitingClient ?? 0),
              approvals: Number(a?.n ?? 0),
              archiveRequests: Number(ar?.n ?? 0),
            };
          });
          return c.json(res, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/bulk",
          tags,
          summary: "Ações em massa: mover, atribuir, prazo, prioridade, arquivar",
          request: body(z.object(bulkTaskInput.shape).openapi("BulkTaskInput")),
          responses: {
            200: ok(
              z.object({
                updated: z.number(),
                failed: z.array(z.object({ id: z.uuid(), code: z.string(), message: z.string() })),
              }),
            ),
          },
        }),
        async (c) => {
          const b = c.req.valid("json");
          if (b.action === "move" && !b.statusKey) throw new AppError(400, "VALIDATION", "Escolha a coluna.");
          if (b.action === "move" && b.statusKey === "ajustes")
            throw new AppError(
              400,
              "ADJUSTMENT_REASON_REQUIRED",
              "Ajustes pedem motivo: mova uma tarefa por vez.",
            );
          if (b.action === "priority" && !b.priority)
            throw new AppError(400, "VALIDATION", "Escolha a prioridade.");
          if (b.action === "archive" && !actorOf(c).can("tasks.archive"))
            throw new AppError(403, "FORBIDDEN", "Você não pode arquivar tarefas.");
          const res = await tx(c, async (t, actor) => {
            if (b.action === "assign") await assertTeamUsers(t, [b.assigneeId]);
            let updated = 0;
            const failed: { id: string; code: string; message: string }[] = [];
            for (const id of [...new Set(b.ids)]) {
              try {
                await t.transaction(async (sp) => {
                  if (b.action === "move") {
                    await moveTask(sp, actor, id, { statusKey: b.statusKey! });
                    return;
                  }
                  const task = await editable(sp, actor, id);
                  const now = new Date();
                  if (b.action === "assign") {
                    await sp
                      .update(s.tasks)
                      .set({ assigneeId: b.assigneeId ?? null, updatedAt: now })
                      .where(eq(s.tasks.id, id));
                    if (b.assigneeId) {
                      await sp
                        .insert(s.taskAssignees)
                        .values({
                          tenantId: actor.tenantId,
                          taskId: id,
                          userId: b.assigneeId,
                          roleId: task.mainRoleId,
                        })
                        .onConflictDoNothing();
                      await notify(
                        sp,
                        actor.tenantId,
                        [b.assigneeId],
                        {
                          type: "tarefa_atribuida",
                          title: `Tarefa atribuída: ${task.title}`,
                          referenceType: "task",
                          referenceId: id,
                        },
                        actor.userId,
                      );
                    }
                    await history(
                      sp,
                      actor,
                      id,
                      "update",
                      { assigneeId: { from: task.assigneeId, to: b.assigneeId ?? null } },
                      task.title,
                    );
                  } else if (b.action === "deadline") {
                    const d = b.deadline ? new Date(b.deadline) : null;
                    await sp
                      .update(s.tasks)
                      .set({ deadline: d, originalDeadline: task.originalDeadline ?? d, updatedAt: now })
                      .where(eq(s.tasks.id, id));
                    await history(
                      sp,
                      actor,
                      id,
                      "update",
                      { deadline: { from: iso(task.deadline), to: iso(d) } },
                      task.title,
                    );
                  } else if (b.action === "priority") {
                    await sp
                      .update(s.tasks)
                      .set({ priority: b.priority!, updatedAt: now })
                      .where(eq(s.tasks.id, id));
                    await history(
                      sp,
                      actor,
                      id,
                      "update",
                      { priority: { from: task.priority, to: b.priority } },
                      task.title,
                    );
                  } else if (b.action === "archive") {
                    await sp
                      .update(s.tasks)
                      .set({ archived: true, archivedAt: now, archivedBy: actor.userId, updatedAt: now })
                      .where(eq(s.tasks.id, id));
                    await history(sp, actor, id, "archive", undefined, task.title);
                  }
                });
                updated++;
              } catch (e) {
                const err = e as { code?: string; message?: string; status?: number };
                if (err.status && err.code) failed.push({ id, code: err.code, message: err.message ?? "" });
                else throw e;
              }
            }
            return { updated, failed };
          });
          return c.json(res, 200);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/tasks/{id}",
          tags,
          summary: "Tarefa completa (gaveta)",
          request: { params: IdParam },
          responses: { 200: ok(TaskDetail) },
        }),
        async (c) => c.json(await tx(c, (t, actor) => taskDetail(t, actor, c.req.valid("param").id)), 200),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks",
          tags,
          summary: "Criar tarefa (consome 1 da cota do plano; 402 se esgotada)",
          request: body(z.object(taskInput.shape).openapi("TaskInput")),
          responses: { 201: ok(TaskDetail, "Criada") },
        }),
        async (c) => {
          const b = taskInput.parse(c.req.valid("json"));
          try {
            const res = await tx(c, async (t, actor) => {
              await assertTeamUsers(t, [
                b.assigneeId,
                b.approverId,
                ...(b.assignees ?? []).map((a) => a.userId),
              ]);
              const created = await createTask(t, actor, {
                ...b,
                descriptionText: b.description ? richTextToPlain(b.description) : null,
                source: "ui",
              });
              return { task: await taskDetail(t, actor, created.id), quota: created.quota };
            });
            if (res.quota.warnings.length && res.quota.limit)
              await sendUsageWarnings(
                deps,
                c.var.tenant.tenantId,
                res.quota.warnings,
                res.quota.used,
                res.quota.limit,
              );
            return c.json(res.task, 201);
          } catch (e) {
            if (isFkViolation(e)) throw badRef();
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/tasks/{id}",
          tags,
          summary: "Editar tarefa (para mudar de coluna use /move)",
          request: { params: IdParam, ...body(z.object(taskInput.shape).partial().openapi("TaskPatch")) },
          responses: { 200: ok(TaskDetail) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = z.object(taskInput.shape).partial().parse(c.req.valid("json"));
          try {
            const res = await tx(c, async (t, actor) => {
              const before = await editable(t, actor, id);
              await assertTeamUsers(t, [
                b.assigneeId,
                b.approverId,
                ...(b.assignees ?? []).map((a) => a.userId),
              ]);
              if (b.recurrence && !(b.recurrenceRule ?? before.recurrenceRule))
                throw new AppError(400, "RECURRENCE_RULE_REQUIRED", "Recorrência precisa de regra.");
              const patch = patchColumns(b, before);
              // Recorrência nova/alterada: recalcula a próxima geração.
              if (b.recurrence !== undefined || b.recurrenceRule !== undefined) {
                const kind = b.recurrence === undefined ? before.recurrence : b.recurrence;
                const rule = b.recurrenceRule === undefined ? before.recurrenceRule : b.recurrenceRule;
                patch.nextGenerationAt =
                  kind && rule
                    ? nextOccurrence(kind, rule, new Date(), await tenantTz(t), before.createdAt)
                    : null;
                if (!kind) patch.recurrenceRule = null;
              }
              if (Object.keys(patch).length)
                await t
                  .update(s.tasks)
                  .set({ ...patch, updatedAt: new Date() })
                  .where(eq(s.tasks.id, id));

              const newPeople: string[] = [];
              if (b.assignees) {
                const current = (
                  await t
                    .select({ u: s.taskAssignees.userId })
                    .from(s.taskAssignees)
                    .where(eq(s.taskAssignees.taskId, id))
                ).map((x) => x.u);
                await t.delete(s.taskAssignees).where(eq(s.taskAssignees.taskId, id));
                const m = new Map(b.assignees.map((a) => [a.userId, a.roleId ?? null]));
                const main = b.assigneeId === undefined ? before.assigneeId : b.assigneeId;
                if (main && !m.has(main)) m.set(main, before.mainRoleId);
                if (m.size)
                  await t
                    .insert(s.taskAssignees)
                    .values(
                      [...m].map(([userId, roleId]) => ({
                        tenantId: actor.tenantId,
                        taskId: id,
                        userId,
                        roleId,
                      })),
                    );
                newPeople.push(...[...m.keys()].filter((u) => !current.includes(u)));
              } else if (b.assigneeId) {
                const ins = await t
                  .insert(s.taskAssignees)
                  .values({
                    tenantId: actor.tenantId,
                    taskId: id,
                    userId: b.assigneeId,
                    roleId: before.mainRoleId,
                  })
                  .onConflictDoNothing()
                  .returning({ u: s.taskAssignees.userId });
                newPeople.push(...ins.map((x) => x.u));
              }
              if (b.tagIds) {
                await t.delete(s.taskTags).where(eq(s.taskTags.taskId, id));
                if (b.tagIds.length)
                  await t
                    .insert(s.taskTags)
                    .values(
                      [...new Set(b.tagIds)].map((tagId) => ({
                        tenantId: actor.tenantId,
                        taskId: id,
                        tagId,
                      })),
                    );
              }
              if (b.assigneeId && b.assigneeId !== before.assigneeId) newPeople.push(b.assigneeId);
              if (newPeople.length)
                await notify(
                  t,
                  actor.tenantId,
                  newPeople,
                  {
                    type: "tarefa_atribuida",
                    title: `Tarefa atribuída: ${b.title ?? before.title}`,
                    referenceType: "task",
                    referenceId: id,
                  },
                  actor.userId,
                );

              const changes: Record<string, { from: unknown; to: unknown }> = {};
              for (const [k, v] of Object.entries(patch)) {
                if (["descriptionText", "originalDeadline", "nextGenerationAt"].includes(k)) continue;
                const old = (before as Record<string, unknown>)[k];
                const norm = (x: unknown) => (x instanceof Date ? x.toISOString() : x);
                if (k === "description") {
                  changes.description = { from: "…", to: "…" };
                  continue;
                }
                if (JSON.stringify(norm(old)) !== JSON.stringify(norm(v)))
                  changes[k] = { from: norm(old), to: norm(v) };
              }
              if (b.assignees) changes.assignees = { from: "…", to: b.assignees.map((a) => a.userId) };
              if (b.tagIds) changes.tags = { from: "…", to: b.tagIds };
              if (Object.keys(changes).length)
                await history(t, actor, id, "update", changes, b.title ?? before.title);
              return taskDetail(t, actor, id);
            });
            return c.json(res, 200);
          } catch (e) {
            if (isFkViolation(e)) throw badRef();
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/tasks/{id}",
          tags,
          summary: "Excluir tarefa (gestor ou quem criou). Não devolve cota.",
          request: { params: IdParam },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          await tx(c, async (t, actor) => {
            const task = await loadTask(t, id);
            await assertCanSee(t, actor, task);
            if (!actor.can("tasks.manage") && task.createdById !== actor.userId)
              throw new AppError(403, "FORBIDDEN", "Só quem criou (ou um gestor) pode excluir.");
            await t.update(s.tasks).set({ deletedAt: new Date() }).where(eq(s.tasks.id, id));
            await history(t, actor, id, "delete", undefined, task.title);
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/move",
          tags,
          summary: "Mover card (coluna e posição), com as regras do fluxo",
          request: { params: IdParam, ...body(z.object(moveTaskInput.shape).openapi("MoveTaskInput")) },
          responses: { 200: ok(z.object({ from: z.string(), to: z.string() })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          return c.json(await tx(c, (t, actor) => moveTask(t, actor, id, b)), 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/approve",
          tags,
          summary: "Aprovar (vai para a próxima coluna do fluxo)",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ from: z.string(), to: z.string() })) },
        }),
        async (c) => c.json(await tx(c, (t, actor) => approveTask(t, actor, c.req.valid("param").id)), 200),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/reject",
          tags,
          summary: "Reprovar (volta para Ajustes com motivo)",
          request: { params: IdParam, ...body(z.object(adjustmentInput.shape).openapi("AdjustmentInput")) },
          responses: { 200: ok(z.object({ from: z.string(), to: z.string() })) },
        }),
        async (c) =>
          c.json(
            await tx(c, (t, actor) => rejectTask(t, actor, c.req.valid("param").id, c.req.valid("json"))),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/chase",
          tags,
          summary: "Registrar cobrança ao cliente (zera o SLA de aguardando cliente)",
          request: { params: IdParam },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          await tx(c, async (t, actor) => {
            const task = await editable(t, actor, id);
            if (task.statusKey !== "aguardando_cliente")
              throw new AppError(409, "NOT_WAITING_CLIENT", "A tarefa não está aguardando o cliente.");
            const now = new Date();
            await t
              .update(s.tasks)
              .set({ lastClientChaseAt: now, chaseSlaNotifiedAt: null })
              .where(eq(s.tasks.id, id));
            await history(t, actor, id, "client_chase", undefined, task.title);
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/duplicate",
          tags,
          summary: "Duplicar tarefa (consome cota)",
          request: { params: IdParam },
          responses: { 201: ok(z.object({ id: z.uuid() }), "Criada") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const res = await tx(c, async (t, actor) => {
            const p = await loadTask(t, id);
            await assertCanSee(t, actor, p);
            const assignees = await t
              .select({ userId: s.taskAssignees.userId, roleId: s.taskAssignees.roleId })
              .from(s.taskAssignees)
              .where(eq(s.taskAssignees.taskId, id));
            const tagIds = (
              await t.select({ id: s.taskTags.tagId }).from(s.taskTags).where(eq(s.taskTags.taskId, id))
            ).map((x) => x.id);
            const checklist = (
              await t
                .select({ text: s.taskSubitems.text })
                .from(s.taskSubitems)
                .where(eq(s.taskSubitems.taskId, id))
                .orderBy(asc(s.taskSubitems.position))
            ).map((x) => x.text);
            const created = await createTask(t, actor, {
              title: `${p.title} (cópia)`.slice(0, 300),
              projectId: p.projectId,
              phaseId: p.phaseId,
              description: p.description,
              descriptionText: p.descriptionText,
              assigneeId: p.assigneeId,
              mainRoleId: p.mainRoleId,
              taskTypeId: p.taskTypeId,
              approverId: p.approverId,
              assignees,
              tagIds,
              driveLink: p.driveLink,
              deadline: p.deadline,
              deadlineHasTime: p.deadlineHasTime,
              clientDeliveryDate: p.clientDeliveryDate,
              priority: p.priority,
              visibleToClient: p.visibleToClient,
              estimatedHours: p.estimatedHours,
              pieceQuantity: p.pieceQuantity,
              checklist,
              source: "duplicate",
            });
            return created;
          });
          if (res.quota.warnings.length && res.quota.limit)
            await sendUsageWarnings(
              deps,
              c.var.tenant.tenantId,
              res.quota.warnings,
              res.quota.used,
              res.quota.limit,
            );
          return c.json({ id: res.id }, 201);
        },
      )
      // ---------- Arquivamento ----------
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/archive-request",
          tags,
          summary: "Pedir arquivamento (funcionário); avisa os gestores",
          request: { params: IdParam, ...body(z.object(archiveRequestInput.shape)) },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { reason } = c.req.valid("json");
          await tx(c, async (t, actor) => {
            const task = await editable(t, actor, id);
            if (task.archived) throw new AppError(409, "TASK_ARCHIVED", "A tarefa já está arquivada.");
            if (task.archiveRequestAt)
              throw new AppError(409, "ARCHIVE_ALREADY_REQUESTED", "O arquivamento já foi pedido.");
            await t
              .update(s.tasks)
              .set({
                archiveRequestBy: actor.userId,
                archiveRequestReason: reason || null,
                archiveRequestAt: new Date(),
              })
              .where(eq(s.tasks.id, id));
            await history(t, actor, id, "archive_request", { reason: reason || null }, task.title);
            const managers = await t
              .select({ u: s.memberships.userId })
              .from(s.memberships)
              .where(and(inArray(s.memberships.role, ["admin", "gestor"]), eq(s.memberships.active, true)));
            await notify(
              t,
              actor.tenantId,
              managers.map((m) => m.u),
              {
                type: "tarefa_arquivamento_pedido",
                title: `Pedido de arquivamento: ${task.title}`,
                message: reason,
                referenceType: "task",
                referenceId: id,
              },
              actor.userId,
            );
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/archive-decision",
          tags,
          summary: "Aprovar ou recusar o pedido de arquivamento (gestor)",
          request: { params: IdParam, ...body(z.object(archiveDecisionInput.shape)) },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { approve } = c.req.valid("json");
          await tx(c, async (t, actor) => {
            const task = await loadTask(t, id);
            if (!task.archiveRequestAt || task.archived)
              throw new AppError(409, "NO_ARCHIVE_REQUEST", "Não há pedido de arquivamento pendente.");
            const now = new Date();
            await t
              .update(s.tasks)
              .set(
                approve
                  ? { archived: true, archivedAt: now, archivedBy: actor.userId, updatedAt: now }
                  : {
                      archiveRequestAt: null,
                      archiveRequestBy: null,
                      archiveRequestReason: null,
                      updatedAt: now,
                    },
              )
              .where(eq(s.tasks.id, id));
            await history(
              t,
              actor,
              id,
              approve ? "archive" : "archive_request_rejected",
              undefined,
              task.title,
            );
            await notify(
              t,
              actor.tenantId,
              [task.archiveRequestBy],
              {
                type: approve ? "tarefa_arquivada" : "tarefa_arquivamento_recusado",
                title: approve
                  ? `Arquivamento aprovado: ${task.title}`
                  : `Arquivamento recusado: ${task.title}`,
                referenceType: "task",
                referenceId: id,
              },
              actor.userId,
            );
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/archive",
          tags,
          summary: "Arquivar ou desarquivar direto (gestor)",
          request: { params: IdParam, ...body(z.object({ archived: z.boolean() })) },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { archived } = c.req.valid("json");
          await tx(c, async (t, actor) => {
            const task = await loadTask(t, id);
            const now = new Date();
            await t
              .update(s.tasks)
              .set(
                archived
                  ? { archived: true, archivedAt: now, archivedBy: actor.userId, updatedAt: now }
                  : {
                      archived: false,
                      archivedAt: null,
                      archivedBy: null,
                      archiveRequestAt: null,
                      archiveRequestBy: null,
                      archiveRequestReason: null,
                      updatedAt: now,
                    },
              )
              .where(eq(s.tasks.id, id));
            await history(t, actor, id, archived ? "archive" : "unarchive", undefined, task.title);
          });
          return c.body(null, 204);
        },
      )
      // ---------- Checklist ----------
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/checklist",
          tags,
          summary: "Adicionar item ao checklist",
          request: { params: IdParam, ...body(z.object(checklistItemInput.shape)) },
          responses: { 201: ok(ChecklistItem, "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const row = await tx(c, async (t, actor) => {
            await editable(t, actor, id);
            const [{ n } = { n: 0 }] = await t
              .select({ n: sql<number>`coalesce(max(${s.taskSubitems.position}), -1) + 1` })
              .from(s.taskSubitems)
              .where(eq(s.taskSubitems.taskId, id));
            const [i] = await t
              .insert(s.taskSubitems)
              .values({
                tenantId: actor.tenantId,
                taskId: id,
                text: b.text,
                done: b.done ?? false,
                doneAt: b.done ? new Date() : null,
                doneBy: b.done ? actor.userId : null,
                position: Number(n),
              })
              .returning();
            return { id: i!.id, text: i!.text, done: i!.done, doneAt: iso(i!.doneAt), position: i!.position };
          });
          return c.json(row, 201);
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/tasks/{id}/checklist/{subId}",
          tags,
          summary: "Marcar/desmarcar ou renomear item",
          request: { params: SubParam, ...body(z.object(checklistItemInput.shape).partial()) },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          const b = c.req.valid("json");
          await tx(c, async (t, actor) => {
            await editable(t, actor, id);
            await t
              .update(s.taskSubitems)
              .set({
                ...(b.text !== undefined ? { text: b.text } : {}),
                ...(b.done !== undefined
                  ? { done: b.done, doneAt: b.done ? new Date() : null, doneBy: b.done ? actor.userId : null }
                  : {}),
                updatedAt: new Date(),
              })
              .where(and(eq(s.taskSubitems.id, subId), eq(s.taskSubitems.taskId, id)));
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/tasks/{id}/checklist/{subId}",
          tags,
          summary: "Remover item do checklist",
          request: { params: SubParam },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          await tx(c, async (t, actor) => {
            await editable(t, actor, id);
            await t
              .delete(s.taskSubitems)
              .where(and(eq(s.taskSubitems.id, subId), eq(s.taskSubitems.taskId, id)));
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/tasks/{id}/checklist/order",
          tags,
          summary: "Reordenar checklist",
          request: { params: IdParam, ...body(z.object(reorderInput.shape)) },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { ids } = c.req.valid("json");
          await tx(c, async (t, actor) => {
            await editable(t, actor, id);
            await t
              .update(s.taskSubitems)
              .set({ position: sql`array_position(${sql.param(ids)}::uuid[], ${s.taskSubitems.id}) - 1` })
              .where(and(eq(s.taskSubitems.taskId, id), inArray(s.taskSubitems.id, ids)));
          });
          return c.body(null, 204);
        },
      )
      // ---------- Feedback (comentários da tarefa) ----------
      .openapi(
        createRoute({
          method: "get",
          path: "/tasks/{id}/feedback",
          tags,
          summary: "Comentários/feedback da tarefa (mais antigos primeiro)",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ data: z.array(Feedback) })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const data = await tx(c, async (t, actor) => {
            await assertCanSee(t, actor, await loadTask(t, id));
            const rows = await t
              .select({ f: s.taskFeedback, name: s.users.name, image: s.users.image })
              .from(s.taskFeedback)
              .leftJoin(s.users, eq(s.users.id, s.taskFeedback.authorId))
              .where(and(eq(s.taskFeedback.taskId, id), isNull(s.taskFeedback.deletedAt)))
              .orderBy(asc(s.taskFeedback.createdAt));
            return rows.map(({ f, name, image }) => ({
              id: f.id,
              author: f.authorId ? { id: f.authorId, name: name ?? "", image } : null,
              body: f.body,
              bodyText: f.bodyText,
              visibleToClient: f.visibleToClient,
              editedAt: iso(f.editedAt),
              createdAt: f.createdAt.toISOString(),
              mine: f.authorId === actor.userId,
            }));
          });
          return c.json({ data }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/feedback",
          tags,
          summary: "Comentar na tarefa (avisa os envolvidos)",
          request: { params: IdParam, ...body(z.object(commentInput.shape)) },
          responses: { 201: ok(z.object({ id: z.uuid() }), "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const text = richTextToPlain(b.body);
          if (!text) throw new AppError(400, "VALIDATION", "Escreva o comentário.");
          const row = await tx(c, async (t, actor) => {
            const task = await loadTask(t, id);
            await assertCanSee(t, actor, task);
            const [f] = await t
              .insert(s.taskFeedback)
              .values({
                tenantId: actor.tenantId,
                taskId: id,
                authorId: actor.userId,
                body: b.body,
                bodyText: text,
                visibleToClient: b.visibleToClient ?? false,
              })
              .returning({ id: s.taskFeedback.id });
            const people = (
              await t
                .select({ u: s.taskAssignees.userId })
                .from(s.taskAssignees)
                .where(eq(s.taskAssignees.taskId, id))
            ).map((x) => x.u);
            await notify(
              t,
              actor.tenantId,
              [...people, task.assigneeId, task.createdById, task.approverId],
              {
                type: "tarefa_comentario",
                title: `Novo comentário: ${task.title}`,
                message: text.slice(0, 200),
                referenceType: "task",
                referenceId: id,
              },
              actor.userId,
            );
            return f!;
          });
          return c.json(row, 201);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/tasks/{id}/feedback/{subId}",
          tags,
          summary: "Excluir comentário (autor ou gestor)",
          request: { params: SubParam },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          await tx(c, async (t, actor) => {
            const [f] = await t
              .select({ authorId: s.taskFeedback.authorId })
              .from(s.taskFeedback)
              .where(and(eq(s.taskFeedback.id, subId), eq(s.taskFeedback.taskId, id)));
            if (!f) throw new AppError(404, "NOT_FOUND", "Comentário não encontrado.");
            if (f.authorId !== actor.userId && !actor.can("tasks.manage"))
              throw new AppError(403, "FORBIDDEN", "Você não pode excluir este comentário.");
            await t.update(s.taskFeedback).set({ deletedAt: new Date() }).where(eq(s.taskFeedback.id, subId));
          });
          return c.body(null, 204);
        },
      )
      // ---------- Anexos ----------
      .openapi(
        createRoute({
          method: "post",
          path: "/tasks/{id}/attachments",
          tags,
          summary: "Anexar arquivo enviado ou link",
          request: { params: IdParam, ...body(z.object(attachmentInput.shape)) },
          responses: { 201: ok(z.object({ id: z.uuid() }), "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = attachmentInput.parse(c.req.valid("json"));
          const row = await tx(c, async (t, actor) => {
            const task = await editable(t, actor, id);
            let name = b.name;
            if (b.fileId) {
              const [f] = await t
                .select({ name: s.files.originalName })
                .from(s.files)
                .where(and(eq(s.files.id, b.fileId), isNull(s.files.deletedAt)));
              if (!f) throw badRef();
              name ??= f.name;
            }
            const [a] = await t
              .insert(s.taskAttachments)
              .values({
                tenantId: actor.tenantId,
                taskId: id,
                fileId: b.fileId ?? null,
                url: b.url ?? null,
                name: name ?? b.url ?? "Link",
                visibleToClient: b.visibleToClient ?? false,
                createdBy: actor.userId,
              })
              .returning({ id: s.taskAttachments.id });
            await history(t, actor, id, "attachment_add", { name }, task.title);
            return a!;
          });
          return c.json(row, 201);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/tasks/{id}/attachments/{subId}",
          tags,
          summary: "Remover anexo",
          request: { params: SubParam },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          await tx(c, async (t, actor) => {
            const task = await editable(t, actor, id);
            const [a] = await t
              .update(s.taskAttachments)
              .set({ deletedAt: new Date() })
              .where(and(eq(s.taskAttachments.id, subId), eq(s.taskAttachments.taskId, id)))
              .returning({ name: s.taskAttachments.name });
            if (!a) throw new AppError(404, "NOT_FOUND", "Anexo não encontrado.");
            await history(t, actor, id, "attachment_delete", { name: a.name }, task.title);
          });
          return c.body(null, 204);
        },
      )
      // ---------- Histórico ----------
      .openapi(
        createRoute({
          method: "get",
          path: "/tasks/{id}/history",
          tags,
          summary: "Histórico da tarefa (quem, quando, o quê)",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ data: z.array(HistoryEntry) })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const data = await tx(c, async (t, actor) => {
            await assertCanSee(t, actor, await loadTask(t, id));
            const rows = await t
              .select({
                id: s.auditLogs.id,
                action: s.auditLogs.action,
                actorName: s.auditLogs.actorName,
                details: s.auditLogs.details,
                createdAt: s.auditLogs.createdAt,
              })
              .from(s.auditLogs)
              .where(and(eq(s.auditLogs.entity, "task"), eq(s.auditLogs.entityId, id)))
              .orderBy(desc(s.auditLogs.createdAt))
              .limit(300);
            return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
          });
          return c.json({ data }, 200);
        },
      )
  );
};
