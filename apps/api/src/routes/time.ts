/**
 * Tempo e entregas (§6.3, §6.8): "Estou nessa", tempo por tarefa, entregas (peças),
 * pedidos de ajuste de tempo com fila de aprovação e o painel "Trabalhando agora" (SSE).
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  type Actor,
  assertCanEdit,
  assertCanSee,
  audit,
  businessMsBetween,
  entryBusinessMs,
  loadTask,
  openEntryOf,
  requestTimeAdjustment,
  reviewTimeAdjustment,
  startTimer,
  stopTimer,
  taskTime,
  workCalendars,
} from "@recpm/core";
import { type AppTx, schema } from "@recpm/db";
import { deliveryInput, reviewInput, timeAdjustmentInput, timeEntriesFilters } from "@recpm/shared";
import { and, desc, eq, gte, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError } from "../lib/errors";
import { createLiveHub, type LiveHub } from "../lib/live";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;
const tags = ["Tempo"];
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
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

const Person = z.object({ id: z.uuid(), name: z.string(), image: z.string().nullable() });
const TaskRef = z.object({
  id: z.uuid(),
  title: z.string(),
  statusKey: z.string(),
  project: z.object({ id: z.uuid(), name: z.string(), clientCode: z.string().nullable() }).nullable(),
});

const Current = z
  .object({
    id: z.uuid(),
    startedAt: z.string(),
    businessMs: z.number(),
    task: TaskRef,
  })
  .nullable()
  .openapi("CurrentTimer");

const Entry = z
  .object({
    id: z.uuid(),
    user: Person,
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    businessMs: z.number(),
    statusAtStart: z.string(),
  })
  .openapi("TimeEntry");

const Adjustment = z
  .object({
    id: z.uuid(),
    user: Person,
    task: TaskRef,
    deltaMs: z.number().nullable(),
    entry: z
      .object({ id: z.uuid(), startedAt: z.string(), endedAt: z.string().nullable(), businessMs: z.number() })
      .nullable(),
    newStartedAt: z.string().nullable(),
    newEndedAt: z.string().nullable(),
    newBusinessMs: z.number().nullable(),
    reason: z.string(),
    status: z.enum(["pending", "approved", "rejected"]),
    reviewer: Person.nullable(),
    reviewedAt: z.string().nullable(),
    reviewNote: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("TimeAdjustment");

const Delivery = z
  .object({
    id: z.uuid(),
    user: Person,
    quantity: z.number(),
    note: z.string().nullable(),
    deliveredAt: z.string(),
    canDelete: z.boolean(),
  })
  .openapi("TaskDelivery");

const WorkingNow = z
  .object({
    working: z.array(
      z.object({
        entryId: z.uuid(),
        user: Person,
        jobTitle: z.string().nullable(),
        role: z.string(),
        employmentType: z.string().nullable(),
        sector: z.string().nullable(),
        task: TaskRef,
        startedAt: z.string(),
        businessMs: z.number(),
      }),
    ),
    idle: z.array(
      z.object({ user: Person, jobTitle: z.string().nullable(), lastEndedAt: z.string().nullable() }),
    ),
    at: z.string(),
  })
  .openapi("WorkingNow");

/** Tarefas com projeto e código do cliente, para os resumos. */
async function taskRefs(tx: AppTx, ids: string[]) {
  if (!ids.length) return new Map<string, z.infer<typeof TaskRef>>();
  const rows = await tx
    .select({
      id: s.tasks.id,
      title: s.tasks.title,
      statusKey: s.tasks.statusKey,
      pid: s.projects.id,
      pname: s.projects.name,
      code: s.clients.code,
    })
    .from(s.tasks)
    .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
    .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .where(inArray(s.tasks.id, [...new Set(ids)]));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        statusKey: r.statusKey,
        project: r.pid ? { id: r.pid, name: r.pname!, clientCode: r.code ?? null } : null,
      },
    ]),
  );
}

async function current(tx: AppTx, userId: string): Promise<z.infer<typeof Current>> {
  const e = await openEntryOf(tx, userId);
  if (!e) return null;
  const refs = await taskRefs(tx, [e.taskId]);
  return {
    id: e.id,
    startedAt: e.startedAt.toISOString(),
    businessMs: await entryBusinessMs(tx, e),
    task: refs.get(e.taskId)!,
  };
}

