/**
 * "Estou nessa" (§6.3, §6.8): um timer por pessoa, contado em horas úteis.
 * - Iniciar outra tarefa fecha a anterior; concluir ou arquivar a tarefa fecha os timers dela.
 * - O índice único parcial de time_entries garante "uma tarefa ativa" mesmo com cliques simultâneos.
 * - Ajustes de tempo são pedidos e só contam depois de aprovados por quem tem time.approve.
 */
import { type AppDb, type AppTx, schema, withTenant } from "@recpm/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { DomainError } from "../errors";
import { type Actor, assertCanSee, loadTask, notify } from "../tasks/service";
import { localDay } from "../tasks/zoned";
import { businessMsBetween, dayKey, type WeekSchedule, type WorkCalendar } from "./business";

const s = schema;
type PlatformDb = AppDb;
export type TimeEntryRow = typeof s.timeEntries.$inferSelect;

const DEFAULT_SCHEDULE: WeekSchedule = {
  days: Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [{ start: "09:00", end: "18:00" }]])),
};

/** Folgas do tenant (eventos com isDayOff) num intervalo, mais as anuais. */
async function daysOff(tx: AppTx, from: Date, to: Date, tz: string) {
  const a = localDay(new Date(from.getTime() - 86_400_000), tz);
  const b = localDay(new Date(to.getTime() + 86_400_000), tz);
  const rows = await tx
    .select({ date: s.calendarEvents.date, yearly: s.calendarEvents.yearlyRecurring })
    .from(s.calendarEvents)
    .where(
      and(
        eq(s.calendarEvents.isDayOff, true),
        or(
          eq(s.calendarEvents.yearlyRecurring, true),
          sql`${s.calendarEvents.date} BETWEEN ${dayKey(a.year, a.month, a.day)} AND ${dayKey(b.year, b.month, b.day)}`,
        ),
      ),
    );
  const once = new Set<string>();
  const yearly = new Set<string>();
  for (const r of rows) (r.yearly ? yearly : once).add(r.yearly ? String(r.date).slice(5) : String(r.date));
  return { once, yearly };
}

async function tenantDefaults(tx: AppTx) {
  const [t] = await tx.select({ tz: s.tenants.timezone }).from(s.tenants);
  const [st] = await tx.select({ op: s.tenantSettings.operation }).from(s.tenantSettings);
  return {
    tz: t?.tz ?? "America/Sao_Paulo",
    schedule: (st?.op?.defaultBusinessHours as WeekSchedule | undefined) ?? DEFAULT_SCHEDULE,
    slaHours: st?.op?.clientChaseSlaBusinessHours ?? 16,
  };
}

/**
 * Calendário de trabalho de cada pessoa (agenda e fuso próprios ou os do workspace).
 * `null` na lista = o calendário padrão do workspace.
 */
export async function workCalendars(
  tx: AppTx,
  userIds: (string | null)[],
  from: Date,
  to: Date,
): Promise<Map<string | null, WorkCalendar>> {
  const def = await tenantDefaults(tx);
  const ids = [...new Set(userIds.filter((u): u is string => !!u))];
  const members = ids.length
    ? await tx
        .select({
          userId: s.memberships.userId,
          tz: s.memberships.timezone,
          hours: s.memberships.businessHours,
        })
        .from(s.memberships)
        .where(inArray(s.memberships.userId, ids))
    : [];
  const offCache = new Map<string, Awaited<ReturnType<typeof daysOff>>>();
  const offFor = async (tz: string) => {
    const cached = offCache.get(tz);
    if (cached) return cached;
    const v = await daysOff(tx, from, to, tz);
    offCache.set(tz, v);
    return v;
  };
  const out = new Map<string | null, WorkCalendar>();
  const make = async (tz: string, schedule: WeekSchedule) => {
    const off = await offFor(tz);
    return { tz, schedule, daysOff: off.once, yearlyDaysOff: off.yearly };
  };
  out.set(null, await make(def.tz, def.schedule));
  for (const id of ids) {
    const m = members.find((x) => x.userId === id);
    out.set(id, await make(m?.tz || def.tz, (m?.hours as WeekSchedule | null) ?? def.schedule));
  }
  return out;
}

export async function workCalendar(tx: AppTx, userId: string | null, from: Date, to: Date) {
  return (await workCalendars(tx, [userId], from, to)).get(userId)!;
}

/** Tempo útil de uma entrada (aberta = até agora). */
export async function entryBusinessMs(tx: AppTx, e: TimeEntryRow, now = new Date()) {
  if (e.endedAt && e.businessMs !== null) return e.businessMs;
  const end = e.endedAt ?? now;
  return businessMsBetween(e.startedAt, end, await workCalendar(tx, e.userId, e.startedAt, end));
}

