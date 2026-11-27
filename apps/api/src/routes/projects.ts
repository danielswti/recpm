/**
 * Projetos (§6.2): lista (cards / Kanban por status / linha do tempo), página do projeto com
 * fases, marcos, comentários, arquivos e colunas do Kanban, e duplicação (com ou sem tarefas).
 *
 * Visibilidade: gestor/admin veem todos (projects.readAll); funcionário só os projetos dos
 * quais é membro. O RLS isola o tenant; o filtro de membro é aplicado aqui.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { type Actor, assertProjectAccess, createTask } from "@recpm/core";
import { type AppTx, schema } from "@recpm/db";
import {
  attachmentInput,
  commentInput,
  duplicateProjectInput,
  folderInput,
  milestoneInput,
  PRIORITIES,
  PROJECT_STATUSES,
  phaseInput,
  projectColumnsInput,
  projectFilters,
  projectInput,
  reorderInput,
  richTextToPlain,
} from "@recpm/shared";
import { and, asc, desc, eq, exists, ilike, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { audit, diff } from "../lib/audit";
import { AppError, isFkViolation } from "../lib/errors";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";
import { sendUsageWarnings } from "../services/usage-warnings";

const s = schema;
const tags = ["Projetos"];
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
const notFound = () => new AppError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
const badRef = () => new AppError(400, "INVALID_REFERENCE", "Algum item selecionado não existe mais.");

const Person = z.object({ id: z.uuid(), name: z.string(), image: z.string().nullable() });
const Tag = z.object({ id: z.uuid(), name: z.string(), color: z.string().nullable() });

const ProjectSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    client: z.object({ id: z.uuid(), code: z.string(), name: z.string() }).nullable(),
    internal: z.boolean(),
    modality: z.enum(["mensal", "avulso"]),
    periodicity: z.enum(["mensal", "anual"]).nullable(),
    type: z.object({ id: z.uuid(), label: z.string() }).nullable(),
    status: z.enum(PROJECT_STATUSES),
    waitingClient: z.boolean(),
    priority: z.enum(PRIORITIES),
    startDate: z.string().nullable(),
    deliveryDeadline: z.string().nullable(),
    clientDeliveryDate: z.string().nullable(),
    manager: Person.nullable(),
    tags: z.array(Tag),
    memberCount: z.number(),
    tasks: z.object({ total: z.number(), done: z.number(), overdue: z.number() }),
    archived: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("ProjectSummary");

const Milestone = z.object({
  id: z.string(),
  /** custom = marco criado à mão; os demais vêm das datas do projeto. */
  kind: z.enum([
    "custom",
    "start",
    "first_delivery",
    "feedback_deadline",
    "validated",
    "final_delivery",
    "support_start",
    "support_end",
  ]),
  title: z.string().nullable(),
  date: z.string(),
  completed: z.boolean(),
  visibleToClient: z.boolean(),
});

const Project = ProjectSummary.extend({
  firstDeliveryDate: z.string().nullable(),
  feedbackDeadline: z.string().nullable(),
  feedbackReceivedAt: z.string().nullable(),
  supportStart: z.string().nullable(),
  supportEnd: z.string().nullable(),
  signedAt: z.string().nullable(),
  contractEnd: z.string().nullable(),
  contractIndefinite: z.boolean(),
  deadlineText: z.string().nullable(),
  valueCents: z.number().nullable(),
  recurringValueCents: z.number().nullable(),
  extraCostCents: z.number().nullable(),
  extraCostDescription: z.string().nullable(),
  description: z.any().nullable(),
  publicSummary: z.string().nullable(),
  notes: z.string().nullable(),
  duplicatedFromId: z.uuid().nullable(),
  members: z.array(Person.extend({ roleId: z.uuid().nullable(), roleName: z.string().nullable() })),
  contractItems: z.array(
    z.object({
      id: z.uuid(),
      taskTypeId: z.uuid(),
      taskTypeLabel: z.string(),
      quantityPerPeriod: z.number(),
      formats: z.array(z.string()),
      delivered: z.number(),
    }),
  ),
  phases: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      completedAt: z.string().nullable(),
      total: z.number(),
      done: z.number(),
    }),
  ),
  milestones: z.array(Milestone),
  canManage: z.boolean(),
}).openapi("Project");

const Comment = z
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
  .openapi("ProjectComment");

const Folder = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string(),
  visibleToClient: z.boolean(),
});
const Attachment = z
  .object({
    id: z.uuid(),
    folderId: z.uuid().nullable(),
    name: z.string(),
    url: z.string().nullable(),
    file: z
      .object({
        id: z.uuid(),
        mimeType: z.string(),
        sizeBytes: z.number(),
        scanStatus: z.enum(["pending", "clean", "infected", "error"]),
      })
      .nullable(),
    visibleToClient: z.boolean(),
    createdBy: Person.nullable(),
    createdAt: z.string(),
  })
  .openapi("ProjectAttachment");

const Column = z
  .object({
    key: z.string(),
    label: z.string(),
    labelOverride: z.string().nullable(),
    emoji: z.string().nullable(),
    color: z.string().nullable(),
    isFinal: z.boolean(),
    isApproval: z.boolean(),
    visible: z.boolean(),
  })
  .openapi("ProjectColumn");

/** Funcionário só enxerga projetos dos quais é membro. */
export const projectVisibleTo = (actor: Actor): SQL | undefined =>
  actor.can("projects.readAll") || !actor.userId
    ? undefined
    : exists(
        sql`(select 1 from ${s.projectMembers} pm where pm.project_id = ${s.projects.id} and pm.user_id = ${actor.userId})`,
      );