/** Painel "Trabalhando agora": quem está com timer aberto e quem está sem tarefa ativa. */
async function workingNow(tx: AppTx): Promise<z.infer<typeof WorkingNow>> {
  const now = new Date();
  const members = await tx
    .select({
      userId: s.memberships.userId,
      role: s.memberships.role,
      jobTitle: s.memberships.jobTitle,
      employmentType: s.memberships.employmentType,
      sector: s.sectors.name,
      name: s.users.name,
      image: s.users.image,
    })
    .from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
    .leftJoin(s.sectors, eq(s.sectors.id, s.memberships.sectorId))
    .where(and(eq(s.memberships.active, true), sql`${s.memberships.role} <> 'cliente'`));
  const open = await tx.select().from(s.timeEntries).where(isNull(s.timeEntries.endedAt));
  const cals = open.length
    ? await workCalendars(
        tx,
        open.map((e) => e.userId),
        open.reduce((m, e) => (e.startedAt < m ? e.startedAt : m), now),
        now,
      )
    : new Map();
  const refs = await taskRefs(
    tx,
    open.map((e) => e.taskId),
  );
  const byUser = new Map(members.map((m) => [m.userId, m]));
  const working = open
    .filter((e) => byUser.has(e.userId))
    .map((e) => {
      const m = byUser.get(e.userId)!;
      return {
        entryId: e.id,
        user: { id: m.userId, name: m.name, image: m.image },
        jobTitle: m.jobTitle,
        role: m.role,
        employmentType: m.employmentType,
        sector: m.sector,
        task: refs.get(e.taskId)!,
        startedAt: e.startedAt.toISOString(),
        businessMs: businessMsBetween(e.startedAt, now, cals.get(e.userId)!),
      };
    })
    .sort((a, b) => a.user.name.localeCompare(b.user.name));
  const busy = new Set(open.map((e) => e.userId));
  const idleIds = members.filter((m) => !busy.has(m.userId)).map((m) => m.userId);
  const last = idleIds.length
    ? await tx
        .select({ userId: s.timeEntries.userId, at: sql<Date>`max(${s.timeEntries.endedAt})` })
        .from(s.timeEntries)
        .where(inArray(s.timeEntries.userId, idleIds))
        .groupBy(s.timeEntries.userId)
    : [];
  const idle = members
    .filter((m) => !busy.has(m.userId))
    .map((m) => ({
      user: { id: m.userId, name: m.name, image: m.image },
      jobTitle: m.jobTitle,
      lastEndedAt: iso(last.find((l) => l.userId === m.userId)?.at),
    }))
    .sort((a, b) => a.user.name.localeCompare(b.user.name));
  return { working, idle, at: now.toISOString() };
}