async function closeEntry(tx: AppTx, e: TimeEntryRow, at: Date) {
  const end = at < e.startedAt ? e.startedAt : at;
  const businessMs = businessMsBetween(e.startedAt, end, await workCalendar(tx, e.userId, e.startedAt, end));
  const [row] = await tx
    .update(s.timeEntries)
    .set({ endedAt: end, businessMs })
    .where(and(eq(s.timeEntries.id, e.id), isNull(s.timeEntries.endedAt)))
    .returning();
  return row ?? null;
}

export async function openEntryOf(tx: AppTx, userId: string) {
  const [e] = await tx
    .select()
    .from(s.timeEntries)
    .where(and(eq(s.timeEntries.userId, userId), isNull(s.timeEntries.endedAt)));
  return e ?? null;
}

/** Para o timer do ator (se houver). */
export async function stopTimer(tx: AppTx, actor: Actor, at = new Date()) {
  if (!actor.userId) return null;
  const open = await openEntryOf(tx, actor.userId);
  return open ? closeEntry(tx, open, at) : null;
}

/** Fecha todos os timers de uma tarefa (concluída, arquivada ou excluída). */
export async function stopTaskTimers(tx: AppTx, taskId: string, at = new Date()) {
  const open = await tx
    .select()
    .from(s.timeEntries)
    .where(and(eq(s.timeEntries.taskId, taskId), isNull(s.timeEntries.endedAt)));
  for (const e of open) await closeEntry(tx, e, at);
  return open.length;
}

/**
 * "Estou nessa": inicia o timer na tarefa. Se a pessoa já estava em outra, fecha aquela.
 * Na mesma tarefa, não faz nada (idempotente).
 */
export async function startTimer(tx: AppTx, actor: Actor, taskId: string, at = new Date()) {
  if (!actor.userId) throw new DomainError(403, "FORBIDDEN", "Só pessoas registram tempo.");
  const t = await loadTask(tx, taskId);
  await assertCanSee(tx, actor, t);
  if (t.archived) throw new DomainError(409, "TASK_ARCHIVED", "Tarefa arquivada.");
  if (t.completedAt) throw new DomainError(409, "TASK_COMPLETED", "A tarefa já foi concluída.");
  const open = await openEntryOf(tx, actor.userId);
  if (open?.taskId === taskId) return { entry: open, stopped: null };
  const stopped = open ? await closeEntry(tx, open, at) : null;
  try {
    const [entry] = await tx.transaction((sp) =>
      sp
        .insert(s.timeEntries)
        .values({
          tenantId: actor.tenantId,
          userId: actor.userId!,
          taskId,
          startedAt: at,
          statusAtStart: t.statusKey,
        })
        .returning(),
    );
    return { entry: entry!, stopped };
  } catch (e) {
    if (
      (e as { cause?: { code?: string }; code?: string }).cause?.code === "23505" ||
      (e as { code?: string }).code === "23505"
    )
      throw new DomainError(409, "TIMER_CONFLICT", "Outro timer acabou de ser iniciado. Atualize a página.");
    throw e;
  }
}

/** Tempo da tarefa: total útil (entradas + ajustes aprovados), por pessoa, e as últimas entradas. */
export async function taskTime(tx: AppTx, taskId: string, now = new Date()) {
  const entries = await tx
    .select({ e: s.timeEntries, name: s.users.name, image: s.users.image })
    .from(s.timeEntries)
    .innerJoin(s.users, eq(s.users.id, s.timeEntries.userId))
    .where(eq(s.timeEntries.taskId, taskId))
    .orderBy(desc(s.timeEntries.startedAt));
  const deltas = await tx
    .select({ userId: s.timeAdjustmentRequests.userId, ms: s.timeAdjustmentRequests.deltaMs })
    .from(s.timeAdjustmentRequests)
    .where(
      and(
        eq(s.timeAdjustmentRequests.taskId, taskId),
        eq(s.timeAdjustmentRequests.status, "approved"),
        sql`${s.timeAdjustmentRequests.deltaMs} IS NOT NULL`,
      ),
    );
  const byUser = new Map<string, { userId: string; name: string; image: string | null; ms: number }>();
  const list = [];
  for (const r of entries) {
    const ms = await entryBusinessMs(tx, r.e, now);
    const u = byUser.get(r.e.userId) ?? { userId: r.e.userId, name: r.name, image: r.image, ms: 0 };
    u.ms += ms;
    byUser.set(r.e.userId, u);
    list.push({ ...r.e, businessMs: ms, user: { id: r.e.userId, name: r.name, image: r.image } });
  }
  for (const d of deltas) {
    const u = byUser.get(d.userId);
    if (u) u.ms += d.ms ?? 0;
    else byUser.set(d.userId, { userId: d.userId, name: "", image: null, ms: d.ms ?? 0 });
  }
  const people = [...byUser.values()];
  const missing = people.filter((p) => !p.name).map((p) => p.userId);
  if (missing.length) {
    const us = await tx
      .select({ id: s.users.id, name: s.users.name, image: s.users.image })
      .from(s.users)
      .where(inArray(s.users.id, missing));
    for (const p of people) {
      const u = us.find((x) => x.id === p.userId);
      if (u) Object.assign(p, { name: u.name, image: u.image });
    }
  }
  return {
    totalMs: people.reduce((a, p) => a + Math.max(0, p.ms), 0),
    reworkMs: list.filter((e) => e.statusAtStart === "ajustes").reduce((a, e) => a + e.businessMs, 0),
    people: people.sort((a, b) => b.ms - a.ms),
    entries: list.slice(0, 50),
  };
}

