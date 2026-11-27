/**
 * Relatórios e produtividade (§6.5).
 *
 * Regra de reconciliação (§9): "peças entregues" vêm SEMPRE de task_deliveries (botão Concluído),
 * no período, ignorando tarefas apagadas. Entregas, produtividade e contratado × entregue usam a
 * mesma consulta-base (`deliveryRows`), então os totais batem para o mesmo período.
 *
 * Períodos são datas de calendário ("AAAA-MM-DD", inclusivas) no fuso do workspace.
 */
import { type AppTx, schema as s } from "@recpm/db";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { DomainError } from "../errors";
import { tenantTimezone } from "../tasks/service";
import { localDay, zonedToUtc } from "../tasks/zoned";
import { businessMsBetween } from "../time/business";
import { workCalendars } from "../time/service";

export type Period = { from: string; to: string };
type ProductivityWeights = (typeof s.tenantSettings.$inferSelect)["productivityWeights"];
const HOUR = 3_600_000;

const ymdOf = (d: Date, tz: string) => {
  const p = localDay(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
const ymdParts = (ymd: string) => ymd.split("-").map(Number) as [number, number, number];
const nextDay = (ymd: string) => {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** Período → instantes [início, fim) no fuso do workspace. */
export function periodBounds(p: Period, tz: string) {
  if (p.from > p.to) throw new DomainError(400, "INVALID_RANGE", "A data inicial é depois da final.");
  const [fy, fm, fd] = ymdParts(p.from);
  const [ty, tm, td] = ymdParts(nextDay(p.to));
  const start = zonedToUtc(fy, fm, fd, 0, 0, tz);
  const end = zonedToUtc(ty, tm, td, 0, 0, tz);
  if (end.getTime() - start.getTime() > 400 * 86_400_000)
    throw new DomainError(400, "INVALID_RANGE", "Escolha um período de até 1 ano.");
  return { start, end };
}

/** "AAAA-MM" → período do mês inteiro. */
export function monthPeriod(month: string): Period {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

const OTHERS = { id: null, slug: "outros", label: "Outros" } as const;
export type CategoryRef = { id: string | null; slug: string; label: string };

async function categories(tx: AppTx): Promise<CategoryRef[]> {
  const rows = await tx
    .select({ id: s.reportCategories.id, slug: s.reportCategories.slug, label: s.reportCategories.label })
    .from(s.reportCategories)
    .where(eq(s.reportCategories.active, true))
    .orderBy(asc(s.reportCategories.position), asc(s.reportCategories.label));
  return [...rows, OTHERS];
}

// ── Entregas (base de tudo) ──────────────────────────────────────────────────

export type DeliveryFilters = { userId?: string; clientId?: string; projectId?: string };

export async function deliveryRows(tx: AppTx, p: Period, f: DeliveryFilters = {}) {
  const tz = await tenantTimezone(tx);
  const { start, end } = periodBounds(p, tz);
  const rows = await tx
    .select({
      id: s.taskDeliveries.id,
      quantity: s.taskDeliveries.quantity,
      deliveredAt: s.taskDeliveries.deliveredAt,
      note: s.taskDeliveries.note,
      userId: s.taskDeliveries.userId,
      userName: s.users.name,
      taskId: s.tasks.id,
      taskTitle: s.tasks.title,
      typeId: s.taskTypes.id,
      typeLabel: s.taskTypes.label,
      categoryId: s.reportCategories.id,
      categorySlug: s.reportCategories.slug,
      categoryLabel: s.reportCategories.label,
      projectId: s.projects.id,
      projectName: s.projects.name,
      projectManagerId: s.projects.managerId,
      clientId: s.clients.id,
      clientCode: s.clients.code,
      clientName: s.clients.name,
    })
    .from(s.taskDeliveries)
    .innerJoin(s.tasks, eq(s.tasks.id, s.taskDeliveries.taskId))
    .innerJoin(s.users, eq(s.users.id, s.taskDeliveries.userId))
    .leftJoin(s.taskTypes, eq(s.taskTypes.id, s.tasks.taskTypeId))
    .leftJoin(s.reportCategories, eq(s.reportCategories.id, s.taskTypes.reportCategoryId))
    .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
    .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .where(
      and(
        gte(s.taskDeliveries.deliveredAt, start),
        lt(s.taskDeliveries.deliveredAt, end),
        isNull(s.tasks.deletedAt),
        f.userId ? eq(s.taskDeliveries.userId, f.userId) : undefined,
        f.clientId ? eq(s.projects.clientId, f.clientId) : undefined,
        f.projectId ? eq(s.tasks.projectId, f.projectId) : undefined,
      ),
    )
    .orderBy(desc(s.taskDeliveries.deliveredAt));
  return rows.map((r) => ({
    id: r.id,
    quantity: r.quantity,
    deliveredAt: r.deliveredAt,
    day: ymdOf(r.deliveredAt, tz),
    note: r.note,
    user: { id: r.userId, name: r.userName },
    task: { id: r.taskId, title: r.taskTitle },
    type: r.typeId ? { id: r.typeId, label: r.typeLabel! } : null,
    category: r.categoryId
      ? { id: r.categoryId, slug: r.categorySlug!, label: r.categoryLabel! }
      : (OTHERS as CategoryRef),
    project: r.projectId ? { id: r.projectId, name: r.projectName!, managerId: r.projectManagerId } : null,
    client: r.clientId ? { id: r.clientId, code: r.clientCode!, name: r.clientName! } : null,
  }));
}
export type DeliveryRow = Awaited<ReturnType<typeof deliveryRows>>[number];

const groupSum = <K extends string | null>(
  rows: DeliveryRow[],
  key: (r: DeliveryRow) => K,
  label: (r: DeliveryRow) => Record<string, unknown>,
) => {
  const m = new Map<K, { key: K; pieces: number; deliveries: number } & Record<string, unknown>>();
  for (const r of rows) {
    const k = key(r);
    const cur = m.get(k) ?? { key: k, pieces: 0, deliveries: 0, ...label(r) };
    cur.pieces += r.quantity;
    cur.deliveries += 1;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.pieces - a.pieces);
};

export async function deliveriesReport(tx: AppTx, p: Period, f: DeliveryFilters = {}) {
  const rows = await deliveryRows(tx, p, f);
  const byDay = groupSum(
    rows,
    (r) => r.day,
    () => ({}),
  ).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return {
    period: p,
    totalPieces: rows.reduce((a, r) => a + r.quantity, 0),
    totalDeliveries: rows.length,
    byDay: byDay.map((d) => ({ day: d.key as string, pieces: d.pieces, deliveries: d.deliveries })),
    byPerson: groupSum(
      rows,
      (r) => r.user.id,
      (r) => ({ name: r.user.name }),
    ).map((x) => ({
      userId: x.key as string,
      name: x.name as string,
      pieces: x.pieces,
      deliveries: x.deliveries,
    })),
    byCategory: groupSum(
      rows,
      (r) => r.category.slug,
      (r) => ({ label: r.category.label, id: r.category.id }),
    ).map((x) => ({
      slug: x.key as string,
      id: x.id as string | null,
      label: x.label as string,
      pieces: x.pieces,
    })),
    byType: groupSum(
      rows,
      (r) => r.type?.id ?? null,
      (r) => ({ label: r.type?.label ?? null, category: r.category.label }),
    ).map((x) => ({
      typeId: x.key as string | null,
      label: (x.label as string | null) ?? null,
      category: x.category as string,
      pieces: x.pieces,
    })),
    byClient: groupSum(
      rows,
      (r) => r.client?.id ?? null,
      (r) => ({ client: r.client }),
    ).map((x) => ({
      client: x.client as DeliveryRow["client"],
      pieces: x.pieces,
      deliveries: x.deliveries,
    })),
    records: rows.map((r) => ({ ...r, deliveredAt: r.deliveredAt.toISOString() })),
  };
}

// ── Tempo útil no período ────────────────────────────────────────────────────

/** Tempo útil por pessoa no período (entradas cortadas nas bordas) + ajustes aprovados no período. */
async function businessTime(tx: AppTx, start: Date, end: Date, userIds?: string[], now = new Date()) {
  const entries = await tx
    .select()
    .from(s.timeEntries)
    .innerJoin(s.tasks, eq(s.tasks.id, s.timeEntries.taskId))
    .where(
      and(
        lt(s.timeEntries.startedAt, end),
        or(isNull(s.timeEntries.endedAt), sql`${s.timeEntries.endedAt} > ${start}`),
        isNull(s.tasks.deletedAt),
        userIds
          ? inArray(s.timeEntries.userId, userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"])
          : undefined,
      ),
    );
  const cals = await workCalendars(
    tx,
    entries.map((e) => e.time_entries.userId),
    start,
    end,
  );
  const out = new Map<
    string,
    {
      ms: number;
      reworkMs: number;
      entries: { id: string; taskId: string; title: string; ms: number; startedAt: Date; rework: boolean }[];
    }
  >();
  for (const { time_entries: e, tasks: t } of entries) {
    const s0 = e.startedAt < start ? start : e.startedAt;
    const rawEnd = e.endedAt ?? now;
    const e0 = rawEnd > end ? end : rawEnd;
    if (e0 <= s0) continue;
    const inside = e.endedAt && e.startedAt >= start && e.endedAt <= end && e.businessMs !== null;
    const ms = inside ? e.businessMs! : businessMsBetween(s0, e0, cals.get(e.userId) ?? cals.get(null)!);
    const cur = out.get(e.userId) ?? { ms: 0, reworkMs: 0, entries: [] };
    cur.ms += ms;
    if (e.statusAtStart === "ajustes") cur.reworkMs += ms;
    cur.entries.push({
      id: e.id,
      taskId: t.id,
      title: t.title,
      ms,
      startedAt: e.startedAt,
      rework: e.statusAtStart === "ajustes",
    });
    out.set(e.userId, cur);
  }
  const deltas = await tx
    .select({ userId: s.timeAdjustmentRequests.userId, ms: s.timeAdjustmentRequests.deltaMs })
    .from(s.timeAdjustmentRequests)
    .where(
      and(
        eq(s.timeAdjustmentRequests.status, "approved"),
        sql`${s.timeAdjustmentRequests.deltaMs} IS NOT NULL`,
        gte(s.timeAdjustmentRequests.reviewedAt, start),
        lt(s.timeAdjustmentRequests.reviewedAt, end),
        userIds
          ? inArray(
              s.timeAdjustmentRequests.userId,
              userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"],
            )
          : undefined,
      ),
    );
  for (const d of deltas) {
    const cur = out.get(d.userId) ?? { ms: 0, reworkMs: 0, entries: [] };
    cur.ms = Math.max(0, cur.ms + (d.ms ?? 0));
    out.set(d.userId, cur);
  }
  return out;
}

// ── Produtividade ────────────────────────────────────────────────────────────

async function weightsAndOps(tx: AppTx) {
  const [st] = await tx
    .select({ w: s.tenantSettings.productivityWeights, op: s.tenantSettings.operation })
    .from(s.tenantSettings);
  const w = (st?.w ?? {
    production: { perPiece: 10, perBusinessHour: 1, onTimeBonus: 5, reworkPenalty: 3 },
    accountManagement: {
      perClientChase: 2,
      perShootBooked: 5,
      perPiece: 2,
      perIdleCard: -5,
      idleCardPenaltyCap: -30,
    },
  }) as ProductivityWeights;
  return { weights: w, idleCardHours: st?.op?.idleCardHours ?? 48 };
}

/** Concluída no prazo: com hora, compara instantes; sem hora, compara o dia no fuso. */
const onTime = (completedAt: Date, deadline: Date, hasTime: boolean, tz: string) =>
  hasTime ? completedAt <= deadline : ymdOf(completedAt, tz) <= ymdOf(deadline, tz);

const round1 = (n: number) => Math.round(n * 10) / 10;

export type ProductivityFilters = { sectorId?: string; userId?: string };

/** Peça "no prazo", "ajuste interno", "cobrança" etc. por pessoa — base do placar e do detalhamento. */
async function productivityFacts(tx: AppTx, p: Period, f: ProductivityFilters, now = new Date()) {
  const tz = await tenantTimezone(tx);
  const { start, end } = periodBounds(p, tz);
  const { weights, idleCardHours } = await weightsAndOps(tx);

  const members = await tx
    .select({
      userId: s.memberships.userId,
      name: s.users.name,
      image: s.users.image,
      role: s.memberships.role,
      sectorId: s.memberships.sectorId,
      sectorName: s.sectors.name,
      isAccountManager: s.memberships.isAccountManager,
    })
    .from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
    .leftJoin(s.sectors, eq(s.sectors.id, s.memberships.sectorId))
    .where(
      and(
        eq(s.memberships.active, true),
        ne(s.memberships.role, "cliente"),
        f.sectorId ? eq(s.memberships.sectorId, f.sectorId) : undefined,
        f.userId ? eq(s.memberships.userId, f.userId) : undefined,
      ),
    )
    .orderBy(asc(s.users.name));
  const ids = members.map((m) => m.userId);
  const none = ["00000000-0000-0000-0000-000000000000"];
  const idList = ids.length ? ids : none;

  const deliveries = (await deliveryRows(tx, p)).filter(
    (d) => ids.includes(d.user.id) || (d.project?.managerId && ids.includes(d.project.managerId)),
  );
  const time = await businessTime(tx, start, end, idList, now);

  const completed = await tx
    .select({
      id: s.tasks.id,
      title: s.tasks.title,
      assigneeId: s.tasks.assigneeId,
      completedAt: s.tasks.completedAt,
      deadline: s.tasks.deadline,
      hasTime: s.tasks.deadlineHasTime,
    })
    .from(s.tasks)
    .where(
      and(
        isNull(s.tasks.deletedAt),
        inArray(s.tasks.assigneeId, idList),
        gte(s.tasks.completedAt, start),
        lt(s.tasks.completedAt, end),
        sql`${s.tasks.deadline} IS NOT NULL`,
      ),
    );

  const adjustments = await tx
    .select({
      id: s.taskAdjustments.id,
      responsibleId: s.taskAdjustments.responsibleId,
      createdAt: s.taskAdjustments.createdAt,
      kind: s.taskAdjustments.kind,
      reason: s.adjustmentReasons.label,
      taskId: s.tasks.id,
      title: s.tasks.title,
    })
    .from(s.taskAdjustments)
    .innerJoin(s.tasks, eq(s.tasks.id, s.taskAdjustments.taskId))
    .innerJoin(s.adjustmentReasons, eq(s.adjustmentReasons.id, s.taskAdjustments.reasonId))
    .where(
      and(
        isNull(s.tasks.deletedAt),
        eq(s.taskAdjustments.kind, "internal"),
        inArray(s.taskAdjustments.responsibleId, idList),
        gte(s.taskAdjustments.createdAt, start),
        lt(s.taskAdjustments.createdAt, end),
      ),
    );

  // Atendimento: projetos geridos por cada pessoa
  const managed = await tx
    .select({ id: s.projects.id, managerId: s.projects.managerId })
    .from(s.projects)
    .where(and(isNull(s.projects.deletedAt), inArray(s.projects.managerId, idList)));
  const managerOf = new Map(managed.map((m) => [m.id, m.managerId!]));
  const projectIds = managed.map((m) => m.id);
  const projList = projectIds.length ? projectIds : none;

  const clientDates = await tx
    .select({
      id: s.tasks.id,
      title: s.tasks.title,
      projectId: s.tasks.projectId,
      clientDeliveryDate: s.tasks.clientDeliveryDate,
      completedAt: s.tasks.completedAt,
    })
    .from(s.tasks)
    .where(
      and(
        isNull(s.tasks.deletedAt),
        eq(s.tasks.archived, false),
        inArray(s.tasks.projectId, projList),
        sql`${s.tasks.clientDeliveryDate} BETWEEN ${p.from} AND ${p.to}`,
      ),
    );
  const today = ymdOf(now, tz);

  const chases = await tx
    .select({
      id: s.auditLogs.id,
      actorId: s.auditLogs.actorId,
      createdAt: s.auditLogs.createdAt,
      taskId: s.auditLogs.entityId,
      title: s.auditLogs.entityLabel,
    })
    .from(s.auditLogs)
    .where(
      and(
        eq(s.auditLogs.entity, "task"),
        eq(s.auditLogs.action, "client_chase"),
        inArray(s.auditLogs.actorId, idList),
        gte(s.auditLogs.createdAt, start),
        lt(s.auditLogs.createdAt, end),
      ),
    );

  const shoots = await tx
    .select({
      id: s.tasks.id,
      title: s.tasks.title,
      createdById: s.tasks.createdById,
      createdAt: s.tasks.createdAt,
    })
    .from(s.tasks)
    .innerJoin(s.taskTypes, eq(s.taskTypes.id, s.tasks.taskTypeId))
    .innerJoin(s.reportCategories, eq(s.reportCategories.id, s.taskTypes.reportCategoryId))
    .where(
      and(
        isNull(s.tasks.deletedAt),
        eq(s.reportCategories.slug, "captacoes"),
        inArray(s.tasks.createdById, idList),
        gte(s.tasks.createdAt, start),
        lt(s.tasks.createdAt, end),
      ),
    );

  const [finalCol] = await tx
    .select({ key: s.kanbanColumns.key })
    .from(s.kanbanColumns)
    .where(eq(s.kanbanColumns.isFinal, true));
  const idle = await tx
    .select({
      id: s.tasks.id,
      title: s.tasks.title,
      projectId: s.tasks.projectId,
      statusKey: s.tasks.statusKey,
      statusSince: s.tasks.statusSince,
    })
    .from(s.tasks)
    .where(
      and(
        isNull(s.tasks.deletedAt),
        eq(s.tasks.archived, false),
        isNull(s.tasks.completedAt),
        finalCol ? ne(s.tasks.statusKey, finalCol.key) : undefined,
        inArray(s.tasks.projectId, projList),
        lt(s.tasks.statusSince, new Date(now.getTime() - idleCardHours * HOUR)),
      ),
    );

  return {
    tz,
    weights,
    idleCardHours,
    members,
    deliveries,
    time,
    completed,
    adjustments,
    managerOf,
    clientDates: clientDates.map((t) => {
      const due = String(t.clientDeliveryDate);
      const met = !!t.completedAt && ymdOf(t.completedAt, tz) <= due;
      return {
        ...t,
        clientDeliveryDate: due,
        met,
        counts: met || due < today || (due === today && !!t.completedAt),
      };
    }),
    chases,
    shoots,
    idle,
  };
}

export async function productivityReport(
  tx: AppTx,
  p: Period,
  f: ProductivityFilters = {},
  now = new Date(),
) {
  const x = await productivityFacts(tx, p, f, now);
  const W = x.weights;
  const rows = x.members.map((m) => {
    const pieces = x.deliveries.filter((d) => d.user.id === m.userId).reduce((a, d) => a + d.quantity, 0);
    const t = x.time.get(m.userId);
    const hours = round1((t?.ms ?? 0) / HOUR);
    const onTimeCount = x.completed.filter(
      (c) => c.assigneeId === m.userId && onTime(c.completedAt!, c.deadline!, c.hasTime, x.tz),
    ).length;
    const rework = x.adjustments.filter((a) => a.responsibleId === m.userId).length;
    const production = {
      pieces,
      hours,
      onTime: onTimeCount,
      rework,
      score: round1(
        W.production.perPiece * pieces +
          W.production.perBusinessHour * hours +
          W.production.onTimeBonus * onTimeCount -
          W.production.reworkPenalty * rework,
      ),
    };

    const myProjects = [...x.managerOf.entries()].filter(([, mgr]) => mgr === m.userId).map(([id]) => id);
    const isAm = m.isAccountManager || myProjects.length > 0;
    let account = null;
    if (isAm) {
      const dates = x.clientDates.filter((c) => c.counts && c.projectId && myProjects.includes(c.projectId));
      const met = dates.filter((c) => c.met).length;
      const pct = dates.length ? Math.round((met / dates.length) * 100) : null;
      const chases = x.chases.filter((c) => c.actorId === m.userId).length;
      const shoots = x.shoots.filter((c) => c.createdById === m.userId).length;
      const amPieces = x.deliveries
        .filter((d) => d.project?.managerId === m.userId)
        .reduce((a, d) => a + d.quantity, 0);
      const idle = x.idle.filter((c) => c.projectId && myProjects.includes(c.projectId)).length;
      const idlePoints = Math.max(
        W.accountManagement.idleCardPenaltyCap,
        W.accountManagement.perIdleCard * idle,
      );
      account = {
        clientDatesMet: met,
        clientDatesTotal: dates.length,
        clientDatesPct: pct,
        chases,
        shoots,
        pieces: amPieces,
        idleCards: idle,
        score: round1(
          (pct ?? 0) +
            W.accountManagement.perClientChase * chases +
            W.accountManagement.perShootBooked * shoots +
            W.accountManagement.perPiece * amPieces +
            idlePoints,
        ),
      };
    }
    return {
      user: { id: m.userId, name: m.name, image: m.image },
      role: m.role,
      sector: m.sectorId ? { id: m.sectorId, name: m.sectorName! } : null,
      production,
      account,
    };
  });

  const bySector = new Map<
    string | null,
    {
      sector: { id: string; name: string } | null;
      people: number;
      pieces: number;
      hours: number;
      score: number;
    }
  >();
  for (const r of rows) {
    const k = r.sector?.id ?? null;
    const cur = bySector.get(k) ?? { sector: r.sector, people: 0, pieces: 0, hours: 0, score: 0 };
    cur.people += 1;
    cur.pieces += r.production.pieces;
    cur.hours = round1(cur.hours + r.production.hours);
    cur.score = round1(cur.score + r.production.score);
    bySector.set(k, cur);
  }
  const ranked = [...rows].sort((a, b) => b.production.score - a.production.score);
  const top = ranked[0] && ranked[0].production.score > 0 ? ranked[0] : null;
  return {
    period: p,
    weights: W,
    idleCardHours: x.idleCardHours,
    highlight: top
      ? { user: top.user, sector: top.sector, score: top.production.score, pieces: top.production.pieces }
      : null,
    sectors: [...bySector.values()].sort((a, b) => b.score - a.score),
    rows: ranked,
    totals: {
      pieces: rows.reduce((a, r) => a + r.production.pieces, 0),
      hours: round1(rows.reduce((a, r) => a + r.production.hours, 0)),
    },
  };
}

export const DRILL_METRICS = [
  "pieces",
  "hours",
  "onTime",
  "rework",
  "clientDates",
  "chases",
  "shoots",
  "amPieces",
  "idleCards",
] as const;
export type DrillMetric = (typeof DRILL_METRICS)[number];

/** Os registros por trás de cada número do placar. */
export async function productivityDrill(
  tx: AppTx,
  p: Period,
  userId: string,
  metric: DrillMetric,
  now = new Date(),
) {
  const x = await productivityFacts(tx, p, { userId }, now);
  if (!x.members.length) throw new DomainError(404, "MEMBER_NOT_FOUND", "Pessoa não encontrada.");
  const myProjects = [...x.managerOf.entries()].filter(([, m]) => m === userId).map(([id]) => id);
  type Item = {
    id: string;
    taskId: string | null;
    title: string;
    at: string;
    value: string | number;
    ok?: boolean;
    detail?: string | null;
  };
  let items: Item[] = [];
  switch (metric) {
    case "pieces":
    case "amPieces":
      items = x.deliveries
        .filter((d) => (metric === "pieces" ? d.user.id === userId : d.project?.managerId === userId))
        .map((d) => ({
          id: d.id,
          taskId: d.task.id,
          title: d.task.title,
          at: d.deliveredAt.toISOString(),
          value: d.quantity,
          detail: [d.client?.code, d.category.label, metric === "amPieces" ? d.user.name : null]
            .filter(Boolean)
            .join(" · "),
        }));
      break;
    case "hours":
      items = (x.time.get(userId)?.entries ?? []).map((e) => ({
        id: e.id,
        taskId: e.taskId,
        title: e.title,
        at: e.startedAt.toISOString(),
        value: round1(e.ms / HOUR),
        detail: e.rework ? "ajustes" : null,
      }));
      break;
    case "onTime":
      items = x.completed
        .filter((c) => c.assigneeId === userId)
        .map((c) => ({
          id: c.id,
          taskId: c.id,
          title: c.title,
          at: c.completedAt!.toISOString(),
          value: c.deadline!.toISOString(),
          ok: onTime(c.completedAt!, c.deadline!, c.hasTime, x.tz),
        }));
      break;
    case "rework":
      items = x.adjustments
        .filter((a) => a.responsibleId === userId)
        .map((a) => ({
          id: a.id,
          taskId: a.taskId,
          title: a.title,
          at: a.createdAt.toISOString(),
          value: 1,
          detail: a.reason,
        }));
      break;
    case "clientDates":
      items = x.clientDates
        .filter((c) => c.counts && c.projectId && myProjects.includes(c.projectId))
        .map((c) => ({
          id: c.id,
          taskId: c.id,
          title: c.title,
          at: c.completedAt?.toISOString() ?? "",
          value: c.clientDeliveryDate,
          ok: c.met,
        }));
      break;
    case "chases":
      items = x.chases
        .filter((c) => c.actorId === userId)
        .map((c) => ({
          id: c.id,
          taskId: c.taskId,
          title: c.title ?? "",
          at: c.createdAt.toISOString(),
          value: 1,
        }));
      break;
    case "shoots":
      items = x.shoots
        .filter((c) => c.createdById === userId)
        .map((c) => ({ id: c.id, taskId: c.id, title: c.title, at: c.createdAt.toISOString(), value: 1 }));
      break;
    case "idleCards":
      items = x.idle
        .filter((c) => c.projectId && myProjects.includes(c.projectId))
        .map((c) => ({
          id: c.id,
          taskId: c.id,
          title: c.title,
          at: c.statusSince.toISOString(),
          value: Math.floor((now.getTime() - c.statusSince.getTime()) / HOUR),
          detail: c.statusKey,
        }));
      break;
  }
  return { metric, user: { id: userId, name: x.members[0]!.name }, items };
}

// ── Contratado × entregue ────────────────────────────────────────────────────

type Cell = { contracted: number; delivered: number; inProgress: number; toStart: number };
const emptyCell = (): Cell => ({ contracted: 0, delivered: 0, inProgress: 0, toStart: 0 });

export async function contractedDelivered(tx: AppTx, month: string, f: { clientId?: string } = {}) {
  const p = monthPeriod(month);
  const cats = await categories(tx);
  const catKey = (id: string | null) => cats.find((c) => c.id === id)?.slug ?? OTHERS.slug;

  // Projetos mensais com contrato vigente no mês (início ≤ fim do mês; fim ≥ início do mês, indeterminado ou sem data)
  const scope = await tx
    .select({
      id: s.projects.id,
      name: s.projects.name,
      clientId: s.projects.clientId,
      periodicity: s.projects.periodicity,
      contractEnd: s.projects.contractEnd,
      contractIndefinite: s.projects.contractIndefinite,
    })
    .from(s.projects)
    .where(
      and(
        isNull(s.projects.deletedAt),
        eq(s.projects.archived, false),
        eq(s.projects.modality, "mensal"),
        sql`${s.projects.clientId} IS NOT NULL`,
        sql`${s.projects.status} <> 'concluido'`,
        or(isNull(s.projects.startDate), sql`${s.projects.startDate} <= ${p.to}`),
        or(
          isNull(s.projects.contractEnd),
          eq(s.projects.contractIndefinite, true),
          sql`${s.projects.contractEnd} >= ${p.from}`,
        ),
        f.clientId ? eq(s.projects.clientId, f.clientId) : undefined,
      ),
    );
  const scopeIds = scope.map((x) => x.id);
  const items = scopeIds.length
    ? await tx
        .select({
          projectId: s.projectContractItems.projectId,
          qty: s.projectContractItems.quantityPerPeriod,
          categoryId: s.taskTypes.reportCategoryId,
        })
        .from(s.projectContractItems)
        .innerJoin(s.taskTypes, eq(s.taskTypes.id, s.projectContractItems.taskTypeId))
        .where(inArray(s.projectContractItems.projectId, scopeIds))
    : [];

  const delivered = await deliveryRows(tx, p, { clientId: f.clientId });

  // Em andamento agora: peças de tarefas abertas dos clientes (menos o que já foi entregue nelas)
  const open = await tx
    .select({
      id: s.tasks.id,
      clientId: s.projects.clientId,
      pieces: s.tasks.pieceQuantity,
      categoryId: s.taskTypes.reportCategoryId,
      done: sql<number>`coalesce((SELECT sum(d.quantity) FROM task_deliveries d WHERE d.task_id = ${s.tasks.id}), 0)::int`,
    })
    .from(s.tasks)
    .innerJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
    .leftJoin(s.taskTypes, eq(s.taskTypes.id, s.tasks.taskTypeId))
    .where(
      and(
        isNull(s.tasks.deletedAt),
        eq(s.tasks.archived, false),
        isNull(s.tasks.completedAt),
        isNull(s.projects.deletedAt),
        sql`${s.projects.clientId} IS NOT NULL`,
        f.clientId ? eq(s.projects.clientId, f.clientId) : undefined,
      ),
    );

  const clientIds = new Set<string>([
    ...scope.map((x) => x.clientId!),
    ...(delivered.map((d) => d.client?.id).filter(Boolean) as string[]),
  ]);
  const clientRows = clientIds.size
    ? await tx
        .select({ id: s.clients.id, code: s.clients.code, name: s.clients.name })
        .from(s.clients)
        .where(inArray(s.clients.id, [...clientIds]))
    : [];

  type Block = { cells: Record<string, Cell>; total: Cell };
  const newBlock = (): Block => ({
    cells: Object.fromEntries(cats.map((c) => [c.slug, emptyCell()])),
    total: emptyCell(),
  });
  const blocks = new Map<string | null, Block>();
  const blockOf = (clientId: string | null) => {
    let b = blocks.get(clientId);
    if (!b) {
      b = newBlock();
      blocks.set(clientId, b);
    }
    return b;
  };
  const scopeById = new Map(scope.map((x) => [x.id, x]));
  for (const it of items) {
    const proj = scopeById.get(it.projectId)!;
    const per = proj.periodicity === "anual" ? it.qty / 12 : it.qty;
    blockOf(proj.clientId).cells[catKey(it.categoryId)]!.contracted += per;
  }
  for (const d of delivered) blockOf(d.client?.id ?? null).cells[d.category.slug]!.delivered += d.quantity;
  for (const t of open) {
    const left = Math.max(0, t.pieces - t.done);
    if (left && clientIds.has(t.clientId!))
      blockOf(t.clientId).cells[catKey(t.categoryId)]!.inProgress += left;
  }
  const finish = (b: Block) => {
    for (const c of Object.values(b.cells)) {
      c.contracted = round1(c.contracted);
      c.toStart = round1(Math.max(0, c.contracted - c.delivered - c.inProgress));
      b.total.contracted = round1(b.total.contracted + c.contracted);
      b.total.delivered += c.delivered;
      b.total.inProgress += c.inProgress;
      b.total.toStart = round1(b.total.toStart + c.toStart);
    }
    return b;
  };
  const all = newBlock();
  const clients = [...blocks.entries()]
    .map(([clientId, b]) => {
      finish(b);
      for (const [k, c] of Object.entries(b.cells)) {
        const a = all.cells[k]!;
        a.contracted = round1(a.contracted + c.contracted);
        a.delivered += c.delivered;
        a.inProgress += c.inProgress;
        a.toStart = round1(a.toStart + c.toStart);
      }
      return {
        client: clientId ? (clientRows.find((c) => c.id === clientId) ?? null) : null,
        projects: scope.filter((x) => x.clientId === clientId).map((x) => ({ id: x.id, name: x.name })),
        cells: b.cells,
        total: b.total,
      };
    })
    .sort((a, b) => (a.client?.name ?? "￿").localeCompare(b.client?.name ?? "￿"));
  for (const c of Object.values(all.cells)) {
    all.total.contracted = round1(all.total.contracted + c.contracted);
    all.total.delivered += c.delivered;
    all.total.inProgress += c.inProgress;
    all.total.toStart = round1(all.total.toStart + c.toStart);
  }
  return {
    month,
    period: p,
    categories: cats.map((c) => ({ slug: c.slug, label: c.label })),
    clients,
    all: { cells: all.cells, total: all.total },
    warnings: scope
      .filter((x) => !x.contractEnd && !x.contractIndefinite)
      .map((x) => ({ projectId: x.id, name: x.name, clientId: x.clientId })),
  };
}

// ── Ajustes ──────────────────────────────────────────────────────────────────

export async function adjustmentsReport(
  tx: AppTx,
  p: Period,
  f: { userId?: string; clientId?: string } = {},
  now = new Date(),
) {
  const tz = await tenantTimezone(tx);
  const { start, end } = periodBounds(p, tz);
  const rows = await tx
    .select({
      id: s.taskAdjustments.id,
      kind: s.taskAdjustments.kind,
      createdAt: s.taskAdjustments.createdAt,
      description: s.taskAdjustments.description,
      reasonId: s.adjustmentReasons.id,
      reason: s.adjustmentReasons.label,
      responsibleId: s.taskAdjustments.responsibleId,
      responsibleName: s.users.name,
      taskId: s.tasks.id,
      title: s.tasks.title,
      categoryId: s.reportCategories.id,
      categoryLabel: s.reportCategories.label,
      clientId: s.clients.id,
      clientCode: s.clients.code,
      clientName: s.clients.name,
    })
    .from(s.taskAdjustments)
    .innerJoin(s.tasks, eq(s.tasks.id, s.taskAdjustments.taskId))
    .innerJoin(s.adjustmentReasons, eq(s.adjustmentReasons.id, s.taskAdjustments.reasonId))
    .leftJoin(s.users, eq(s.users.id, s.taskAdjustments.responsibleId))
    .leftJoin(s.taskTypes, eq(s.taskTypes.id, s.tasks.taskTypeId))
    .leftJoin(s.reportCategories, eq(s.reportCategories.id, s.taskTypes.reportCategoryId))
    .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
    .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .where(
      and(
        isNull(s.tasks.deletedAt),
        gte(s.taskAdjustments.createdAt, start),
        lt(s.taskAdjustments.createdAt, end),
        f.userId ? eq(s.taskAdjustments.responsibleId, f.userId) : undefined,
        f.clientId ? eq(s.projects.clientId, f.clientId) : undefined,
      ),
    )
    .orderBy(desc(s.taskAdjustments.createdAt));
  const count = <K>(
    key: (r: (typeof rows)[number]) => K,
    extra: (r: (typeof rows)[number]) => Record<string, unknown>,
  ) => {
    const m = new Map<K, { internal: number; client: number; total: number } & Record<string, unknown>>();
    for (const r of rows) {
      const k = key(r);
      const cur = m.get(k) ?? { internal: 0, client: 0, total: 0, ...extra(r) };
      cur[r.kind] += 1;
      cur.total += 1;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  };
  const time = await businessTime(tx, start, end, f.userId ? [f.userId] : undefined, now);
  const totalMs = [...time.values()].reduce((a, t) => a + t.ms, 0);
  const reworkMs = [...time.values()].reduce((a, t) => a + t.reworkMs, 0);
  const names = new Map(
    rows.filter((r) => r.responsibleId).map((r) => [r.responsibleId!, r.responsibleName]),
  );
  const missing = [...time.keys()].filter((id) => !names.has(id));
  if (missing.length)
    for (const u of await tx
      .select({ id: s.users.id, name: s.users.name })
      .from(s.users)
      .where(inArray(s.users.id, missing)))
      names.set(u.id, u.name);
  const people = count(
    (r) => r.responsibleId,
    (r) => ({ userId: r.responsibleId, name: r.responsibleName }),
  ).map((x) => {
    const userId = (x.userId as string | null) ?? null;
    const t = userId ? time.get(userId) : undefined;
    return {
      userId,
      name: (x.name as string | null) ?? null,
      internal: x.internal,
      client: x.client,
      total: x.total,
      reworkHours: round1((t?.reworkMs ?? 0) / HOUR),
      workedHours: round1((t?.ms ?? 0) / HOUR),
    };
  });
  // quem trabalhou em ajustes sem ter ajuste registrado no período também aparece
  for (const [uid, t] of time)
    if (t.reworkMs && !people.some((x) => x.userId === uid))
      people.push({
        userId: uid,
        name: names.get(uid) ?? "",
        internal: 0,
        client: 0,
        total: 0,
        reworkHours: round1(t.reworkMs / HOUR),
        workedHours: round1(t.ms / HOUR),
      });
  return {
    period: p,
    total: rows.length,
    internal: rows.filter((r) => r.kind === "internal").length,
    client: rows.filter((r) => r.kind === "client").length,
    rework: {
      reworkHours: round1(reworkMs / HOUR),
      workedHours: round1(totalMs / HOUR),
      pct: totalMs ? round1((reworkMs / totalMs) * 100) : 0,
    },
    byPerson: people,
    byReason: count(
      (r) => r.reasonId,
      (r) => ({ reason: r.reason }),
    ).map((x) => ({ reason: x.reason as string, internal: x.internal, client: x.client, total: x.total })),
    byCategory: count(
      (r) => r.categoryId,
      (r) => ({ label: r.categoryLabel ?? OTHERS.label }),
    ).map((x) => ({ label: x.label as string, internal: x.internal, client: x.client, total: x.total })),
    records: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      createdAt: r.createdAt.toISOString(),
      reason: r.reason,
      description: r.description,
      responsible: r.responsibleId ? { id: r.responsibleId, name: r.responsibleName } : null,
      task: { id: r.taskId, title: r.title },
      category: r.categoryLabel ?? OTHERS.label,
      client: r.clientId ? { id: r.clientId, code: r.clientCode!, name: r.clientName! } : null,
    })),
  };
}

// ── Financeiro ───────────────────────────────────────────────────────────────

export async function financialReport(tx: AppTx, p: Period, f: { clientId?: string } = {}) {
  periodBounds(p, await tenantTimezone(tx));
  const paid = await tx
    .select({
      id: s.installments.id,
      paidAt: s.installments.paidAt,
      amount: s.installments.paidAmountCents,
      method: s.installments.method,
      number: s.installments.number,
      contractId: s.installments.contractId,
      subscriptionId: s.installments.clientSubscriptionId,
      projectName: s.projects.name,
      clientId: s.clients.id,
      clientCode: s.clients.code,
      clientName: s.clients.name,
    })
    .from(s.installments)
    .leftJoin(s.contracts, eq(s.contracts.id, s.installments.contractId))
    .leftJoin(s.projects, eq(s.projects.id, s.contracts.projectId))
    .leftJoin(s.clients, eq(s.clients.id, s.installments.clientId))
    .where(
      and(
        eq(s.installments.status, "pago"),
        sql`${s.installments.paidAt} BETWEEN ${p.from} AND ${p.to}`,
        f.clientId ? eq(s.installments.clientId, f.clientId) : undefined,
      ),
    )
    .orderBy(desc(s.installments.paidAt));
  const overdue = await tx
    .select({
      contractId: s.contracts.id,
      projectId: s.projects.id,
      projectName: s.projects.name,
      clientId: s.clients.id,
      clientCode: s.clients.code,
      clientName: s.clients.name,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`sum(${s.installments.amountCents})::bigint`,
      oldest: sql<string>`min(${s.installments.dueDate})::text`,
    })
    .from(s.installments)
    .innerJoin(s.contracts, eq(s.contracts.id, s.installments.contractId))
    .innerJoin(s.projects, eq(s.projects.id, s.contracts.projectId))
    .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .where(
      and(
        eq(s.installments.status, "atrasado"),
        f.clientId ? eq(s.projects.clientId, f.clientId) : undefined,
      ),
    )
    .groupBy(s.contracts.id, s.projects.id, s.projects.name, s.clients.id, s.clients.code, s.clients.name)
    .orderBy(sql`min(${s.installments.dueDate})`);
  return {
    period: p,
    receivedCents: paid.reduce((a, r) => a + Number(r.amount ?? 0), 0),
    paymentsCount: paid.length,
    overdueCents: overdue.reduce((a, r) => a + Number(r.amount), 0),
    payments: paid.map((r) => ({
      id: r.id,
      paidAt: String(r.paidAt),
      amountCents: Number(r.amount ?? 0),
      method: r.method,
      number: r.number,
      source: r.contractId ? ("contrato" as const) : ("mensalidade" as const),
      project: r.projectName,
      client: r.clientId ? { id: r.clientId, code: r.clientCode!, name: r.clientName! } : null,
    })),
    overdueContracts: overdue.map((r) => ({
      contractId: r.contractId,
      project: { id: r.projectId, name: r.projectName },
      client: r.clientId ? { id: r.clientId, code: r.clientCode!, name: r.clientName! } : null,
      installments: r.count,
      amountCents: Number(r.amount),
      oldestDueDate: r.oldest,
    })),
  };
}