async function adjustmentsOut(tx: AppTx, rows: (typeof s.timeAdjustmentRequests.$inferSelect)[]) {
  const userIds = [...new Set(rows.flatMap((r) => [r.userId, r.reviewerId].filter(Boolean) as string[]))];
  const users = userIds.length
    ? await tx
        .select({ id: s.users.id, name: s.users.name, image: s.users.image })
        .from(s.users)
        .where(inArray(s.users.id, userIds))
    : [];
  const u = (id: string | null) => users.find((x) => x.id === id) ?? null;
  const refs = await taskRefs(
    tx,
    rows.map((r) => r.taskId),
  );
  const entryIds = rows.map((r) => r.timeEntryId).filter(Boolean) as string[];
  const entries = entryIds.length
    ? await tx.select().from(s.timeEntries).where(inArray(s.timeEntries.id, entryIds))
    : [];
  const cals = await workCalendars(
    tx,
    rows.map((r) => r.userId),
    rows.reduce((m, r) => (r.newStartedAt && r.newStartedAt < m ? r.newStartedAt : m), new Date()),
    rows.reduce((m, r) => (r.newEndedAt && r.newEndedAt > m ? r.newEndedAt : m), new Date()),
  );
  return Promise.all(
    rows.map(async (r) => {
      const e = entries.find((x) => x.id === r.timeEntryId);
      return {
        id: r.id,
        user: u(r.userId) ?? { id: r.userId, name: "?", image: null },
        task: refs.get(r.taskId)!,
        deltaMs: r.deltaMs,
        entry: e
          ? {
              id: e.id,
              startedAt: e.startedAt.toISOString(),
              endedAt: iso(e.endedAt),
              businessMs: await entryBusinessMs(tx, e),
            }
          : null,
        newStartedAt: iso(r.newStartedAt),
        newEndedAt: iso(r.newEndedAt),
        newBusinessMs:
          r.newStartedAt && r.newEndedAt
            ? businessMsBetween(r.newStartedAt, r.newEndedAt, cals.get(r.userId)!)
            : null,
        reason: r.reason,
        status: r.status as "pending",
        reviewer: u(r.reviewerId),
        reviewedAt: iso(r.reviewedAt),
        reviewNote: r.reviewNote,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  );
}

export const timeRoutes = (deps: Deps & { live?: LiveHub | null }) => {
  const r = router();
  let hub = deps.live ?? null;
  const live = () => (hub ??= createLiveHub(deps.env.DATABASE_URL_APP, deps.logger));

  r.use("/time/*", requireTenant(deps.dbs), teamOnly);
  r.on(["POST"], ["/time/start", "/time/stop"], requirePermission("time.track"));
  r.on(["GET"], ["/time/working-now", "/time/working-now/*"], requirePermission("workingNow.view"));
  r.on(["POST"], ["/time/adjustments/:id/review"], requirePermission("time.approve"));
  // /tasks/* já passa por requireTenant + teamOnly + tasks.read (rotas de tarefas)

  const tx = <T>(c: Parameters<typeof actorOf>[0], fn: (tx: AppTx, actor: Actor) => Promise<T>) =>
    c.var.tenant.tx((t) => fn(t, actorOf(c)));

  const routes = r
    .openapi(
      createRoute({
        method: "get",
        path: "/time/current",
        tags,
        summary: "Meu timer em andamento",
        responses: { 200: ok(Current) },
      }),
      async (c) => c.json(await tx(c, (t) => current(t, c.var.tenant.userId)), 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/time/start",
        tags,
        summary: '"Estou nessa": inicia o timer (fecha o anterior)',
        request: body(z.object({ taskId: z.uuid() })),
        responses: { 200: ok(Current) },
      }),
      async (c) => {
        const { taskId } = c.req.valid("json");
        const res = await tx(c, async (t, actor) => {
          await startTimer(t, actor, taskId);
          return current(t, actor.userId!);
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/time/stop",
        tags,
        summary: "Parar o meu timer",
        responses: noContent,
      }),
      async (c) => {
        await tx(c, (t, actor) => stopTimer(t, actor));
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/time/entries",
        tags,
        summary: "Registros de tempo de uma pessoa (histórico)",
        request: { query: timeEntriesFilters },
        responses: {
          200: ok(
            z.object({
              totalMs: z.number(),
              data: z.array(Entry.omit({ user: true }).extend({ task: TaskRef })),
            }),
          ),
        },
      }),
      async (c) => {
        const q = c.req.valid("query");
        const res = await tx(c, async (t, actor) => {
          const userId = q.userId ?? actor.userId!;
          if (userId !== actor.userId && !actor.can("workingNow.view") && !actor.can("time.approve"))
            throw new AppError(403, "FORBIDDEN", "Sem permissão para ver o tempo de outra pessoa.");
          const conds: SQL[] = [eq(s.timeEntries.userId, userId)];
          if (q.from) conds.push(gte(s.timeEntries.startedAt, new Date(`${q.from}T00:00:00Z`)));
          if (q.to)
            conds.push(lt(s.timeEntries.startedAt, new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000)));
          const rows = await t
            .select()
            .from(s.timeEntries)
            .where(and(...conds))
            .orderBy(desc(s.timeEntries.startedAt))
            .limit(500);
          const refs = await taskRefs(
            t,
            rows.map((e) => e.taskId),
          );
          const data = await Promise.all(
            rows.map(async (e) => ({
              id: e.id,
              task: refs.get(e.taskId)!,
              startedAt: e.startedAt.toISOString(),
              endedAt: iso(e.endedAt),
              businessMs: await entryBusinessMs(t, e),
              statusAtStart: e.statusAtStart,
            })),
          );
          return { totalMs: data.reduce((a, e) => a + e.businessMs, 0), data };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/time/working-now",
        tags,
        summary: "Trabalhando agora (instantâneo)",
        responses: { 200: ok(WorkingNow) },
      }),
      async (c) => c.json(await tx(c, (t) => workingNow(t)), 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/time/adjustments",
        tags,
        summary: "Pedidos de ajuste de tempo (fila de aprovação ou os meus)",
        request: {
          query: z.object({
            status: z.enum(["pending", "reviewed", "all"]).default("pending"),
            mine: z.stringbool().optional(),
          }),
        },
        responses: { 200: ok(z.object({ data: z.array(Adjustment) })) },
      }),
      async (c) => {
        const q = c.req.valid("query");
        const res = await tx(c, async (t, actor) => {
          const conds: SQL[] = [];
          if (q.mine || !actor.can("time.approve"))
            conds.push(eq(s.timeAdjustmentRequests.userId, actor.userId!));
          if (q.status === "pending") conds.push(eq(s.timeAdjustmentRequests.status, "pending"));
          if (q.status === "reviewed") conds.push(sql`${s.timeAdjustmentRequests.status} <> 'pending'`);
          const rows = await t
            .select()
            .from(s.timeAdjustmentRequests)
            .where(conds.length ? and(...conds) : undefined)
            .orderBy(desc(s.timeAdjustmentRequests.createdAt))
            .limit(200);
          return { data: await adjustmentsOut(t, rows) };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/time/adjustments",
        tags,
        summary: "Pedir ajuste de tempo (conta depois de aprovado)",
        request: body(timeAdjustmentInput),
        responses: { 201: ok(Adjustment, "Criado") },
      }),
      async (c) => {
        const b = c.req.valid("json");
        const res = await tx(c, async (t, actor) => {
          const row = await requestTimeAdjustment(
            t,
            actor,
            "deltaMinutes" in b
              ? { taskId: b.taskId, deltaMs: b.deltaMinutes * 60_000, reason: b.reason }
              : b,
          );
          return (await adjustmentsOut(t, [row]))[0]!;
        });
        return c.json(res, 201);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/time/adjustments/{id}/review",
        tags,
        summary: "Aprovar ou recusar um ajuste de tempo",
        request: { params: IdParam, ...body(reviewInput) },
        responses: { 200: ok(Adjustment) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const res = await tx(c, async (t, actor) => {
          const row = await reviewTimeAdjustment(t, actor, id, b);
          await audit(t, actor, {
            entity: "time_adjustment",
            entityId: id,
            action: b.approve ? "approve" : "reject",
            details: { note: b.note ?? null },
          });
          return (await adjustmentsOut(t, [row]))[0]!;
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/tasks/{id}/time",
        tags,
        summary: "Tempo da tarefa (total útil, por pessoa e registros)",
        request: { params: IdParam },
        responses: {
          200: ok(
            z.object({
              totalMs: z.number(),
              reworkMs: z.number(),
              people: z.array(z.object({ user: Person, ms: z.number() })),
              entries: z.array(Entry),
              running: z.boolean(),
              pendingAdjustments: z.number(),
            }),
          ),
        },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const res = await tx(c, async (t, actor) => {
          const task = await loadTask(t, id);
          await assertCanSee(t, actor, task);
          const tt = await taskTime(t, id);
          const [pending] = await t
            .select({ n: sql<number>`count(*)::int` })
            .from(s.timeAdjustmentRequests)
            .where(
              and(eq(s.timeAdjustmentRequests.taskId, id), eq(s.timeAdjustmentRequests.status, "pending")),
            );
          return {
            totalMs: tt.totalMs,
            reworkMs: tt.reworkMs,
            people: tt.people.map((p) => ({
              user: { id: p.userId, name: p.name, image: p.image },
              ms: p.ms,
            })),
            entries: tt.entries.map((e) => ({
              id: e.id,
              user: e.user,
              startedAt: e.startedAt.toISOString(),
              endedAt: iso(e.endedAt),
              businessMs: e.businessMs,
              statusAtStart: e.statusAtStart,
            })),
            running: tt.entries.some((e) => !e.endedAt && e.userId === actor.userId),
            pendingAdjustments: pending?.n ?? 0,
          };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/tasks/{id}/deliveries",
        tags,
        summary: "Entregas (peças) registradas na tarefa",
        request: { params: IdParam },
        responses: { 200: ok(z.object({ total: z.number(), data: z.array(Delivery) })) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const res = await tx(c, async (t, actor) => {
          await assertCanSee(t, actor, await loadTask(t, id));
          const rows = await t
            .select({ d: s.taskDeliveries, name: s.users.name, image: s.users.image })
            .from(s.taskDeliveries)
            .innerJoin(s.users, eq(s.users.id, s.taskDeliveries.userId))
            .where(eq(s.taskDeliveries.taskId, id))
            .orderBy(desc(s.taskDeliveries.deliveredAt));
          return {
            total: rows.reduce((a, r) => a + r.d.quantity, 0),
            data: rows.map((r) => ({
              id: r.d.id,
              user: { id: r.d.userId, name: r.name, image: r.image },
              quantity: r.d.quantity,
              note: r.d.note,
              deliveredAt: r.d.deliveredAt.toISOString(),
              canDelete: r.d.userId === actor.userId || actor.can("tasks.manage"),
            })),
          };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/tasks/{id}/deliveries",
        tags,
        summary: 'Registrar entrega ("Concluído"): peças entregues',
        request: { params: IdParam, ...body(deliveryInput) },
        responses: { 201: ok(z.object({ id: z.uuid() }), "Criada") },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const res = await tx(c, async (t, actor) => {
          const task = await loadTask(t, id);
          await assertCanEdit(t, actor, task);
          const [row] = await t
            .insert(s.taskDeliveries)
            .values({
              tenantId: actor.tenantId,
              taskId: id,
              userId: actor.userId!,
              quantity: b.quantity,
              note: b.note ?? null,
            })
            .returning({ id: s.taskDeliveries.id });
          await audit(t, actor, {
            entity: "task",
            entityId: id,
            entityLabel: task.title,
            action: "delivery",
            details: { quantity: b.quantity },
          });
          return row!;
        });
        return c.json(res, 201);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/tasks/{id}/deliveries/{subId}",
        tags,
        summary: "Desfazer uma entrega",
        request: { params: SubParam },
        responses: noContent,
      }),
      async (c) => {
        const { id, subId } = c.req.valid("param");
        await tx(c, async (t, actor) => {
          const task = await loadTask(t, id);
          await assertCanSee(t, actor, task);
          const [d] = await t
            .select()
            .from(s.taskDeliveries)
            .where(and(eq(s.taskDeliveries.id, subId), eq(s.taskDeliveries.taskId, id)));
          if (!d) throw new AppError(404, "NOT_FOUND", "Entrega não encontrada.");
          if (d.userId !== actor.userId && !actor.can("tasks.manage"))
            throw new AppError(403, "FORBIDDEN", "Só quem registrou ou um gestor pode desfazer.");
          await t.delete(s.taskDeliveries).where(eq(s.taskDeliveries.id, subId));
          await audit(t, actor, {
            entity: "task",
            entityId: id,
            entityLabel: task.title,
            action: "delivery_removed",
            details: { quantity: d.quantity },
          });
        });
        return c.body(null, 204);
      },
    );

  // SSE (fora do OpenAPI): manda o painel ao conectar e a cada mudança em time_entries.
  r.get("/time/working-now/stream", (c) => {
    const tenantId = c.var.tenant.tenantId;
    return streamSSE(c, async (stream) => {
      let dirty = true;
      let wake: (() => void) | null = null;
      const unsubscribe = live().subscribe(tenantId, () => {
        dirty = true;
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      let lastSent = 0;
      try {
        while (!stream.aborted) {
          if (dirty || Date.now() - lastSent > 60_000) {
            dirty = false;
            const snap = await c.var.tenant.tx((t) => workingNow(t));
            await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snap) });
            lastSent = Date.now();
          } else {
            await stream.writeSSE({ event: "ping", data: "" });
          }
          // espera um aviso (com 300 ms de folga para juntar rajadas) ou 25 s
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 25_000);
            wake = () => {
              clearTimeout(timer);
              setTimeout(resolve, 300);
            };
          });
          wake = null;
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return routes;
};