// ── Ajustes de tempo ─────────────────────────────────────────────────────────

const MAX_DELTA_MS = 24 * 3_600_000;

export type TimeAdjustmentRequest =
  | { taskId: string; deltaMs: number; reason: string }
  | { timeEntryId: string; startedAt: string; endedAt: string; reason: string };

async function approvers(tx: AppTx) {
  return (
    await tx
      .select({ u: s.memberships.userId })
      .from(s.memberships)
      .where(and(inArray(s.memberships.role, ["admin", "gestor"]), eq(s.memberships.active, true)))
  ).map((r) => r.u);
}

export async function requestTimeAdjustment(tx: AppTx, actor: Actor, input: TimeAdjustmentRequest) {
  if (!actor.userId) throw new DomainError(403, "FORBIDDEN", "Só pessoas pedem ajuste.");
  let taskId: string;
  const values: Partial<typeof s.timeAdjustmentRequests.$inferInsert> = {};
  if ("deltaMs" in input) {
    if (!input.deltaMs || Math.abs(input.deltaMs) > MAX_DELTA_MS)
      throw new DomainError(400, "INVALID_TIME_ADJUSTMENT", "O ajuste deve ser de até 24 horas.");
    const t = await loadTask(tx, input.taskId);
    await assertCanSee(tx, actor, t);
    taskId = t.id;
    values.deltaMs = input.deltaMs;
  } else {
    const [e] = await tx.select().from(s.timeEntries).where(eq(s.timeEntries.id, input.timeEntryId));
    if (!e || e.userId !== actor.userId)
      throw new DomainError(404, "TIME_ENTRY_NOT_FOUND", "Registro de tempo não encontrado.");
    if (!e.endedAt) throw new DomainError(409, "TIMER_RUNNING", "Pare o timer antes de pedir o ajuste.");
    const a = new Date(input.startedAt);
    const b = new Date(input.endedAt);
    if (!(b > a) || b.getTime() - a.getTime() > 7 * MAX_DELTA_MS || b > new Date())
      throw new DomainError(400, "INVALID_TIME_ADJUSTMENT", "Intervalo inválido.");
    taskId = e.taskId;
    Object.assign(values, { timeEntryId: e.id, newStartedAt: a, newEndedAt: b });
  }
  const [pending] = await tx
    .select({ id: s.timeAdjustmentRequests.id })
    .from(s.timeAdjustmentRequests)
    .where(
      and(
        eq(s.timeAdjustmentRequests.userId, actor.userId),
        eq(s.timeAdjustmentRequests.status, "pending"),
        values.timeEntryId ? eq(s.timeAdjustmentRequests.timeEntryId, values.timeEntryId) : sql`false`,
      ),
    );
  if (pending)
    throw new DomainError(409, "TIME_ADJUSTMENT_PENDING", "Já existe um pedido pendente para este registro.");
  const [row] = await tx
    .insert(s.timeAdjustmentRequests)
    .values({ tenantId: actor.tenantId, userId: actor.userId, taskId, reason: input.reason, ...values })
    .returning();
  const t = await loadTask(tx, taskId);
  await notify(
    tx,
    actor.tenantId,
    await approvers(tx),
    {
      type: "ajuste_tempo_pendente",
      title: `Ajuste de tempo para aprovar: ${t.title}`,
      message: `${actor.name ?? ""}: ${input.reason}`.trim(),
      referenceType: "time_adjustment",
      referenceId: row!.id,
    },
    actor.userId,
  );
  return row!;
}

