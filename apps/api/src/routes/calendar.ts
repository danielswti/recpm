/**
 * Agenda (§6.4). Três abas sobre o mesmo intervalo:
 *   schedule   — eventos da empresa + marcos dos projetos (datas do projeto e marcos criados)
 *   team       — aniversários, folgas/feriados e eventos de pessoas (reunião, treinamento, podcast)
 *   deliveries — prazos das tarefas visíveis para a pessoa
 * Eventos anuais e aniversários são projetados em cada ano do intervalo (não viram linhas).
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  audit,
  brasilApiHolidays,
  copyHolidaysToTenant,
  nationalHolidays,
  removeImportedHolidays,
} from "@recpm/core";
import { type AppTx, schema } from "@recpm/db";
import { CALENDAR_EVENT_TYPES, calendarEventInput, calendarQuery, holidayImportInput } from "@recpm/shared";
import { and, asc, between, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError, isFkViolation } from "../lib/errors";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";
import { projectVisibleTo } from "./projects";
import { taskVisibleTo } from "./tasks";

const s = schema;
const tags = ["Agenda"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const IdParam = z.object({ id: z.uuid() });

const MILESTONE_KINDS = [
  "start",
  "first_delivery",
  "feedback_deadline",
  "final_delivery",
  "support_start",
  "support_end",
  "custom",
] as const;

const ProjectRef = z.object({ id: z.uuid(), name: z.string(), clientCode: z.string().nullable() });
const Item = z
  .object({
    id: z.string(),
    kind: z.enum(["event", "milestone", "birthday", "task"]),
    /** tipo do evento, "milestone_<kind>", "aniversario" ou "entrega". */
    type: z.string(),
    title: z.string(),
    date: z.string(),
    time: z.string().nullable(),
    isDayOff: z.boolean(),
    source: z.string().nullable(),
    project: ProjectRef.nullable(),
    task: z
      .object({
        id: z.uuid(),
        statusKey: z.string(),
        completed: z.boolean(),
        overdue: z.boolean(),
        assignee: z.object({ id: z.uuid(), name: z.string(), image: z.string().nullable() }).nullable(),
      })
      .nullable(),
    person: z.object({ id: z.uuid(), name: z.string(), image: z.string().nullable() }).nullable(),
    event: z
      .object({
        id: z.uuid(),
        description: z.string().nullable(),
        yearlyRecurring: z.boolean(),
        projectId: z.uuid().nullable(),
      })
      .nullable(),
  })
  .openapi("CalendarItem");
type ItemT = z.infer<typeof Item>;

const years = (from: string, to: string) => {
  const out: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push(y);
  return out;
};
/** "MM-DD" em cada ano do intervalo (29/02 vira 28/02 em ano não bissexto). */
const projectYearly = (mmdd: string, from: string, to: string) =>
  years(from, to)
    .map((y) => {
      let d = `${y}-${mmdd}`;
      if (mmdd === "02-29" && new Date(Date.UTC(y, 1, 29)).getUTCMonth() !== 1) d = `${y}-02-28`;
      return d;
    })
    .filter((d) => d >= from && d <= to);

async function events(
  tx: AppTx,
  from: string,
  to: string,
  filter?: (type: string, dayOff: boolean) => boolean,
) {
  const rows = await tx
    .select({ e: s.calendarEvents, pname: s.projects.name, code: s.clients.code })
    .from(s.calendarEvents)
    .leftJoin(s.projects, eq(s.projects.id, s.calendarEvents.projectId))
    .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .where(or(between(s.calendarEvents.date, from, to), eq(s.calendarEvents.yearlyRecurring, true)));
  const out: ItemT[] = [];
  for (const { e, pname, code } of rows) {
    if (filter && !filter(e.type, e.isDayOff)) continue;
    const dates = e.yearlyRecurring ? projectYearly(String(e.date).slice(5), from, to) : [String(e.date)];
    for (const date of dates)
      out.push({
        id: e.yearlyRecurring ? `${e.id}:${date}` : e.id,
        kind: "event",
        type: e.type,
        title: e.title,
        date,
        time: e.time ? String(e.time).slice(0, 5) : null,
        isDayOff: e.isDayOff,
        source: e.source,
        project: e.projectId && pname ? { id: e.projectId, name: pname, clientCode: code ?? null } : null,
        task: null,
        person: null,
        event: {
          id: e.id,
          description: e.description,
          yearlyRecurring: e.yearlyRecurring,
          projectId: e.projectId,
        },
      });
  }
  return out;
}

