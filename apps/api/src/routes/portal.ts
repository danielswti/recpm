/**
 * Portal do cliente (§6.11) e a fila de demandas da equipe.
 *
 * Portal (`/portal/*`, só papel cliente, plano com `clientPortal`):
 *   - leituras na transação do cliente: o RLS já limita ao próprio cliente e aos itens visíveis;
 *   - ações que mexem no fluxo (aprovar, pedir ajuste, criar tarefa) rodam numa transação do tenant
 *     sem o filtro do portal, DEPOIS de conferir na transação do cliente que ele vê o item, porque
 *     o fluxo grava ajustes, histórico e avisos para a equipe, que o portal não enxerga;
 *   - valores, horas e dados internos nunca saem: as consultas escolhem as colunas.
 * Equipe (`/demands`): fila das demandas abertas no portal; aceitar cria a tarefa em "Demandas"
 * (conta na cota) e recusar pede um motivo. O cliente é avisado nos dois casos.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  type Actor,
  assertFeature,
  audit,
  createTask,
  loadEntitlements,
  moveTask,
  notify,
} from "@recpm/core";
import { type AppTx, schema, withTenant } from "@recpm/db";
import { plainToRichText, richTextToPlain } from "@recpm/shared";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError } from "../lib/errors";
import { router } from "../lib/router";
import { createStorage } from "../lib/storage";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";
import type { AppEnv } from "../types";

const s = schema;
const tags = ["Portal do cliente"];
const out = <T>(description: string) => z.custom<T>().openapi({ type: "object", description });
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const IdParam = z.object({ id: z.uuid() });
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ymd = (d: unknown) => (d ? String(d) : null);

const text = (max: number) => z.string().trim().min(1).max(max);
const commentInput = z.object({ body: text(5000) });
const portalTaskInput = z.object({
  title: text(300),
  description: z.string().trim().max(5000).nullable().optional(),
  taskTypeId: z.uuid().nullable().optional(),
  clientDeliveryDate: z.iso.date().nullable().optional(),
});
const changesInput = z.object({ reasonId: z.uuid().nullable().optional(), description: text(2000) });
const demandInput = z.object({
  title: text(300),
  description: z.string().trim().max(5000).nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  desiredDate: z.iso.date().nullable().optional(),
  briefing: z
    .object({
      formId: z.uuid(),
      answers: z.record(z.string(), z.union([z.string().max(5000), z.array(z.string().max(500)).max(50)])),
    })
    .nullable()
    .optional(),
});
const acceptInput = z.object({
  projectId: z.uuid().nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  taskTypeId: z.uuid().nullable().optional(),
  deadline: z.iso.datetime({ offset: true }).nullable().optional(),
});
const rejectInput = z.object({ reason: text(1000) });

// ── tipos de saída (o cliente web usa estes tipos) ─────────────────────────────
type PortalTaskItem = {
  id: string;
  title: string;
  projectId: string | null;
  statusKey: string;
  statusLabel: string;
  isDone: boolean;
  awaitingClient: boolean;
  clientDeliveryDate: string | null;
  taskType: string | null;
  pieceQuantity: number;
  createdByMe: boolean;
  createdAt: string;
  updatedAt: string;
};
type PortalProject = {
  id: string;
  name: string;
  status: string;
  modality: string;
  publicSummary: string | null;
  startDate: string | null;
  clientDeliveryDate: string | null;
  progress: { done: number; total: number; pct: number };
  nextMilestone: { title: string; date: string } | null;
  awaitingClient: number;
};
type Comment = {
  id: string;
  author: string | null;
  mine: boolean;
  fromClient: boolean;
  body: string;
  createdAt: string;
};
type Demand = {
  id: string;
  title: string;
  description: string | null;
  project: { id: string; name: string } | null;
  desiredDate: string | null;
  status: "pending" | "accepted" | "rejected";
  rejectionReason: string | null;
  taskId: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export const portalRoutes = (deps: Deps) => {
  const r = router();
  const storage = deps.storage === undefined ? createStorage(deps.env) : deps.storage;

  /** Transação do tenant sem o filtro do portal: só depois de conferir o acesso em `mine`. */
  const tenantTx = <T>(c: Context<AppEnv>, fn: (tx: AppTx) => Promise<T>) =>
    withTenant(deps.dbs.appDb, { tenantId: c.var.tenant.tenantId, userId: c.var.tenant.userId }, fn);

  const portalOnly = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const t = c.var.tenant;
    if (t.role !== "cliente" || !t.clientId)
      throw new AppError(403, "PORTAL_ONLY", "Esta área é do portal do cliente.");
    // a assinatura do plano não é visível para o cliente: confere fora do filtro do portal
    await tenantTx(c, async (tx) => assertFeature(await loadEntitlements(tx), "clientPortal"));
    await next();
  };
  r.use("/portal/*", requireTenant(deps.dbs), portalOnly);
  r.use("/demands", requireTenant(deps.dbs), teamOnly, requirePermission("tasks.create"));
  r.use("/demands/*", requireTenant(deps.dbs), teamOnly, requirePermission("tasks.create"));

  /** Transação do cliente (RLS do portal). */
  const mine = <T>(c: Context<AppEnv>, fn: (tx: AppTx) => Promise<T>) => c.var.tenant.tx(fn);
  const columns = async (tx: AppTx) => {
    const cols = await tx
      .select({ key: s.kanbanColumns.key, label: s.kanbanColumns.label, isFinal: s.kanbanColumns.isFinal })
      .from(s.kanbanColumns);
    return new Map(cols.map((x) => [x.key, x]));
  };

  const taskItems = async (tx: AppTx, userId: string, where: Parameters<typeof and>[0]) => {
    const rows = await tx
      .select({
        id: s.tasks.id,
        title: s.tasks.title,
        projectId: s.tasks.projectId,
        statusKey: s.tasks.statusKey,
        clientDeliveryDate: s.tasks.clientDeliveryDate,
        type: s.taskTypes.label,
        pieceQuantity: s.tasks.pieceQuantity,
        createdById: s.tasks.createdById,
        createdAt: s.tasks.createdAt,
        updatedAt: s.tasks.updatedAt,
      })
      .from(s.tasks)
      .leftJoin(s.taskTypes, eq(s.taskTypes.id, s.tasks.taskTypeId))
      .where(and(where, eq(s.tasks.archived, false), isNull(s.tasks.deletedAt)))
      .orderBy(desc(s.tasks.updatedAt));
    const cols = await columns(tx);
    return rows.map(
      (t): PortalTaskItem => ({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        statusKey: t.statusKey,
        statusLabel: cols.get(t.statusKey)?.label ?? t.statusKey,
        isDone: !!cols.get(t.statusKey)?.isFinal,
        awaitingClient: t.statusKey === "aguardando_cliente",
        clientDeliveryDate: ymd(t.clientDeliveryDate),
        taskType: t.type,
        pieceQuantity: t.pieceQuantity,
        createdByMe: t.createdById === userId,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      }),
    );
  };

  /** Projetos do cliente com progresso (contado sobre as tarefas visíveis para ele). */
  const projectsOut = async (c: Context<AppEnv>, ids?: string[]): Promise<PortalProject[]> => {
    const rows = await mine(c, (tx) =>
      tx
        .select({
          id: s.projects.id,
          name: s.projects.name,
          status: s.projects.status,
          modality: s.projects.modality,
          publicSummary: s.projects.publicSummary,
          startDate: s.projects.startDate,
          clientDeliveryDate: s.projects.clientDeliveryDate,
        })
        .from(s.projects)
        .where(and(eq(s.projects.archived, false), ids ? inArray(s.projects.id, ids) : undefined))
        .orderBy(asc(s.projects.name)),
    );
    if (!rows.length) return [];
    const pids = rows.map((p) => p.id);
    const stats = await tenantTx(c, async (tx) => {
      const counts = await tx.execute<{
        project_id: string;
        total: number;
        done: number;
        awaiting: number;
      }>(sql`
        SELECT t.project_id, count(*)::int AS total,
               count(*) FILTER (WHERE k.is_final)::int AS done,
               count(*) FILTER (WHERE t.status_key = 'aguardando_cliente')::int AS awaiting
          FROM tasks t LEFT JOIN kanban_columns k ON k.key = t.status_key AND k.tenant_id = t.tenant_id
         WHERE t.project_id IN (${sql.join(
           pids.map((x) => sql`${x}::uuid`),
           sql`, `,
         )}) AND t.visible_to_client AND t.deleted_at IS NULL AND NOT t.archived
         GROUP BY t.project_id`);
      const ms = await tx
        .select({
          projectId: s.projectMilestones.projectId,
          title: s.projectMilestones.title,
          date: s.projectMilestones.date,
        })
        .from(s.projectMilestones)
        .where(
          and(
            inArray(s.projectMilestones.projectId, pids),
            eq(s.projectMilestones.visibleToClient, true),
            isNull(s.projectMilestones.completedAt),
          ),
        )
        .orderBy(asc(s.projectMilestones.date));
      return { counts: counts.rows, ms };
    });
    return rows.map((p) => {
      const k = stats.counts.find((x) => x.project_id === p.id);
      const total = k?.total ?? 0;
      const done = k?.done ?? 0;
      const m = stats.ms.find((x) => x.projectId === p.id);
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        modality: p.modality,
        publicSummary: p.publicSummary,
        startDate: ymd(p.startDate),
        clientDeliveryDate: ymd(p.clientDeliveryDate),
        progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 },
        nextMilestone: m ? { title: m.title, date: String(m.date) } : null,
        awaitingClient: k?.awaiting ?? 0,
      };
    });
  };

  /** Confere (na transação do cliente) que a tarefa é visível para ele. */
  const visibleTask = async (c: Context<AppEnv>, id: string) => {
    const [t] = await mine(c, (tx) =>
      tx
        .select({
          id: s.tasks.id,
          title: s.tasks.title,
          statusKey: s.tasks.statusKey,
          projectId: s.tasks.projectId,
          createdById: s.tasks.createdById,
        })
        .from(s.tasks)
        .where(and(eq(s.tasks.id, id), isNull(s.tasks.deletedAt))),
    );
    if (!t) throw new AppError(404, "TASK_NOT_FOUND", "Tarefa não encontrada.");
    return t;
  };
  const visibleProject = async (c: Context<AppEnv>, id: string) => {
    const [p] = await mine(c, (tx) =>
      tx
        .select({ id: s.projects.id, name: s.projects.name, managerId: s.projects.managerId })
        .from(s.projects)
        .where(eq(s.projects.id, id)),
    );
    if (!p) throw new AppError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
    return p;
  };

  /** Quem da equipe ouve o cliente: atendimento do projeto ou, sem ele, admins e gestores. */
  const teamTargets = async (
    tx: AppTx,
    managerId: string | null | undefined,
    extra: (string | null)[] = [],
  ) => {
    if (managerId) return [managerId, ...extra];
    const rows = await tx
      .select({ u: s.memberships.userId })
      .from(s.memberships)
      .where(and(inArray(s.memberships.role, ["admin", "gestor"]), eq(s.memberships.active, true)));
    return [...rows.map((x) => x.u), ...extra];
  };

  const comments = async (
    tx: AppTx,
    userId: string,
    rows: { id: string; authorId: string | null; bodyText: string; createdAt: Date }[],
  ) => {
    const ids = [...new Set(rows.map((x) => x.authorId).filter((x): x is string => !!x))];
    const people = ids.length
      ? await tx
          .select({ id: s.users.id, name: s.users.name, role: s.memberships.role })
          .from(s.users)
          .leftJoin(s.memberships, eq(s.memberships.userId, s.users.id))
          .where(inArray(s.users.id, ids))
      : [];
    return rows.map((x): Comment => {
      const p = people.find((u) => u.id === x.authorId);
      return {
        id: x.id,
        author: p?.name ?? null,
        mine: x.authorId === userId,
        fromClient: p?.role === "cliente",
        body: x.bodyText,
        createdAt: x.createdAt.toISOString(),
      };
    });
  };

  const demandOut = (
    d: typeof s.demandRequests.$inferSelect,
    project: { id: string; name: string } | null,
  ): Demand => ({
    id: d.id,
    title: d.title,
    description: d.description,
    project,
    desiredDate: d.desiredDate ? d.desiredDate.toISOString().slice(0, 10) : null,
    status: d.status,
    rejectionReason: d.rejectionReason,
    taskId: d.taskId,
    createdAt: d.createdAt.toISOString(),
    reviewedAt: iso(d.reviewedAt),
  });

  return (
    r
      // ── início ───────────────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/portal/home",
          tags,
          summary: "Início do portal: marca, cliente, projetos e o que espera por mim",
          responses: {
            200: ok(
              out<{
                workspace: { name: string; logoUrl: string | null; primaryColor: string | null };
                client: { id: string; code: string; name: string };
                user: { id: string; name: string; email: string };
                projects: PortalProject[];
                awaiting: PortalTaskItem[];
                pendingDemands: number;
                toSign: number;
              }>("Início"),
            ),
          },
        }),
        async (c) => {
          const { userId, clientId } = c.var.tenant;
          const base = await mine(c, async (tx) => {
            const [cl] = await tx
              .select({ id: s.clients.id, code: s.clients.code, name: s.clients.name })
              .from(s.clients)
              .where(eq(s.clients.id, clientId!));
            const [u] = await tx
              .select({ id: s.users.id, name: s.users.name, email: s.users.email })
              .from(s.users)
              .where(eq(s.users.id, userId));
            const awaiting = await taskItems(tx, userId, eq(s.tasks.statusKey, "aguardando_cliente"));
            const [{ n: pendingDemands } = { n: 0 }] = await tx
              .select({ n: count() })
              .from(s.demandRequests)
              .where(eq(s.demandRequests.status, "pending"));
            const [{ n: toSign } = { n: 0 }] = await tx
              .select({ n: count() })
              .from(s.signers)
              .innerJoin(s.signatureRequests, eq(s.signatureRequests.id, s.signers.requestId))
              .where(
                and(
                  eq(s.signatureRequests.status, "enviado"),
                  isNull(s.signers.signedAt),
                  isNull(s.signers.refusedAt),
                  sql`(${s.signers.userId} = ${userId} OR lower(${s.signers.email}) = lower(${u?.email ?? ""}))`,
                ),
              );
            return { client: cl!, user: u!, awaiting, pendingDemands, toSign };
          });
          const ws = await tenantTx(c, async (tx) => {
            const [t] = await tx.select({ name: s.tenants.name }).from(s.tenants);
            const [st] = await tx.select({ b: s.tenantSettings.branding }).from(s.tenantSettings);
            const logoId = st?.b.logoFileId;
            const [logo] = logoId
              ? await tx
                  .select({ key: s.files.storageKey, name: s.files.originalName })
                  .from(s.files)
                  .where(eq(s.files.id, logoId))
              : [];
            return { name: t?.name ?? "", primaryColor: st?.b.primaryColor ?? null, logo };
          });
          const logoUrl =
            ws.logo && storage ? await storage.presignDownload(ws.logo.key, ws.logo.name) : null;
          return c.json(
            {
              workspace: { name: ws.name, logoUrl, primaryColor: ws.primaryColor },
              ...base,
              projects: await projectsOut(c),
            },
            200,
          );
        },
      )

      // ── projetos ─────────────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/portal/projects/{id}",
          tags,
          summary: "Projeto: resumo público, marcos, tarefas visíveis e comentários visíveis",
          request: { params: IdParam },
          responses: {
            200: ok(
              out<{
                project: PortalProject;
                milestones: { id: string; title: string; date: string; done: boolean }[];
                tasks: PortalTaskItem[];
                comments: Comment[];
                taskTypes: { id: string; label: string }[];
              }>("Projeto"),
            ),
          },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const [project] = await projectsOut(c, [id]);
          if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
          const { userId } = c.var.tenant;
          const rest = await mine(c, async (tx) => {
            const milestones = await tx
              .select({
                id: s.projectMilestones.id,
                title: s.projectMilestones.title,
                date: s.projectMilestones.date,
                completedAt: s.projectMilestones.completedAt,
              })
              .from(s.projectMilestones)
              .where(eq(s.projectMilestones.projectId, id))
              .orderBy(asc(s.projectMilestones.date));
            const tasks = await taskItems(tx, userId, eq(s.tasks.projectId, id));
            const cm = await tx
              .select({
                id: s.projectComments.id,
                authorId: s.projectComments.authorId,
                bodyText: s.projectComments.bodyText,
                createdAt: s.projectComments.createdAt,
              })
              .from(s.projectComments)
              .where(and(eq(s.projectComments.projectId, id), isNull(s.projectComments.deletedAt)))
              .orderBy(asc(s.projectComments.createdAt));
            const types = await tx
              .select({ id: s.taskTypes.id, label: s.taskTypes.label })
              .from(s.taskTypes)
              .where(eq(s.taskTypes.active, true))
              .orderBy(asc(s.taskTypes.position));
            return {
              milestones: milestones.map((m) => ({
                id: m.id,
                title: m.title,
                date: String(m.date),
                done: !!m.completedAt,
              })),
              tasks,
              comments: await comments(tx, userId, cm),
              taskTypes: types,
            };
          });
          return c.json({ project, ...rest }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/portal/projects/{id}/comments",
          tags,
          summary: "Comentar no projeto (a equipe vê e é avisada)",
          request: { params: IdParam, ...body(commentInput) },
          responses: { 201: ok(out<Comment>("Comentário"), "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const p = await visibleProject(c, id);
          const { tenantId, userId } = c.var.tenant;
          const row = await mine(c, async (tx) => {
            const [x] = await tx
              .insert(s.projectComments)
              .values({
                tenantId,
                projectId: id,
                authorId: userId,
                body: plainToRichText(b.body),
                bodyText: b.body,
                visibleToClient: true,
              })
              .returning();
            return x!;
          });
          await tenantTx(c, async (tx) => {
            await notify(tx, tenantId, await teamTargets(tx, p.managerId), {
              type: "comentario_cliente",
              title: `Comentário do cliente em ${p.name}`,
              message: b.body.slice(0, 200),
              referenceType: "project",
              referenceId: id,
            });
          });
          return c.json(
            {
              id: row.id,
              author: c.var.session?.user.name ?? null,
              mine: true,
              fromClient: true,
              body: row.bodyText,
              createdAt: row.createdAt.toISOString(),
            },
            201,
          );
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/portal/projects/{id}/tasks",
          tags,
          summary: "Criar tarefa no projeto (entra em Demandas e conta na cota do plano)",
          request: { params: IdParam, ...body(portalTaskInput) },
          responses: { 201: ok(out<{ id: string }>("Criada"), "Criada") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const p = await visibleProject(c, id);
          const actor = actorOf(c);
          const { tenantId } = c.var.tenant;
          const created = await tenantTx(c, async (tx) => {
            const t = await createTask(tx, actor, {
              title: b.title,
              projectId: id,
              statusKey: "demandas",
              description: b.description ? plainToRichText(b.description) : null,
              descriptionText: b.description ?? null,
              taskTypeId: b.taskTypeId ?? null,
              clientDeliveryDate: b.clientDeliveryDate ?? null,
              visibleToClient: true,
              trusted: true,
              silent: true,
              source: "portal",
            });
            await notify(tx, tenantId, await teamTargets(tx, p.managerId), {
              type: "demanda_nova",
              title: `Nova tarefa do cliente: ${b.title}`,
              message: p.name,
              referenceType: "task",
              referenceId: t.id,
            });
            return t;
          });
          return c.json({ id: created.id }, 201);
        },
      )

      // ── tarefas ──────────────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/portal/tasks/{id}",
          tags,
          summary: "Tarefa visível: descrição, arquivos e conversa",
          request: { params: IdParam },
          responses: {
            200: ok(
              out<{
                task: PortalTaskItem & {
                  description: string | null;
                  project: { id: string; name: string } | null;
                };
                attachments: {
                  id: string;
                  name: string;
                  fileId: string | null;
                  url: string | null;
                  createdAt: string;
                }[];
                comments: Comment[];
                reasons: { id: string; label: string }[];
              }>("Tarefa"),
            ),
          },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const { userId } = c.var.tenant;
          const data = await mine(c, async (tx) => {
            const [item] = await taskItems(tx, userId, eq(s.tasks.id, id));
            if (!item) throw new AppError(404, "TASK_NOT_FOUND", "Tarefa não encontrada.");
            const [extra] = await tx
              .select({
                description: s.tasks.description,
                descriptionText: s.tasks.descriptionText,
                pname: s.projects.name,
              })
              .from(s.tasks)
              .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
              .where(eq(s.tasks.id, id));
            const att = await tx
              .select({
                id: s.taskAttachments.id,
                name: s.taskAttachments.name,
                fileId: s.taskAttachments.fileId,
                url: s.taskAttachments.url,
                createdAt: s.taskAttachments.createdAt,
              })
              .from(s.taskAttachments)
              .where(eq(s.taskAttachments.taskId, id))
              .orderBy(asc(s.taskAttachments.createdAt));
            const fb = await tx
              .select({
                id: s.taskFeedback.id,
                authorId: s.taskFeedback.authorId,
                bodyText: s.taskFeedback.bodyText,
                createdAt: s.taskFeedback.createdAt,
              })
              .from(s.taskFeedback)
              .where(and(eq(s.taskFeedback.taskId, id), isNull(s.taskFeedback.deletedAt)))
              .orderBy(asc(s.taskFeedback.createdAt));
            return {
              task: {
                ...item,
                description:
                  extra?.descriptionText ?? (extra?.description ? richTextToPlain(extra.description) : null),
                project: item.projectId && extra?.pname ? { id: item.projectId, name: extra.pname } : null,
              },
              attachments: att.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
              comments: await comments(tx, userId, fb),
            };
          });
          const reasons = await tenantTx(c, (tx) =>
            tx
              .select({ id: s.adjustmentReasons.id, label: s.adjustmentReasons.label })
              .from(s.adjustmentReasons)
              .where(eq(s.adjustmentReasons.active, true))
              .orderBy(asc(s.adjustmentReasons.position)),
          );
          return c.json({ ...data, reasons }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/portal/tasks/{id}/comments",
          tags,
          summary: "Responder na tarefa (a equipe é avisada)",
          request: { params: IdParam, ...body(commentInput) },
          responses: { 201: ok(out<Comment>("Comentário"), "Criado") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const t = await visibleTask(c, id);
          const { tenantId, userId } = c.var.tenant;
          const row = await mine(c, async (tx) => {
            const [x] = await tx
              .insert(s.taskFeedback)
              .values({
                tenantId,
                taskId: id,
                authorId: userId,
                body: plainToRichText(b.body),
                bodyText: b.body,
                visibleToClient: true,
              })
              .returning();
            return x!;
          });
          await tenantTx(c, async (tx) => {
            const [full] = await tx
              .select({ assignee: s.tasks.assigneeId, manager: s.projects.managerId })
              .from(s.tasks)
              .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
              .where(eq(s.tasks.id, id));
            await notify(tx, tenantId, await teamTargets(tx, full?.manager, [full?.assignee ?? null]), {
              type: "comentario_cliente",
              title: `Comentário do cliente: ${t.title}`,
              message: b.body.slice(0, 200),
              referenceType: "task",
              referenceId: id,
            });
          });
          return c.json(
            {
              id: row.id,
              author: c.var.session?.user.name ?? null,
              mine: true,
              fromClient: true,
              body: row.bodyText,
              createdAt: row.createdAt.toISOString(),
            },
            201,
          );
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/portal/tasks/{id}/approve",
          tags,
          summary: 'Aprovar a entrega (sai de "Aguardando cliente" para a próxima etapa)',
          request: { params: IdParam },
          responses: { 200: ok(out<{ statusKey: string; statusLabel: string }>("Aprovada")) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const t = await visibleTask(c, id);
          if (t.statusKey !== "aguardando_cliente")
            throw new AppError(409, "NOT_AWAITING_CLIENT", "Esta tarefa não está esperando sua aprovação.");
          const actor = portalActor(c);
          const next = await tenantTx(c, async (tx) => {
            const cols = await tx
              .select()
              .from(s.kanbanColumns)
              .where(eq(s.kanbanColumns.active, true))
              .orderBy(asc(s.kanbanColumns.position));
            const i = cols.findIndex((k) => k.key === "aguardando_cliente");
            const to = cols.slice(i + 1).find((k) => k.key !== "ajustes") ?? cols.find((k) => k.isFinal)!;
            await moveTask(tx, actor, id, { statusKey: to.key }, { skipEditCheck: true });
            await audit(tx, actor, {
              entity: "task",
              entityId: id,
              entityLabel: t.title,
              action: "client_approved",
            });
            return to;
          });
          return c.json({ statusKey: next.key, statusLabel: next.label }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/portal/tasks/{id}/request-changes",
          tags,
          summary: "Pedir ajuste na entrega (vai para Ajustes como ajuste do cliente)",
          request: { params: IdParam, ...body(changesInput) },
          responses: { 200: ok(out<{ statusKey: string }>("Ajuste pedido")) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const t = await visibleTask(c, id);
          if (t.statusKey !== "aguardando_cliente")
            throw new AppError(409, "NOT_AWAITING_CLIENT", "Esta tarefa não está esperando sua aprovação.");
          const actor = portalActor(c);
          await tenantTx(c, async (tx) => {
            const reasons = await tx
              .select({ id: s.adjustmentReasons.id })
              .from(s.adjustmentReasons)
              .where(eq(s.adjustmentReasons.active, true))
              .orderBy(asc(s.adjustmentReasons.position));
            const reasonId =
              b.reasonId && reasons.some((x) => x.id === b.reasonId) ? b.reasonId : reasons[0]?.id;
            if (!reasonId)
              throw new AppError(409, "NO_ADJUSTMENT_REASON", "Não há motivos de ajuste cadastrados.");
            await moveTask(
              tx,
              actor,
              id,
              { statusKey: "ajustes", adjustment: { reasonId, kind: "client", description: b.description } },
              { skipEditCheck: true },
            );
            await tx.insert(s.taskFeedback).values({
              tenantId: actor.tenantId,
              taskId: id,
              authorId: actor.userId,
              body: plainToRichText(b.description),
              bodyText: b.description,
              visibleToClient: true,
            });
          });
          return c.json({ statusKey: "ajustes" }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/portal/tasks/{id}",
          tags,
          summary: "Apagar uma tarefa que eu mesmo criei",
          request: { params: IdParam },
          responses: { 204: { description: "Apagada" } },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const t = await visibleTask(c, id);
          if (t.createdById !== c.var.tenant.userId)
            throw new AppError(403, "NOT_YOUR_TASK", "Você só pode apagar tarefas que criou.");
          const actor = portalActor(c);
          await tenantTx(c, async (tx) => {
            await tx.update(s.tasks).set({ deletedAt: new Date() }).where(eq(s.tasks.id, id));
            await audit(tx, actor, { entity: "task", entityId: id, entityLabel: t.title, action: "delete" });
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/portal/files/{id}/download",
          tags,
          summary: "Baixar um arquivo visível para mim (redireciona para um link temporário)",
          request: { params: IdParam },
          responses: { 302: { description: "Redireciona" } },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          if (!storage) throw new AppError(503, "STORAGE_UNAVAILABLE", "Armazenamento indisponível.");
          const [f] = await mine(c, (tx) =>
            tx
              .select({ key: s.files.storageKey, name: s.files.originalName })
              .from(s.files)
              .where(and(eq(s.files.id, id), isNull(s.files.deletedAt))),
          );
          if (!f) throw new AppError(404, "FILE_NOT_FOUND", "Arquivo não encontrado.");
          return c.redirect(await storage.presignDownload(f.key, f.name), 302);
        },
      )

      // ── demandas (portal) ────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/portal/demands",
          tags,
          summary: "Minhas demandas e os formulários de briefing disponíveis",
          responses: {
            200: ok(
              out<{
                data: Demand[];
                forms: {
                  id: string;
                  name: string;
                  description: string | null;
                  fields: {
                    id: string;
                    label: string;
                    type: string;
                    options: string[];
                    allowOther: boolean;
                    required: boolean;
                    help: string | null;
                  }[];
                }[];
              }>("Demandas"),
            ),
          },
        }),
        async (c) => {
          const data = await mine(c, async (tx) => {
            const rows = await tx
              .select({ d: s.demandRequests, pid: s.projects.id, pname: s.projects.name })
              .from(s.demandRequests)
              .leftJoin(s.projects, eq(s.projects.id, s.demandRequests.projectId))
              .orderBy(desc(s.demandRequests.createdAt))
              .limit(200);
            const forms = await tx
              .select({
                id: s.briefingForms.id,
                name: s.briefingForms.name,
                description: s.briefingForms.description,
              })
              .from(s.briefingForms)
              .where(and(eq(s.briefingForms.active, true), isNull(s.briefingForms.deletedAt)))
              .orderBy(asc(s.briefingForms.name));
            const fields = forms.length
              ? await tx
                  .select()
                  .from(s.briefingFields)
                  .where(
                    inArray(
                      s.briefingFields.formId,
                      forms.map((f) => f.id),
                    ),
                  )
                  .orderBy(asc(s.briefingFields.position))
              : [];
            return {
              data: rows.map((x) => demandOut(x.d, x.pid ? { id: x.pid, name: x.pname! } : null)),
              forms: forms.map((f) => ({
                ...f,
                fields: fields
                  .filter((x) => x.formId === f.id)
                  .map((x) => ({
                    id: x.id,
                    label: x.label,
                    type: x.type,
                    options: x.options,
                    allowOther: x.allowOther,
                    required: x.required,
                    help: x.help,
                  })),
              })),
            };
          });
          return c.json(data, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/portal/demands",
          tags,
          summary: "Abrir uma demanda (vira tarefa quando a equipe aceitar)",
          request: body(demandInput),
          responses: { 201: ok(out<Demand>("Demanda"), "Criada") },
        }),
        async (c) => {
          const b = c.req.valid("json");
          const { tenantId, userId, clientId } = c.var.tenant;
          const p = b.projectId ? await visibleProject(c, b.projectId) : null;
          const d = await mine(c, async (tx) => {
            let briefingResponseId: string | null = null;
            if (b.briefing) {
              const [form] = await tx
                .select({ id: s.briefingForms.id })
                .from(s.briefingForms)
                .where(
                  and(
                    eq(s.briefingForms.id, b.briefing.formId),
                    eq(s.briefingForms.active, true),
                    isNull(s.briefingForms.deletedAt),
                  ),
                );
              if (!form) throw new AppError(400, "INVALID_REFERENCE", "Formulário de briefing inválido.");
              const fields = await tx
                .select()
                .from(s.briefingFields)
                .where(eq(s.briefingFields.formId, form.id))
                .orderBy(asc(s.briefingFields.position));
              const answers: Record<string, string | string[]> = {};
              for (const f of fields) {
                const v = b.briefing.answers[f.id];
                const empty = v === undefined || (Array.isArray(v) ? !v.length : !v.trim());
                if (f.required && empty) throw new AppError(400, "BRIEFING_REQUIRED", `Responda: ${f.label}`);
                if (!empty) answers[f.id] = v!;
              }
              const [resp] = await tx
                .insert(s.briefingResponses)
                .values({
                  tenantId,
                  formId: form.id,
                  clientId,
                  projectId: b.projectId ?? null,
                  respondentId: userId,
                  answers,
                  snapshot: fields.map((f) => ({
                    id: f.id,
                    label: f.label,
                    type: f.type,
                    options: f.options,
                  })),
                })
                .returning({ id: s.briefingResponses.id });
              briefingResponseId = resp!.id;
            }
            const [row] = await tx
              .insert(s.demandRequests)
              .values({
                tenantId,
                clientId: clientId!,
                projectId: b.projectId ?? null,
                requestedBy: userId,
                title: b.title,
                description: b.description ?? null,
                desiredDate: b.desiredDate ? new Date(`${b.desiredDate}T12:00:00Z`) : null,
                briefingResponseId,
              })
              .returning();
            return row!;
          });
          await tenantTx(c, async (tx) => {
            await notify(tx, tenantId, await teamTargets(tx, p?.managerId), {
              type: "demanda_nova",
              title: `Nova demanda: ${b.title}`,
              message: p?.name,
              referenceType: "demand",
              referenceId: d.id,
            });
          });
          return c.json(demandOut(d, p ? { id: p.id, name: p.name } : null), 201);
        },
      )

      // ── demandas (equipe) ────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/demands",
          tags: ["Demandas"],
          summary: "Fila de demandas abertas pelos clientes no portal",
          request: {
            query: z.object({
              status: z.enum(["pending", "accepted", "rejected", "all"]).default("pending"),
            }),
          },
          responses: {
            200: ok(
              out<{
                data: (Demand & {
                  client: { id: string; code: string; name: string };
                  requestedBy: string | null;
                  briefing: { form: string; answers: { label: string; value: string }[] } | null;
                })[];
                pending: number;
              }>("Demandas"),
            ),
          },
        }),
        async (c) => {
          const { status } = c.req.valid("query");
          const out = await c.var.tenant.tx(async (tx) => {
            const rows = await tx
              .select({
                d: s.demandRequests,
                pid: s.projects.id,
                pname: s.projects.name,
                client: { id: s.clients.id, code: s.clients.code, name: s.clients.name },
                by: s.users.name,
                br: s.briefingResponses,
                form: s.briefingForms.name,
              })
              .from(s.demandRequests)
              .innerJoin(s.clients, eq(s.clients.id, s.demandRequests.clientId))
              .leftJoin(s.projects, eq(s.projects.id, s.demandRequests.projectId))
              .leftJoin(s.users, eq(s.users.id, s.demandRequests.requestedBy))
              .leftJoin(s.briefingResponses, eq(s.briefingResponses.id, s.demandRequests.briefingResponseId))
              .leftJoin(s.briefingForms, eq(s.briefingForms.id, s.briefingResponses.formId))
              .where(status === "all" ? undefined : eq(s.demandRequests.status, status))
              .orderBy(
                status === "pending" ? asc(s.demandRequests.createdAt) : desc(s.demandRequests.createdAt),
              )
              .limit(200);
            const [{ n } = { n: 0 }] = await tx
              .select({ n: count() })
              .from(s.demandRequests)
              .where(eq(s.demandRequests.status, "pending"));
            return { rows, n };
          });
          return c.json(
            {
              data: out.rows.map((x) => ({
                ...demandOut(x.d, x.pid ? { id: x.pid, name: x.pname! } : null),
                client: x.client,
                requestedBy: x.by,
                briefing: x.br
                  ? {
                      form: x.form ?? "",
                      answers: x.br.snapshot
                        .filter((f) => x.br!.answers[f.id] !== undefined)
                        .map((f) => {
                          const v = x.br!.answers[f.id]!;
                          return { label: f.label, value: Array.isArray(v) ? v.join(", ") : v };
                        }),
                    }
                  : null,
              })),
              pending: out.n,
            },
            200,
          );
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/demands/{id}/accept",
          tags: ["Demandas"],
          summary: "Aceitar: cria a tarefa em Demandas (conta na cota) e avisa o cliente",
          request: { params: IdParam, ...body(acceptInput) },
          responses: { 200: ok(out<{ taskId: string }>("Aceita")) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const actor = actorOf(c);
          const taskId = await c.var.tenant.tx(async (tx) => {
            const [d] = await tx
              .select()
              .from(s.demandRequests)
              .where(eq(s.demandRequests.id, id))
              .for("update");
            if (!d) throw new AppError(404, "DEMAND_NOT_FOUND", "Demanda não encontrada.");
            if (d.status !== "pending")
              throw new AppError(409, "DEMAND_ALREADY_REVIEWED", "Esta demanda já foi respondida.");
            const projectId = b.projectId === undefined ? d.projectId : b.projectId;
            if (projectId) {
              const [p] = await tx
                .select({ clientId: s.projects.clientId })
                .from(s.projects)
                .where(eq(s.projects.id, projectId));
              if (!p || p.clientId !== d.clientId)
                throw new AppError(400, "PROJECT_CLIENT_MISMATCH", "Escolha um projeto deste cliente.");
            }
            let description = d.description ?? "";
            if (d.briefingResponseId) {
              const [br] = await tx
                .select()
                .from(s.briefingResponses)
                .where(eq(s.briefingResponses.id, d.briefingResponseId));
              if (br) {
                const lines = br.snapshot
                  .filter((f) => br.answers[f.id] !== undefined)
                  .map((f) => {
                    const v = br.answers[f.id]!;
                    return `${f.label}: ${Array.isArray(v) ? v.join(", ") : v}`;
                  });
                if (lines.length)
                  description = [description, "Briefing:", ...lines].filter(Boolean).join("\n");
              }
            }
            const t = await createTask(tx, actor, {
              title: d.title,
              projectId: projectId ?? null,
              statusKey: "demandas",
              description: description ? plainToRichText(description) : null,
              descriptionText: description || null,
              assigneeId: b.assigneeId ?? null,
              taskTypeId: b.taskTypeId ?? null,
              deadline: b.deadline ?? null,
              clientDeliveryDate: d.desiredDate ? d.desiredDate.toISOString().slice(0, 10) : null,
              visibleToClient: !!projectId,
              source: "portal_demand",
            });
            await tx
              .update(s.demandRequests)
              .set({
                status: "accepted",
                taskId: t.id,
                reviewedBy: actor.userId,
                reviewedAt: new Date(),
                projectId: projectId ?? null,
              })
              .where(eq(s.demandRequests.id, id));
            if (d.briefingResponseId)
              await tx
                .update(s.briefingResponses)
                .set({ taskId: t.id })
                .where(eq(s.briefingResponses.id, d.briefingResponseId));
            await audit(tx, actor, {
              entity: "demand",
              entityId: id,
              entityLabel: d.title,
              action: "accept",
              details: { taskId: t.id },
            });
            await notify(tx, actor.tenantId, [d.requestedBy], {
              type: "demanda_respondida",
              title: `Demanda aceita: ${d.title}`,
              referenceType: projectId ? "portal_task" : "portal_demand",
              referenceId: projectId ? t.id : id,
            });
            return t.id;
          });
          return c.json({ taskId }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/demands/{id}/reject",
          tags: ["Demandas"],
          summary: "Recusar com um motivo (o cliente vê o motivo)",
          request: { params: IdParam, ...body(rejectInput) },
          responses: { 204: { description: "Recusada" } },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const actor = actorOf(c);
          await c.var.tenant.tx(async (tx) => {
            const [d] = await tx
              .update(s.demandRequests)
              .set({
                status: "rejected",
                rejectionReason: b.reason,
                reviewedBy: actor.userId,
                reviewedAt: new Date(),
              })
              .where(and(eq(s.demandRequests.id, id), eq(s.demandRequests.status, "pending")))
              .returning();
            if (!d) throw new AppError(409, "DEMAND_ALREADY_REVIEWED", "Esta demanda já foi respondida.");
            await audit(tx, actor, {
              entity: "demand",
              entityId: id,
              entityLabel: d.title,
              action: "reject",
              details: { reason: b.reason },
            });
            await notify(tx, actor.tenantId, [d.requestedBy], {
              type: "demanda_respondida",
              title: `Demanda recusada: ${d.title}`,
              message: b.reason,
              referenceType: "portal_demand",
              referenceId: id,
            });
          });
          return c.body(null, 204);
        },
      )
  );
};

/** O cliente como autor das ações que rodam na transação do tenant. */
const portalActor = (c: Context<AppEnv>): Actor => ({ ...actorOf(c), can: () => false });