export async function reviewTimeAdjustment(
  tx: AppTx,
  actor: Actor,
  id: string,
  decision: { approve: boolean; note?: string | null },
) {
  const [r] = await tx.select().from(s.timeAdjustmentRequests).where(eq(s.timeAdjustmentRequests.id, id));
  if (!r) throw new DomainError(404, "TIME_ADJUSTMENT_NOT_FOUND", "Pedido não encontrado.");
  if (r.status !== "pending") throw new DomainError(409, "ALREADY_REVIEWED", "Este pedido já foi analisado.");
  if (r.userId === actor.userId && actor.role !== "admin")
    throw new DomainError(403, "SELF_REVIEW", "Outra pessoa precisa aprovar o seu próprio ajuste.");
  const now = new Date();
  if (decision.approve && r.timeEntryId && r.newStartedAt && r.newEndedAt) {
    const cal = await workCalendar(tx, r.userId, r.newStartedAt, r.newEndedAt);
    await tx
      .update(s.timeEntries)
      .set({
        startedAt: r.newStartedAt,
        endedAt: r.newEndedAt,
        businessMs: businessMsBetween(r.newStartedAt, r.newEndedAt, cal),
      })
      .where(eq(s.timeEntries.id, r.timeEntryId));
  }
  const [row] = await tx
    .update(s.timeAdjustmentRequests)
    .set({
      status: decision.approve ? "approved" : "rejected",
      reviewerId: actor.userId,
      reviewedAt: now,
      reviewNote: decision.note ?? null,
      updatedAt: now,
    })
    .where(eq(s.timeAdjustmentRequests.id, id))
    .returning();
  const t = await loadTask(tx, r.taskId);
  await notify(tx, actor.tenantId, [r.userId], {
    type: decision.approve ? "ajuste_tempo_aprovado" : "ajuste_tempo_recusado",
    title: `${decision.approve ? "Ajuste de tempo aprovado" : "Ajuste de tempo recusado"}: ${t.title}`,
    message: decision.note ?? undefined,
    referenceType: "task",
    referenceId: t.id,
  });
  return row!;
}

// ── SLA de cobrança do cliente ───────────────────────────────────────────────

/**
 * Cards em "aguardando cliente" há mais horas úteis que o SLA (configurável) avisam o atendimento
 * do projeto (ou os gestores). Avisa uma vez; a ação "Cobrar cliente" zera a contagem.
 */
export async function checkClientChaseSla(tx: AppTx, tenantId: string, now = new Date()) {
  const def = await tenantDefaults(tx);
  const rows = await tx
    .select({
      id: s.tasks.id,
      title: s.tasks.title,
      since: sql<Date>`greatest(${s.tasks.statusSince}, coalesce(${s.tasks.lastClientChaseAt}, ${s.tasks.statusSince}))`,
      managerId: s.projects.managerId,
    })
    .from(s.tasks)
    .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
    .where(
      and(
        eq(s.tasks.statusKey, "aguardando_cliente"),
        isNull(s.tasks.chaseSlaNotifiedAt),
        isNull(s.tasks.deletedAt),
        eq(s.tasks.archived, false),
      ),
    )
    .orderBy(asc(s.tasks.statusSince))
    .limit(500);
  if (!rows.length) return 0;
  const oldest = rows.reduce((m, r) => (new Date(r.since) < m ? new Date(r.since) : m), now);
  const cal = await workCalendar(tx, null, oldest, now);
  const limit = def.slaHours * 3_600_000;
  let fallback: string[] | null = null;
  let n = 0;
  for (const r of rows) {
    if (businessMsBetween(new Date(r.since), now, cal) < limit) continue;
    if (!r.managerId && !fallback) fallback = await approvers(tx);
    const targets = r.managerId ? [r.managerId] : (fallback ?? []);
    await notify(tx, tenantId, targets, {
      type: "cobranca_cliente_sla",
      title: `Cobrar o cliente: ${r.title}`,
      message: `Aguardando o cliente há mais de ${def.slaHours} horas úteis.`,
      referenceType: "task",
      referenceId: r.id,
    });
    await tx.update(s.tasks).set({ chaseSlaNotifiedAt: now }).where(eq(s.tasks.id, r.id));
    n++;
  }
  return n;
}

/** Job do worker: acha os tenants com cards aguardando o cliente e checa o SLA de cada um. */
export async function runClientChaseSla(dbs: { platformDb: PlatformDb; appDb: AppDb }, now = new Date()) {
  const due = await dbs.platformDb
    .selectDistinct({ tenantId: s.tasks.tenantId })
    .from(s.tasks)
    .where(
      and(
        eq(s.tasks.statusKey, "aguardando_cliente"),
        isNull(s.tasks.chaseSlaNotifiedAt),
        isNull(s.tasks.deletedAt),
        eq(s.tasks.archived, false),
      ),
    );
  let notified = 0;
  for (const { tenantId } of due)
    notified += await withTenant(dbs.appDb, { tenantId, actor: "system" }, (tx) =>
      checkClientChaseSla(tx, tenantId, now),
    );
  return { tenants: due.length, notified };
}