async function list(tx: AppTx, where: SQL | undefined, page = 1, pageSize = 1000) {
  const stats = tx
    .select({
      projectId: s.tasks.projectId,
      total: sql<number>`count(*)`.as("ts_total"),
      done: sql<number>`count(*) filter (where ${s.tasks.completedAt} is not null)`.as("ts_done"),
      overdue:
        sql<number>`count(*) filter (where ${s.tasks.completedAt} is null and ${s.tasks.deadline} < now())`.as(
          "ts_overdue",
        ),
    })
    .from(s.tasks)
    .where(and(isNull(s.tasks.deletedAt), eq(s.tasks.archived, false)))
    .groupBy(s.tasks.projectId)
    .as("ts");
  const members = tx
    .select({ projectId: s.projectMembers.projectId, n: sql<number>`count(*)`.as("pm_n") })
    .from(s.projectMembers)
    .groupBy(s.projectMembers.projectId)
    .as("pmc");

  const rows = await tx
    .select({
      p: s.projects,
      clientCode: s.clients.code,
      clientName: s.clients.name,
      typeLabel: s.projectTypes.label,
      managerName: s.users.name,
      managerImage: s.users.image,
      total: stats.total,
      done: stats.done,
      overdue: stats.overdue,
      memberCount: members.n,
      count: sql<number>`count(*) over ()`,
    })
    .from(s.projects)
    .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .leftJoin(s.projectTypes, eq(s.projectTypes.id, s.projects.typeId))
    .leftJoin(s.users, eq(s.users.id, s.projects.managerId))
    .leftJoin(stats, eq(stats.projectId, s.projects.id))
    .leftJoin(members, eq(members.projectId, s.projects.id))
    .where(and(isNull(s.projects.deletedAt), where))
    .orderBy(sql`${s.projects.deliveryDeadline} asc nulls last`, asc(s.projects.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const ids = rows.map((r) => r.p.id);
  const tagRows = ids.length
    ? await tx
        .select({
          projectId: s.projectTagLinks.projectId,
          id: s.projectTags.id,
          name: s.projectTags.name,
          color: s.projectTags.color,
        })
        .from(s.projectTagLinks)
        .innerJoin(s.projectTags, eq(s.projectTags.id, s.projectTagLinks.projectTagId))
        .where(inArray(s.projectTagLinks.projectId, ids))
        .orderBy(asc(s.projectTags.position))
    : [];

  return {
    total: Number(rows[0]?.count ?? 0),
    data: rows.map(({ p, ...r }) => ({
      id: p.id,
      name: p.name,
      client: p.clientId ? { id: p.clientId, code: r.clientCode ?? "", name: r.clientName ?? "" } : null,
      internal: p.internal,
      modality: p.modality,
      periodicity: p.periodicity,
      type: p.typeId ? { id: p.typeId, label: r.typeLabel ?? "" } : null,
      status: p.status,
      waitingClient: p.waitingClient,
      priority: p.priority,
      startDate: p.startDate,
      deliveryDeadline: p.deliveryDeadline,
      clientDeliveryDate: p.clientDeliveryDate,
      manager: p.managerId ? { id: p.managerId, name: r.managerName ?? "", image: r.managerImage } : null,
      tags: tagRows.filter((t) => t.projectId === p.id).map(({ projectId: _, ...t }) => t),
      memberCount: Number(r.memberCount ?? 0),
      tasks: { total: Number(r.total ?? 0), done: Number(r.done ?? 0), overdue: Number(r.overdue ?? 0) },
      archived: p.archived,
      createdAt: p.createdAt.toISOString(),
      _row: p,
    })),
  };
}

async function detail(tx: AppTx, actor: Actor, id: string) {
  const { data } = await list(tx, and(eq(s.projects.id, id), projectVisibleTo(actor)));
  const base = data[0];
  if (!base) throw notFound();
  const { _row: p, ...summary } = base;

  const members = await tx
    .select({
      id: s.users.id,
      name: s.users.name,
      image: s.users.image,
      roleId: s.projectMembers.roleId,
      roleName: s.taskRoles.name,
    })
    .from(s.projectMembers)
    .innerJoin(s.users, eq(s.users.id, s.projectMembers.userId))
    .leftJoin(s.taskRoles, eq(s.taskRoles.id, s.projectMembers.roleId))
    .where(eq(s.projectMembers.projectId, id))
    .orderBy(asc(s.users.name));

  const delivered = tx
    .select({
      typeId: s.tasks.taskTypeId,
      n: sql<number>`coalesce(sum(${s.tasks.pieceQuantity}), 0)`.as("dl_n"),
    })
    .from(s.tasks)
    .where(and(eq(s.tasks.projectId, id), isNull(s.tasks.deletedAt), sql`${s.tasks.completedAt} is not null`))
    .groupBy(s.tasks.taskTypeId)
    .as("dl");
  const contractItems = await tx
    .select({
      id: s.projectContractItems.id,
      taskTypeId: s.projectContractItems.taskTypeId,
      taskTypeLabel: s.taskTypes.label,
      quantityPerPeriod: s.projectContractItems.quantityPerPeriod,
      formats: s.projectContractItems.formats,
      delivered: delivered.n,
    })
    .from(s.projectContractItems)
    .innerJoin(s.taskTypes, eq(s.taskTypes.id, s.projectContractItems.taskTypeId))
    .leftJoin(delivered, eq(delivered.typeId, s.projectContractItems.taskTypeId))
    .where(eq(s.projectContractItems.projectId, id))
    .orderBy(asc(s.projectContractItems.position));

  const phaseStats = tx
    .select({
      phaseId: s.tasks.phaseId,
      total: sql<number>`count(*)`.as("ph_total"),
      done: sql<number>`count(*) filter (where ${s.tasks.completedAt} is not null)`.as("ph_done"),
    })
    .from(s.tasks)
    .where(and(eq(s.tasks.projectId, id), isNull(s.tasks.deletedAt), eq(s.tasks.archived, false)))
    .groupBy(s.tasks.phaseId)
    .as("ph");
  const phases = await tx
    .select({ ph: s.projectPhases, total: phaseStats.total, done: phaseStats.done })
    .from(s.projectPhases)
    .leftJoin(phaseStats, eq(phaseStats.phaseId, s.projectPhases.id))
    .where(eq(s.projectPhases.projectId, id))
    .orderBy(asc(s.projectPhases.position), asc(s.projectPhases.createdAt));

  const custom = await tx
    .select()
    .from(s.projectMilestones)
    .where(eq(s.projectMilestones.projectId, id))
    .orderBy(asc(s.projectMilestones.date));
  const today = new Date().toISOString().slice(0, 10);
  const virtual = (
    [
      ["start", p.startDate],
      ["first_delivery", p.firstDeliveryDate],
      ["feedback_deadline", p.feedbackDeadline],
      ["validated", p.feedbackReceivedAt?.toISOString().slice(0, 10) ?? null],
      ["final_delivery", p.deliveryDeadline],
      ["support_start", p.supportStart],
      ["support_end", p.supportEnd],
    ] as const
  )
    .filter(([, d]) => !!d)
    .map(([kind, date]) => ({
      id: kind,
      kind,
      title: null,
      date: date!,
      completed: kind === "validated" || date! < today,
      visibleToClient: true,
    }));
  const milestones = [
    ...virtual,
    ...custom.map((m) => ({
      id: m.id,
      kind: "custom" as const,
      title: m.title,
      date: m.date,
      completed: !!m.completedAt,
      visibleToClient: m.visibleToClient,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return {
    ...summary,
    firstDeliveryDate: p.firstDeliveryDate,
    feedbackDeadline: p.feedbackDeadline,
    feedbackReceivedAt: iso(p.feedbackReceivedAt),
    supportStart: p.supportStart,
    supportEnd: p.supportEnd,
    signedAt: p.signedAt,
    contractEnd: p.contractEnd,
    contractIndefinite: p.contractIndefinite,
    deadlineText: p.deadlineText,
    valueCents: actor.can("finance.read") ? p.valueCents : null,
    recurringValueCents: actor.can("finance.read") ? p.recurringValueCents : null,
    extraCostCents: actor.can("finance.read") ? p.extraCostCents : null,
    extraCostDescription: p.extraCostDescription,
    description: p.description,
    publicSummary: p.publicSummary,
    notes: p.notes,
    duplicatedFromId: p.duplicatedFromId,
    members,
    contractItems: contractItems.map((c) => ({ ...c, delivered: Number(c.delivered ?? 0) })),
    phases: phases.map((r) => ({
      id: r.ph.id,
      name: r.ph.name,
      startDate: r.ph.startDate,
      endDate: r.ph.endDate,
      completedAt: iso(r.ph.completedAt),
      total: Number(r.total ?? 0),
      done: Number(r.done ?? 0),
    })),
    milestones,
    canManage: actor.can("projects.manage"),
  };
}

type ProjectBody = z.infer<typeof projectInput>;

/** Campos simples do projeto a partir do corpo (normaliza interno/periodicidade/descrição). */
function columnsOf(b: Partial<ProjectBody>) {
  const { tagIds: _t, members: _m, contractItems: _c, ...rest } = b;
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  );
  if (b.internal === true) out.clientId = null;
  if (b.modality === "avulso") out.periodicity = null;
  if (b.description !== undefined)
    out.descriptionText = b.description ? richTextToPlain(b.description) : null;
  return out;
}

/** Substitui tags, membros e itens de contrato quando vierem no corpo. */
async function saveRelations(
  tx: AppTx,
  tenantId: string,
  projectId: string,
  b: Partial<ProjectBody>,
  managerId?: string | null,
) {
  if (b.tagIds) {
    await tx.delete(s.projectTagLinks).where(eq(s.projectTagLinks.projectId, projectId));
    if (b.tagIds.length)
      await tx
        .insert(s.projectTagLinks)
        .values([...new Set(b.tagIds)].map((projectTagId) => ({ tenantId, projectId, projectTagId })));
  }
  if (b.members) {
    await tx.delete(s.projectMembers).where(eq(s.projectMembers.projectId, projectId));
    const m = new Map(b.members.map((x) => [x.userId, x.roleId ?? null]));
    if (m.size)
      await tx
        .insert(s.projectMembers)
        .values([...m].map(([userId, roleId]) => ({ tenantId, projectId, userId, roleId })));
  }
  // O atendimento sempre participa do projeto.
  if (managerId)
    await tx
      .insert(s.projectMembers)
      .values({ tenantId, projectId, userId: managerId })
      .onConflictDoNothing();
  if (b.contractItems) {
    await tx.delete(s.projectContractItems).where(eq(s.projectContractItems.projectId, projectId));
    if (b.contractItems.length)
      await tx
        .insert(s.projectContractItems)
        .values(b.contractItems.map((c, position) => ({ tenantId, projectId, ...c, position })));
  }
}

const shiftDate = (d: string | null, days: number) => {
  if (!d || !days) return d;
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};
const shiftTs = (d: Date | null, days: number) => (d && days ? new Date(d.getTime() + days * 86_400_000) : d);

/** Usuários ativos da equipe (para validar membros/atendimento). */
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

export const projectRoutes = (deps: Deps) => {
  const r = router();
  r.use("/projects", requireTenant(deps.dbs), teamOnly, requirePermission("projects.read"));
  r.use("/projects/*", requireTenant(deps.dbs), teamOnly, requirePermission("projects.read"));
  // Cadastro do projeto e estrutura: gestores. Comentários e arquivos: qualquer membro do projeto.
  r.on(["POST", "PATCH", "DELETE"], ["/projects", "/projects/:id"], requirePermission("projects.manage"));
  r.on(
    ["POST", "PATCH", "PUT", "DELETE"],
    [
      "/projects/:id/phases",
      "/projects/:id/phases/*",
      "/projects/:id/milestones",
      "/projects/:id/milestones/*",
    ],
    requirePermission("projects.manage"),
  );
  r.on(
    ["POST", "PUT"],
    ["/projects/:id/archive", "/projects/:id/duplicate", "/projects/:id/columns"],
    requirePermission("projects.manage"),
  );

  /** Abre a transação e confere acesso ao projeto. */
  const withProject = <T>(
    c: Parameters<typeof actorOf>[0] & {
      var: { tenant: { tx: <X>(fn: (tx: AppTx) => Promise<X>) => Promise<X> } };
    },
    id: string,
    fn: (tx: AppTx, actor: Actor) => Promise<T>,
  ) =>
    c.var.tenant.tx(async (tx) => {
      const actor = actorOf(c);
      await assertProjectAccess(tx, actor, id);
      return fn(tx, actor);
    });

  return (
    r
      .openapi(
        createRoute({
          method: "get",
          path: "/projects",
          tags,
          summary: "Projetos (filtros por status, cliente, atendimento, tipo, tag, arquivados)",
          request: { query: projectFilters },
          responses: {
            200: ok(
              z.object({
                data: z.array(ProjectSummary),
                total: z.number(),
                page: z.number(),
                pageSize: z.number(),
              }),
            ),
          },
        }),
        async (c) => {
          const f = c.req.valid("query");
          const actor = actorOf(c);
          const term = f.q ? `%${f.q.replace(/[%_\\]/g, "\\$&")}%` : null;
          const where = and(
            projectVisibleTo(actor),
            eq(s.projects.archived, f.archived ?? false),
            f.status ? eq(s.projects.status, f.status) : undefined,
            f.clientId ? eq(s.projects.clientId, f.clientId) : undefined,
            f.managerId ? eq(s.projects.managerId, f.managerId) : undefined,
            f.typeId ? eq(s.projects.typeId, f.typeId) : undefined,
            f.tagId
              ? exists(
                  sql`(select 1 from ${s.projectTagLinks} l where l.project_id = ${s.projects.id} and l.project_tag_id = ${f.tagId})`,
                )
              : undefined,
            term
              ? or(ilike(s.projects.name, term), ilike(s.clients.name, term), ilike(s.clients.code, term))
              : undefined,
          );
          const res = await c.var.tenant.tx((tx) => list(tx, where, f.page, f.pageSize));
          return c.json(
            {
              total: res.total,
              data: res.data.map(({ _row, ...p }) => p),
              page: f.page,
              pageSize: f.pageSize,
            },
            200,
          );
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/projects/{id}",
          tags,
          summary: "Projeto com membros, itens de contrato, fases e marcos",
          request: { params: IdParam },
          responses: { 200: ok(Project) },
        }),
        async (c) =>
          c.json(await c.var.tenant.tx((tx) => detail(tx, actorOf(c), c.req.valid("param").id)), 200),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/projects",
          tags,
          summary: "Criar projeto",
          request: body(z.object(projectInput.shape).openapi("ProjectInput")),
          responses: { 201: ok(Project, "Criado") },
        }),
        async (c) => {
          const b = projectInput.parse(c.req.valid("json"));
          if (!b.internal && !b.clientId)
            throw new AppError(400, "CLIENT_REQUIRED", "Projeto de cliente precisa de um cliente.");
          try {
            const project = await c.var.tenant.tx(async (tx) => {
              await assertTeamUsers(tx, [b.managerId, ...(b.members ?? []).map((m) => m.userId)]);
              const [row] = await tx
                .insert(s.projects)
                .values({
                  tenantId: c.var.tenant.tenantId,
                  ...(columnsOf(b) as { name: string; modality: "mensal" | "avulso" }),
                })
                .returning({ id: s.projects.id });
              await saveRelations(tx, c.var.tenant.tenantId, row!.id, b, b.managerId);
              await audit(c, tx, {
                entity: "project",
                entityId: row!.id,
                entityLabel: b.name,
                action: "create",
              });
              return detail(tx, actorOf(c), row!.id);
            });
            return c.json(project, 201);
          } catch (e) {
            if (isFkViolation(e)) throw badRef();
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/projects/{id}",
          tags,
          summary: "Editar projeto (status, datas, valores, membros, tags, itens de contrato)",
          request: {
            params: IdParam,
            ...body(z.object(projectInput.shape).partial().openapi("ProjectPatch")),
          },
          responses: { 200: ok(Project) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const raw = c.req.valid("json");
          const b = z.object(projectInput.shape).partial().parse(raw);
          try {
            const project = await c.var.tenant.tx(async (tx) => {
              const actor = actorOf(c);
              const before = await detail(tx, actor, id);
              await assertTeamUsers(tx, [b.managerId, ...(b.members ?? []).map((m) => m.userId)]);
              const patch = columnsOf(b);
              const internal = b.internal ?? before.internal;
              const clientId = b.clientId === undefined ? before.client?.id : b.clientId;
              if (!internal && !clientId)
                throw new AppError(400, "CLIENT_REQUIRED", "Projeto de cliente precisa de um cliente.");
              if (Object.keys(patch).length)
                await tx
                  .update(s.projects)
                  .set({ ...patch, updatedAt: new Date() })
                  .where(eq(s.projects.id, id));
              await saveRelations(tx, actor.tenantId, id, b, b.managerId);
              const { description: _d, descriptionText: _dt, ...loggable } = patch;
              const changes = diff(before as unknown as Record<string, unknown>, loggable);
              if (b.description !== undefined) changes.description = { from: "…", to: "…" };
              if (b.status && b.status !== before.status)
                await audit(c, tx, {
                  entity: "project",
                  entityId: id,
                  entityLabel: b.name ?? before.name,
                  action: "status_change",
                  details: { from: before.status, to: b.status },
                });
              else if (Object.keys(changes).length || b.members || b.tagIds || b.contractItems)
                await audit(c, tx, {
                  entity: "project",
                  entityId: id,
                  entityLabel: b.name ?? before.name,
                  action: "update",
                  details: changes,
                });
              return detail(tx, actor, id);
            });
            return c.json(project, 200);
          } catch (e) {
            if (isFkViolation(e)) throw badRef();
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/projects/{id}",
          tags,
          summary: "Excluir projeto (e suas tarefas)",
          request: { params: IdParam },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          await withProject(c, id, async (tx) => {
            const now = new Date();
            const [p] = await tx
              .update(s.projects)
              .set({ deletedAt: now })
              .where(eq(s.projects.id, id))
              .returning({ name: s.projects.name });
            await tx
              .update(s.tasks)
              .set({ deletedAt: now })
              .where(and(eq(s.tasks.projectId, id), isNull(s.tasks.deletedAt)));
            await audit(c, tx, { entity: "project", entityId: id, entityLabel: p?.name, action: "delete" });
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/projects/{id}/archive",
          tags,
          summary: "Arquivar ou desarquivar projeto",
          request: { params: IdParam, ...body(z.object({ archived: z.boolean() })) },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { archived } = c.req.valid("json");
          await withProject(c, id, async (tx) => {
            const [p] = await tx
              .update(s.projects)
              .set({ archived, archivedAt: archived ? new Date() : null, updatedAt: new Date() })
              .where(eq(s.projects.id, id))
              .returning({ name: s.projects.name });
            await audit(c, tx, {
              entity: "project",
              entityId: id,
              entityLabel: p?.name,
              action: archived ? "archive" : "unarchive",
            });
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/projects/{id}/duplicate",
          tags,
          summary: "Duplicar projeto (estrutura; tarefas opcionais consomem cota)",
          request: {
            params: IdParam,
            ...body(z.object(duplicateProjectInput.shape).openapi("DuplicateProject")),
          },
          responses: { 201: ok(z.object({ id: z.uuid(), tasksCopied: z.number() }), "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const opt = duplicateProjectInput.parse(c.req.valid("json"));
          const d = opt.shiftDays;
          const res = await withProject(c, id, async (tx, actor) => {
            const tenantId = actor.tenantId;
            const [p] = await tx.select().from(s.projects).where(eq(s.projects.id, id));
            if (!p) throw notFound();
            const {
              id: _id,
              createdAt: _c,
              updatedAt: _u,
              deletedAt: _del,
              archived: _a,
              archivedAt: _aa,
              ...fields
            } = p;
            const [copy] = await tx
              .insert(s.projects)
              .values({
                ...fields,
                name: opt.name,
                status: ["concluido", "entregue_suporte"].includes(p.status) ? "ativo" : p.status,
                waitingClient: false,
                duplicatedFromId: p.id,
                startDate: shiftDate(p.startDate, d),
                deliveryDeadline: shiftDate(p.deliveryDeadline, d),
                clientDeliveryDate: shiftDate(p.clientDeliveryDate, d),
                firstDeliveryDate: shiftDate(p.firstDeliveryDate, d),
                feedbackDeadline: shiftDate(p.feedbackDeadline, d),
                feedbackReceivedAt: null,
                supportStart: shiftDate(p.supportStart, d),
                supportEnd: shiftDate(p.supportEnd, d),
                contractEnd: shiftDate(p.contractEnd, d),
              })
              .returning({ id: s.projects.id });
            const newId = copy!.id;

            const members = await tx
              .select()
              .from(s.projectMembers)
              .where(eq(s.projectMembers.projectId, id));
            if (members.length)
              await tx
                .insert(s.projectMembers)
                .values(
                  members.map((m) => ({ tenantId, projectId: newId, userId: m.userId, roleId: m.roleId })),
                );
            const tagLinks = await tx
              .select()
              .from(s.projectTagLinks)
              .where(eq(s.projectTagLinks.projectId, id));
            if (tagLinks.length)
              await tx
                .insert(s.projectTagLinks)
                .values(tagLinks.map((t) => ({ tenantId, projectId: newId, projectTagId: t.projectTagId })));
            const items = await tx
              .select()
              .from(s.projectContractItems)
              .where(eq(s.projectContractItems.projectId, id));
            if (items.length)
              await tx.insert(s.projectContractItems).values(
                items.map((i) => ({
                  tenantId,
                  projectId: newId,
                  taskTypeId: i.taskTypeId,
                  quantityPerPeriod: i.quantityPerPeriod,
                  formats: i.formats,
                  position: i.position,
                })),
              );
            const cols = await tx
              .select()
              .from(s.projectKanbanColumns)
              .where(eq(s.projectKanbanColumns.projectId, id));
            if (cols.length)
              await tx.insert(s.projectKanbanColumns).values(cols.map((k) => ({ ...k, projectId: newId })));
            const phases = await tx.select().from(s.projectPhases).where(eq(s.projectPhases.projectId, id));
            const phaseMap = new Map<string, string>();
            for (const ph of phases) {
              const [n] = await tx
                .insert(s.projectPhases)
                .values({
                  tenantId,
                  projectId: newId,
                  name: ph.name,
                  startDate: shiftDate(ph.startDate, d),
                  endDate: shiftDate(ph.endDate, d),
                  position: ph.position,
                })
                .returning({ id: s.projectPhases.id });
              phaseMap.set(ph.id, n!.id);
            }
            const ms = await tx
              .select()
              .from(s.projectMilestones)
              .where(eq(s.projectMilestones.projectId, id));
            if (ms.length)
              await tx.insert(s.projectMilestones).values(
                ms.map((m) => ({
                  tenantId,
                  projectId: newId,
                  title: m.title,
                  date: shiftDate(m.date, d)!,
                  visibleToClient: m.visibleToClient,
                })),
              );

            let tasksCopied = 0;
            let quota: Awaited<ReturnType<typeof createTask>>["quota"] | null = null;
            if (opt.includeTasks) {
              const tasks = await tx
                .select()
                .from(s.tasks)
                .where(and(eq(s.tasks.projectId, id), isNull(s.tasks.deletedAt), eq(s.tasks.archived, false)))
                .orderBy(asc(s.tasks.createdAt));
              for (const t of tasks) {
                const assignees = await tx
                  .select({ userId: s.taskAssignees.userId, roleId: s.taskAssignees.roleId })
                  .from(s.taskAssignees)
                  .where(eq(s.taskAssignees.taskId, t.id));
                const tagIds = (
                  await tx
                    .select({ id: s.taskTags.tagId })
                    .from(s.taskTags)
                    .where(eq(s.taskTags.taskId, t.id))
                ).map((x) => x.id);
                const checklist = (
                  await tx
                    .select({ text: s.taskSubitems.text })
                    .from(s.taskSubitems)
                    .where(eq(s.taskSubitems.taskId, t.id))
                    .orderBy(asc(s.taskSubitems.position))
                ).map((x) => x.text);
                const created = await createTask(tx, actor, {
                  title: t.title,
                  projectId: newId,
                  phaseId: t.phaseId ? (phaseMap.get(t.phaseId) ?? null) : null,
                  description: t.description,
                  descriptionText: t.descriptionText,
                  assigneeId: t.assigneeId,
                  mainRoleId: t.mainRoleId,
                  taskTypeId: t.taskTypeId,
                  approverId: t.approverId,
                  assignees,
                  tagIds,
                  driveLink: t.driveLink,
                  deadline: shiftTs(t.deadline, d),
                  deadlineHasTime: t.deadlineHasTime,
                  clientDeliveryDate: shiftDate(t.clientDeliveryDate, d),
                  priority: t.priority,
                  visibleToClient: t.visibleToClient,
                  estimatedHours: t.estimatedHours,
                  pieceQuantity: t.pieceQuantity,
                  checklist,
                  source: "duplicate",
                  silent: true,
                  trusted: true,
                });
                quota = created.quota;
                tasksCopied++;
              }
            }
            await audit(c, tx, {
              entity: "project",
              entityId: newId,
              entityLabel: opt.name,
              action: "duplicate",
              details: { from: p.id, fromName: p.name, tasksCopied, shiftDays: d },
            });
            return { id: newId, tasksCopied, quota };
          });
          if (res.quota?.warnings.length && res.quota.limit)
            await sendUsageWarnings(
              deps,
              c.var.tenant.tenantId,
              res.quota.warnings,
              res.quota.used,
              res.quota.limit,
            );
          return c.json({ id: res.id, tasksCopied: res.tasksCopied }, 201);
        },
      )
      // ---------- Fases ----------
      .openapi(
        createRoute({
          method: "post",
          path: "/projects/{id}/phases",
          tags,
          summary: "Criar fase",
          request: { params: IdParam, ...body(z.object(phaseInput.shape).openapi("PhaseInput")) },
          responses: { 201: ok(z.object({ id: z.uuid() }), "Criada") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const row = await withProject(c, id, async (tx, actor) => {
            const [{ n } = { n: 0 }] = await tx
              .select({ n: sql<number>`coalesce(max(${s.projectPhases.position}), -1) + 1` })
              .from(s.projectPhases)
              .where(eq(s.projectPhases.projectId, id));
            const [ph] = await tx
              .insert(s.projectPhases)
              .values({
                tenantId: actor.tenantId,
                projectId: id,
                name: b.name,
                startDate: b.startDate ?? null,
                endDate: b.endDate ?? null,
                completedAt: b.completed ? new Date() : null,
                position: Number(n),
              })
              .returning({ id: s.projectPhases.id });
            return ph!;
          });
          return c.json(row, 201);
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/projects/{id}/phases/{subId}",
          tags,
          summary: "Editar fase",
          request: { params: SubParam, ...body(z.object(phaseInput.shape).partial()) },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          const b = c.req.valid("json");
          await withProject(c, id, async (tx) => {
            const res = await tx
              .update(s.projectPhases)
              .set({
                ...(b.name !== undefined ? { name: b.name } : {}),
                ...(b.startDate !== undefined ? { startDate: b.startDate } : {}),
                ...(b.endDate !== undefined ? { endDate: b.endDate } : {}),
                ...(b.completed !== undefined ? { completedAt: b.completed ? new Date() : null } : {}),
                updatedAt: new Date(),
              })
              .where(and(eq(s.projectPhases.id, subId), eq(s.projectPhases.projectId, id)))
              .returning({ id: s.projectPhases.id });
            if (!res.length) throw new AppError(404, "NOT_FOUND", "Fase não encontrada.");
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/projects/{id}/phases/{subId}",
          tags,
          summary: "Excluir fase (as tarefas ficam sem fase)",
          request: { params: SubParam },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          await withProject(c, id, async (tx) => {
            await tx.update(s.tasks).set({ phaseId: null }).where(eq(s.tasks.phaseId, subId));
            await tx
              .delete(s.projectPhases)
              .where(and(eq(s.projectPhases.id, subId), eq(s.projectPhases.projectId, id)));
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/projects/{id}/phases/order",
          tags,
          summary: "Reordenar fases",
          request: { params: IdParam, ...body(z.object(reorderInput.shape)) },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { ids } = c.req.valid("json");
          await withProject(c, id, async (tx) => {
            await tx
              .update(s.projectPhases)
              .set({ position: sql`array_position(${sql.param(ids)}::uuid[], ${s.projectPhases.id}) - 1` })
              .where(and(eq(s.projectPhases.projectId, id), inArray(s.projectPhases.id, ids)));
          });
          return c.body(null, 204);
        },
      )
      // ---------- Marcos ----------
      .openapi(
        createRoute({
          method: "post",
          path: "/projects/{id}/milestones",
          tags,
          summary: "Criar marco",
          request: { params: IdParam, ...body(z.object(milestoneInput.shape).openapi("MilestoneInput")) },
          responses: { 201: ok(z.object({ id: z.uuid() }), "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const row = await withProject(c, id, async (tx, actor) => {
            const [m] = await tx
              .insert(s.projectMilestones)
              .values({
                tenantId: actor.tenantId,
                projectId: id,
                title: b.title,
                date: b.date,
                completedAt: b.completed ? new Date() : null,
                visibleToClient: b.visibleToClient ?? true,
              })
              .returning({ id: s.projectMilestones.id });
            return m!;
          });
          return c.json(row, 201);
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/projects/{id}/milestones/{subId}",
          tags,
          summary: "Editar marco",
          request: { params: SubParam, ...body(z.object(milestoneInput.shape).partial()) },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          const b = c.req.valid("json");
          await withProject(c, id, async (tx) => {
            const res = await tx
              .update(s.projectMilestones)
              .set({
                ...(b.title !== undefined ? { title: b.title } : {}),
                ...(b.date !== undefined ? { date: b.date } : {}),
                ...(b.visibleToClient !== undefined ? { visibleToClient: b.visibleToClient } : {}),
                ...(b.completed !== undefined ? { completedAt: b.completed ? new Date() : null } : {}),
                updatedAt: new Date(),
              })
              .where(and(eq(s.projectMilestones.id, subId), eq(s.projectMilestones.projectId, id)))
              .returning({ id: s.projectMilestones.id });
            if (!res.length) throw new AppError(404, "NOT_FOUND", "Marco não encontrado.");
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/projects/{id}/milestones/{subId}",
          tags,
          summary: "Excluir marco",
          request: { params: SubParam },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          await withProject(c, id, (tx) =>
            tx
              .delete(s.projectMilestones)
              .where(and(eq(s.projectMilestones.id, subId), eq(s.projectMilestones.projectId, id))),
          );
          return c.body(null, 204);
        },
      )
      // ---------- Comentários ----------
      .openapi(
        createRoute({
          method: "get",
          path: "/projects/{id}/comments",
          tags,
          summary: "Comentários do projeto (mais recentes primeiro)",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ data: z.array(Comment) })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const data = await withProject(c, id, async (tx, actor) => {
            const rows = await tx
              .select({ cm: s.projectComments, name: s.users.name, image: s.users.image })
              .from(s.projectComments)
              .leftJoin(s.users, eq(s.users.id, s.projectComments.authorId))
              .where(and(eq(s.projectComments.projectId, id), isNull(s.projectComments.deletedAt)))
              .orderBy(desc(s.projectComments.createdAt))
              .limit(500);
            return rows.map(({ cm, name, image }) => ({
              id: cm.id,
              author: cm.authorId ? { id: cm.authorId, name: name ?? "", image } : null,
              body: cm.body,
              bodyText: cm.bodyText,
              visibleToClient: cm.visibleToClient,
              editedAt: iso(cm.editedAt),
              createdAt: cm.createdAt.toISOString(),
              mine: cm.authorId === actor.userId,
            }));
          });
          return c.json({ data }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/projects/{id}/comments",
          tags,
          summary: "Comentar (com opção de mostrar ao cliente no portal)",
          request: { params: IdParam, ...body(z.object(commentInput.shape).openapi("CommentInput")) },
          responses: { 201: ok(z.object({ id: z.uuid() }), "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const text = richTextToPlain(b.body);
          if (!text) throw new AppError(400, "VALIDATION", "Escreva o comentário.");
          const row = await withProject(c, id, async (tx, actor) => {
            const [cm] = await tx
              .insert(s.projectComments)
              .values({
                tenantId: actor.tenantId,
                projectId: id,
                authorId: actor.userId,
                body: b.body,
                bodyText: text,
                visibleToClient: b.visibleToClient ?? false,
              })
              .returning({ id: s.projectComments.id });
            return cm!;
          });
          return c.json(row, 201);
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/projects/{id}/comments/{subId}",
          tags,
          summary: "Editar comentário (autor) ou a visibilidade (autor/gestor)",
          request: { params: SubParam, ...body(z.object(commentInput.shape).partial()) },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          const b = c.req.valid("json");
          await withProject(c, id, async (tx, actor) => {
            const [cm] = await tx
              .select()
              .from(s.projectComments)
              .where(
                and(
                  eq(s.projectComments.id, subId),
                  eq(s.projectComments.projectId, id),
                  isNull(s.projectComments.deletedAt),
                ),
              );
            if (!cm) throw new AppError(404, "NOT_FOUND", "Comentário não encontrado.");
            const mine = cm.authorId === actor.userId;
            if (b.body && !mine) throw new AppError(403, "FORBIDDEN", "Só o autor edita o comentário.");
            if (!mine && !actor.can("projects.manage"))
              throw new AppError(403, "FORBIDDEN", "Você não pode alterar este comentário.");
            await tx
              .update(s.projectComments)
              .set({
                ...(b.body ? { body: b.body, bodyText: richTextToPlain(b.body), editedAt: new Date() } : {}),
                ...(b.visibleToClient !== undefined ? { visibleToClient: b.visibleToClient } : {}),
                updatedAt: new Date(),
              })
              .where(eq(s.projectComments.id, subId));
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/projects/{id}/comments/{subId}",
          tags,
          summary: "Excluir comentário (autor ou gestor)",
          request: { params: SubParam },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          await withProject(c, id, async (tx, actor) => {
            const [cm] = await tx
              .select({ authorId: s.projectComments.authorId })
              .from(s.projectComments)
              .where(and(eq(s.projectComments.id, subId), eq(s.projectComments.projectId, id)));
            if (!cm) throw new AppError(404, "NOT_FOUND", "Comentário não encontrado.");
            if (cm.authorId !== actor.userId && !actor.can("projects.manage"))
              throw new AppError(403, "FORBIDDEN", "Você não pode excluir este comentário.");
            await tx
              .update(s.projectComments)
              .set({ deletedAt: new Date() })
              .where(eq(s.projectComments.id, subId));
          });
          return c.body(null, 204);
        },
      )
      // ---------- Arquivos ----------
      .openapi(
        createRoute({
          method: "get",
          path: "/projects/{id}/files",
          tags,
          summary: "Pastas e anexos (arquivos e links) do projeto",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ folders: z.array(Folder), attachments: z.array(Attachment) })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const res = await withProject(c, id, async (tx) => {
            const folders = await tx
              .select({
                id: s.projectFolders.id,
                parentId: s.projectFolders.parentId,
                name: s.projectFolders.name,
                visibleToClient: s.projectFolders.visibleToClient,
              })
              .from(s.projectFolders)
              .where(eq(s.projectFolders.projectId, id))
              .orderBy(asc(s.projectFolders.name));
            const rows = await tx
              .select({ a: s.projectAttachments, f: s.files, uname: s.users.name, uimage: s.users.image })
              .from(s.projectAttachments)
              .leftJoin(s.files, eq(s.files.id, s.projectAttachments.fileId))
              .leftJoin(s.users, eq(s.users.id, s.projectAttachments.createdBy))
              .where(and(eq(s.projectAttachments.projectId, id), isNull(s.projectAttachments.deletedAt)))
              .orderBy(desc(s.projectAttachments.createdAt));
            return {
              folders,
              attachments: rows.map(({ a, f, uname, uimage }) => ({
                id: a.id,
                folderId: a.folderId,
                name: a.name,
                url: a.url,
                file: f
                  ? { id: f.id, mimeType: f.mimeType, sizeBytes: f.sizeBytes, scanStatus: f.scanStatus }
                  : null,
                visibleToClient: a.visibleToClient,
                createdBy: a.createdBy ? { id: a.createdBy, name: uname ?? "", image: uimage } : null,
                createdAt: a.createdAt.toISOString(),
              })),
            };
          });
          return c.json(res, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/projects/{id}/folders",
          tags,
          summary: "Criar pasta",
          request: { params: IdParam, ...body(z.object(folderInput.shape).openapi("FolderInput")) },
          responses: { 201: ok(z.object({ id: z.uuid() }), "Criada") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          try {
            const row = await withProject(c, id, async (tx, actor) => {
              const [f] = await tx
                .insert(s.projectFolders)
                .values({
                  tenantId: actor.tenantId,
                  projectId: id,
                  name: b.name,
                  parentId: b.parentId ?? null,
                  visibleToClient: b.visibleToClient ?? false,
                })
                .returning({ id: s.projectFolders.id });
              return f!;
            });
            return c.json(row, 201);
          } catch (e) {
            if (isFkViolation(e)) throw badRef();
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/projects/{id}/folders/{subId}",
          tags,
          summary: "Renomear pasta ou mudar a visibilidade",
          request: { params: SubParam, ...body(z.object(folderInput.shape).partial()) },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          const b = c.req.valid("json");
          if (b.parentId === subId)
            throw new AppError(400, "VALIDATION", "A pasta não pode ficar dentro dela mesma.");
          await withProject(c, id, async (tx) => {
            await tx
              .update(s.projectFolders)
              .set({
                ...(b.name !== undefined ? { name: b.name } : {}),
                ...(b.parentId !== undefined ? { parentId: b.parentId } : {}),
                ...(b.visibleToClient !== undefined ? { visibleToClient: b.visibleToClient } : {}),
                updatedAt: new Date(),
              })
              .where(and(eq(s.projectFolders.id, subId), eq(s.projectFolders.projectId, id)));
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/projects/{id}/folders/{subId}",
          tags,
          summary: "Excluir pasta e o que há dentro",
          request: { params: SubParam },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          await withProject(c, id, (tx) =>
            tx
              .delete(s.projectFolders)
              .where(and(eq(s.projectFolders.id, subId), eq(s.projectFolders.projectId, id))),
          );
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/projects/{id}/attachments",
          tags,
          summary: "Anexar arquivo enviado ou link externo",
          request: { params: IdParam, ...body(z.object(attachmentInput.shape).openapi("AttachmentInput")) },
          responses: { 201: ok(z.object({ id: z.uuid() }), "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = attachmentInput.parse(c.req.valid("json"));
          try {
            const row = await withProject(c, id, async (tx, actor) => {
              let name = b.name;
              if (b.fileId) {
                const [f] = await tx
                  .select({ name: s.files.originalName })
                  .from(s.files)
                  .where(and(eq(s.files.id, b.fileId), isNull(s.files.deletedAt)));
                if (!f) throw badRef();
                name ??= f.name;
              }
              const [a] = await tx
                .insert(s.projectAttachments)
                .values({
                  tenantId: actor.tenantId,
                  projectId: id,
                  folderId: b.folderId ?? null,
                  fileId: b.fileId ?? null,
                  url: b.url ?? null,
                  name: name ?? b.url ?? "Link",
                  visibleToClient: b.visibleToClient ?? false,
                  createdBy: actor.userId,
                })
                .returning({ id: s.projectAttachments.id });
              return a!;
            });
            return c.json(row, 201);
          } catch (e) {
            if (isFkViolation(e)) throw badRef();
            throw e;
          }
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/projects/{id}/attachments/{subId}",
          tags,
          summary: "Renomear, mover de pasta ou mudar a visibilidade do anexo",
          request: {
            params: SubParam,
            ...body(
              z.object({
                name: z.string().trim().min(1).max(255).optional(),
                folderId: z.uuid().nullable().optional(),
                visibleToClient: z.boolean().optional(),
              }),
            ),
          },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          const b = c.req.valid("json");
          try {
            await withProject(c, id, (tx) =>
              tx
                .update(s.projectAttachments)
                .set(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)))
                .where(and(eq(s.projectAttachments.id, subId), eq(s.projectAttachments.projectId, id))),
            );
          } catch (e) {
            if (isFkViolation(e)) throw badRef();
            throw e;
          }
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/projects/{id}/attachments/{subId}",
          tags,
          summary: "Remover anexo (quem enviou ou gestor)",
          request: { params: SubParam },
          responses: noContent,
        }),
        async (c) => {
          const { id, subId } = c.req.valid("param");
          await withProject(c, id, async (tx, actor) => {
            const [a] = await tx
              .select({ createdBy: s.projectAttachments.createdBy, name: s.projectAttachments.name })
              .from(s.projectAttachments)
              .where(and(eq(s.projectAttachments.id, subId), eq(s.projectAttachments.projectId, id)));
            if (!a) throw new AppError(404, "NOT_FOUND", "Anexo não encontrado.");
            if (a.createdBy !== actor.userId && !actor.can("projects.manage"))
              throw new AppError(403, "FORBIDDEN", "Você não pode remover este anexo.");
            await tx
              .update(s.projectAttachments)
              .set({ deletedAt: new Date() })
              .where(eq(s.projectAttachments.id, subId));
            await audit(c, tx, {
              entity: "project",
              entityId: id,
              entityLabel: a.name,
              action: "attachment_delete",
            });
          });
          return c.body(null, 204);
        },
      )
      // ---------- Colunas do Kanban do projeto ----------
      .openapi(
        createRoute({
          method: "get",
          path: "/projects/{id}/columns",
          tags,
          summary: "Colunas do Kanban neste projeto (com rótulo e visibilidade próprios)",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ data: z.array(Column) })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const data = await withProject(c, id, (tx) => projectColumns(tx, id));
          return c.json({ data }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/projects/{id}/columns",
          tags,
          summary: "Personalizar colunas do projeto (visibilidade, rótulo, ordem)",
          request: { params: IdParam, ...body(z.object(projectColumnsInput.shape)) },
          responses: { 200: ok(z.object({ data: z.array(Column) })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { columns } = c.req.valid("json");
          try {
            const data = await withProject(c, id, async (tx, actor) => {
              await tx.delete(s.projectKanbanColumns).where(eq(s.projectKanbanColumns.projectId, id));
              if (columns.length)
                await tx.insert(s.projectKanbanColumns).values(
                  columns.map((col, position) => ({
                    tenantId: actor.tenantId,
                    projectId: id,
                    columnKey: col.key,
                    visible: col.visible,
                    labelOverride: col.labelOverride || null,
                    position,
                  })),
                );
              return projectColumns(tx, id);
            });
            return c.json({ data }, 200);
          } catch (e) {
            if (isFkViolation(e)) throw badRef();
            throw e;
          }
        },
      )
  );
};

/** Colunas ativas do tenant com as personalizações do projeto (ordem do projeto, se houver). */
export async function projectColumns(tx: AppTx, projectId: string | null) {
  const cols = await tx
    .select()
    .from(s.kanbanColumns)
    .where(eq(s.kanbanColumns.active, true))
    .orderBy(asc(s.kanbanColumns.position));
  const over = projectId
    ? await tx.select().from(s.projectKanbanColumns).where(eq(s.projectKanbanColumns.projectId, projectId))
    : [];
  const byKey = new Map(over.map((o) => [o.columnKey, o]));
  return cols
    .map((col, i) => {
      const o = byKey.get(col.key);
      return {
        key: col.key,
        label: o?.labelOverride || col.label,
        labelOverride: o?.labelOverride ?? null,
        emoji: col.emoji,
        color: col.color,
        isFinal: col.isFinal,
        isApproval: col.isApproval,
        visible: o?.visible ?? true,
        _pos: o?.position ?? 1000 + i,
      };
    })
    .sort((a, b) => a._pos - b._pos)
    .map(({ _pos, ...col }) => col);
}