export const calendarRoutes = (deps: Deps) => {
  const r = router();
  r.use("/calendar", requireTenant(deps.dbs), teamOnly, requirePermission("calendar.read"));
  r.use("/calendar/*", requireTenant(deps.dbs), teamOnly, requirePermission("calendar.read"));
  r.on(
    ["POST", "PATCH", "DELETE", "PUT"],
    ["/calendar/events", "/calendar/events/*", "/calendar/holidays", "/calendar/holidays/*"],
    requirePermission("calendar.manage"),
  );
  const fetchHolidays = brasilApiHolidays(deps.fetch ?? fetch);

  return r
    .openapi(
      createRoute({
        method: "get",
        path: "/calendar",
        tags,
        summary: "Itens da agenda num intervalo (uma das três abas)",
        request: { query: calendarQuery },
        responses: { 200: ok(z.object({ data: z.array(Item) })) },
      }),
      async (c) => {
        const q = c.req.valid("query");
        if (q.to < q.from) throw new AppError(400, "INVALID_RANGE", "Intervalo inválido.");
        if (Date.parse(q.to) - Date.parse(q.from) > 400 * 86_400_000)
          throw new AppError(400, "INVALID_RANGE", "Escolha um intervalo de até 1 ano.");
        const types = q.types ? new Set(q.types.split(",")) : null;
        const data = await c.var.tenant.tx(async (tx) => {
          const actor = actorOf(c);
          const out: ItemT[] = [];
          if (q.tab === "schedule") {
            out.push(...(await events(tx, q.from, q.to)));
            const projects = await tx
              .select({ p: s.projects, code: s.clients.code })
              .from(s.projects)
              .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
              .where(
                and(isNull(s.projects.deletedAt), eq(s.projects.archived, false), projectVisibleTo(actor)),
              );
            for (const { p, code } of projects) {
              const ref = { id: p.id, name: p.name, clientCode: code ?? null };
              const dates: [string, string | null][] = [
                ["start", p.startDate],
                ["first_delivery", p.firstDeliveryDate],
                ["feedback_deadline", p.feedbackDeadline],
                ["final_delivery", p.deliveryDeadline],
                ["support_start", p.supportStart],
                ["support_end", p.supportEnd],
              ];
              for (const [kind, d] of dates)
                if (d && d >= q.from && d <= q.to)
                  out.push({
                    id: `${p.id}:${kind}`,
                    kind: "milestone",
                    type: `milestone_${kind}`,
                    title: p.name,
                    date: d,
                    time: null,
                    isDayOff: false,
                    source: null,
                    project: ref,
                    task: null,
                    person: null,
                    event: null,
                  });
            }
            const ids = new Set(projects.map((x) => x.p.id));
            const custom = await tx
              .select()
              .from(s.projectMilestones)
              .where(between(s.projectMilestones.date, q.from, q.to));
            for (const m of custom) {
              const pr = projects.find((x) => x.p.id === m.projectId);
              if (!ids.has(m.projectId) || !pr) continue;
              out.push({
                id: m.id,
                kind: "milestone",
                type: "milestone_custom",
                title: m.title,
                date: String(m.date),
                time: null,
                isDayOff: false,
                source: null,
                project: { id: pr.p.id, name: pr.p.name, clientCode: pr.code ?? null },
                task: null,
                person: null,
                event: null,
              });
            }
          } else if (q.tab === "team") {
            out.push(
              ...(await events(
                tx,
                q.from,
                q.to,
                (type, dayOff) =>
                  dayOff || ["reuniao", "treinamento", "podcast", "aniversario", "feriado"].includes(type),
              )),
            );
            const people = await tx
              .select({
                id: s.users.id,
                name: s.users.name,
                image: s.users.image,
                birthday: s.memberships.birthday,
              })
              .from(s.memberships)
              .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
              .where(
                and(
                  eq(s.memberships.active, true),
                  isNotNull(s.memberships.birthday),
                  sql`${s.memberships.role} <> 'cliente'`,
                ),
              );
            for (const p of people)
              for (const date of projectYearly(String(p.birthday).slice(5), q.from, q.to))
                out.push({
                  id: `bday:${p.id}:${date}`,
                  kind: "birthday",
                  type: "aniversario",
                  title: p.name,
                  date,
                  time: null,
                  isDayOff: false,
                  source: null,
                  project: null,
                  task: null,
                  person: { id: p.id, name: p.name, image: p.image },
                  event: null,
                });
          } else {
            const tz =
              (await tx.select({ tz: s.tenants.timezone }).from(s.tenants))[0]?.tz ?? "America/Sao_Paulo";
            const day = sql<string>`to_char(${s.tasks.deadline} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
            const hour = sql<string>`to_char(${s.tasks.deadline} AT TIME ZONE ${tz}, 'HH24:MI')`;
            const rows = await tx
              .select({
                t: s.tasks,
                day,
                hour,
                pname: s.projects.name,
                code: s.clients.code,
                aname: s.users.name,
                aimage: s.users.image,
              })
              .from(s.tasks)
              .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
              .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
              .leftJoin(s.users, eq(s.users.id, s.tasks.assigneeId))
              .where(
                and(
                  isNull(s.tasks.deletedAt),
                  eq(s.tasks.archived, false),
                  sql`${day} BETWEEN ${q.from} AND ${q.to}`,
                  taskVisibleTo(actor),
                  q.mine ? eq(s.tasks.assigneeId, actor.userId!) : undefined,
                ),
              )
              .orderBy(asc(s.tasks.deadline))
              .limit(2000);
            const now = new Date();
            for (const x of rows)
              out.push({
                id: x.t.id,
                kind: "task",
                type: "entrega",
                title: x.t.title,
                date: x.day,
                time: x.t.deadlineHasTime ? x.hour : null,
                isDayOff: false,
                source: null,
                project:
                  x.t.projectId && x.pname
                    ? { id: x.t.projectId, name: x.pname, clientCode: x.code ?? null }
                    : null,
                task: {
                  id: x.t.id,
                  statusKey: x.t.statusKey,
                  completed: !!x.t.completedAt,
                  overdue: !x.t.completedAt && !!x.t.deadline && x.t.deadline < now,
                  assignee:
                    x.t.assigneeId && x.aname ? { id: x.t.assigneeId, name: x.aname, image: x.aimage } : null,
                },
                person: null,
                event: null,
              });
          }
          return out
            .filter((i) => !types || types.has(i.type))
            .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
        });
        return c.json({ data }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/calendar/events",
        tags,
        summary: "Criar evento",
        request: body(calendarEventInput),
        responses: { 201: ok(z.object({ id: z.uuid() }), "Criado") },
      }),
      async (c) => {
        const b = c.req.valid("json");
        try {
          const row = await c.var.tenant.tx(async (tx) => {
            const [e] = await tx
              .insert(s.calendarEvents)
              .values({
                tenantId: c.var.tenant.tenantId,
                title: b.title,
                description: b.description ?? null,
                date: b.date,
                time: b.time ?? null,
                type: b.type,
                yearlyRecurring: b.yearlyRecurring,
                isDayOff: b.isDayOff,
                projectId: b.projectId ?? null,
                createdBy: c.var.tenant.userId,
              })
              .returning({ id: s.calendarEvents.id });
            await audit(tx, actorOf(c), {
              entity: "calendar_event",
              entityId: e!.id,
              entityLabel: b.title,
              action: "create",
            });
            return e!;
          });
          return c.json(row, 201);
        } catch (e) {
          if (isFkViolation(e)) throw new AppError(400, "INVALID_REFERENCE", "Projeto inválido.");
          throw e;
        }
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/calendar/events/{id}",
        tags,
        summary: "Editar evento",
        request: { params: IdParam, ...body(calendarEventInput.partial()) },
        responses: { 204: { description: "OK" } },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
        await c.var.tenant.tx(async (tx) => {
          const [e] = await tx
            .update(s.calendarEvents)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(s.calendarEvents.id, id))
            .returning();
          if (!e) throw new AppError(404, "NOT_FOUND", "Evento não encontrado.");
          await audit(tx, actorOf(c), {
            entity: "calendar_event",
            entityId: id,
            entityLabel: e.title,
            action: "update",
            details: patch,
          });
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/calendar/events/{id}",
        tags,
        summary: "Apagar evento",
        request: { params: IdParam },
        responses: { 204: { description: "OK" } },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await c.var.tenant.tx(async (tx) => {
          const [e] = await tx.delete(s.calendarEvents).where(eq(s.calendarEvents.id, id)).returning();
          if (!e) throw new AppError(404, "NOT_FOUND", "Evento não encontrado.");
          await audit(tx, actorOf(c), {
            entity: "calendar_event",
            entityId: id,
            entityLabel: e.title,
            action: "delete",
          });
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/calendar/holidays",
        tags,
        summary: "Configuração da importação de feriados",
        responses: { 200: ok(z.object({ national: z.boolean(), imported: z.number() })) },
      }),
      async (c) => {
        const res = await c.var.tenant.tx(async (tx) => {
          const [st] = await tx.select({ op: s.tenantSettings.operation }).from(s.tenantSettings);
          const [n] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(s.calendarEvents)
            .where(eq(s.calendarEvents.source, "feriado_api"));
          return { national: st?.op.holidayImport?.national ?? true, imported: n?.n ?? 0 };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/calendar/holidays",
        tags,
        summary: "Ligar/desligar feriados nacionais e importar um ano (BrasilAPI)",
        request: body(holidayImportInput),
        responses: { 200: ok(z.object({ national: z.boolean(), added: z.number() })) },
      }),
      async (c) => {
        const b = c.req.valid("json");
        let holidays: { date: string; name: string }[] = [];
        if (b.national) {
          try {
            holidays = await nationalHolidays(deps.dbs.platformDb, b.year, fetchHolidays);
          } catch (err) {
            deps.logger.warn({ err }, "BrasilAPI indisponível");
            throw new AppError(
              502,
              "HOLIDAYS_UNAVAILABLE",
              "Não foi possível buscar os feriados agora. Tente mais tarde.",
            );
          }
        }
        const added = await c.var.tenant.tx(async (tx) => {
          const [st] = await tx.select({ op: s.tenantSettings.operation }).from(s.tenantSettings);
          await tx
            .update(s.tenantSettings)
            .set({
              operation: {
                ...st!.op,
                holidayImport: { ...(st!.op.holidayImport ?? { states: [] }), national: b.national },
              },
            })
            .where(eq(s.tenantSettings.tenantId, c.var.tenant.tenantId));
          if (!b.national) {
            await removeImportedHolidays(tx);
            return 0;
          }
          return copyHolidaysToTenant(tx, c.var.tenant.tenantId, holidays);
        });
        return c.json({ national: b.national, added }, 200);
      },
    );
};

export { CALENDAR_EVENT_TYPES, MILESTONE_KINDS };
