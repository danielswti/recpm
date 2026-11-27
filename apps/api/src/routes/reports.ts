/**
 * Relatórios e produtividade (§6.5): minha produtividade, placar da equipe com detalhamento,
 * contratado × entregue, entregas realizadas, ajustes e financeiro; exportação CSV/XLSX/PDF.
 *
 * Permissões: minha produtividade = productivity.own; placar = productivity.team;
 * demais relatórios = reports.read (o financeiro também exige finance.read). Só a equipe.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  adjustmentsReport,
  contractedDelivered,
  DRILL_METRICS,
  deliveriesReport,
  financialReport,
  type Period,
  productivityDrill,
  productivityReport,
  tenantTimezone,
  todayIn,
} from "@recpm/core";
import type { AppTx } from "@recpm/db";
import type { Permission } from "@recpm/shared";
import type { Context } from "hono";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError } from "../lib/errors";
import { router } from "../lib/router";
import { requireTenant } from "../middleware/tenant";
import { type ExportDoc, renderExport } from "../services/report-export";
import type { AppEnv } from "../types";

const tags = ["Relatórios"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
/** Corpo tipado pelo núcleo (o formato está descrito em cada função de @recpm/core). */
const report = <T>(description: string) => z.custom<T>().openapi({ type: "object", description });

const ymd = z.iso.date();
const PeriodQuery = z.object({ from: ymd.optional(), to: ymd.optional() });
const Uuid = z.uuid().optional();

type Deliveries = Awaited<ReturnType<typeof deliveriesReport>>;
type Productivity = Awaited<ReturnType<typeof productivityReport>>;
type Drill = Awaited<ReturnType<typeof productivityDrill>>;
type CxD = Awaited<ReturnType<typeof contractedDelivered>>;
type Adjustments = Awaited<ReturnType<typeof adjustmentsReport>>;
type Financial = Awaited<ReturnType<typeof financialReport>>;

const need = (c: Context<AppEnv>, ...perms: Permission[]) => {
  const a = actorOf(c);
  for (const p of perms)
    if (!a.can(p)) throw new AppError(403, "FORBIDDEN", "Sem permissão para este relatório.");
  return a;
};

/** Período padrão: do dia 1º do mês até hoje, no fuso do workspace. */
async function periodOf(tx: AppTx, q: { from?: string; to?: string }): Promise<Period> {
  const today = todayIn(await tenantTimezone(tx));
  const to = q.to ?? (q.from && q.from > today ? q.from : today);
  return { from: q.from ?? `${to.slice(0, 8)}01`, to };
}
const thisMonth = async (tx: AppTx) => todayIn(await tenantTimezone(tx)).slice(0, 7);

// ── Exportação: rótulos em pt-BR e en ────────────────────────────────────────

const L = {
  "pt-BR": {
    deliveries: "Entregas realizadas",
    productivity: "Produtividade da equipe",
    myProductivity: "Minha produtividade",
    cxd: "Contratado x entregue",
    adjustments: "Ajustes",
    financial: "Financeiro",
    period: "Período",
    month: "Mês",
    records: "Registros",
    byDay: "Por dia",
    byPerson: "Por pessoa",
    byCategory: "Por categoria",
    byClient: "Por cliente",
    byType: "Peças por tipo",
    byReason: "Por motivo",
    bySector: "Por setor",
    date: "Data",
    day: "Dia",
    person: "Pessoa",
    sector: "Setor",
    task: "Tarefa",
    type: "Tipo",
    category: "Categoria",
    client: "Cliente",
    project: "Projeto",
    pieces: "Peças",
    deliveriesN: "Entregas",
    note: "Observação",
    hours: "Horas úteis",
    onTime: "No prazo",
    rework: "Ajustes internos",
    score: "Pontos",
    clientDates: "Datas do cliente (%)",
    chases: "Cobranças",
    shoots: "Captações",
    idle: "Cards parados",
    production: "Produção",
    account: "Atendimento",
    contracted: "Contratado",
    delivered: "Entregue",
    inProgress: "Em andamento",
    toStart: "A começar",
    total: "Total",
    allClients: "Todos os clientes",
    internal: "Interno",
    clientKind: "Cliente",
    reason: "Motivo",
    kind: "Classificação",
    responsible: "Responsável",
    reworkHours: "Horas em ajustes",
    workedHours: "Horas trabalhadas",
    paidAt: "Pago em",
    amount: "Valor",
    method: "Forma",
    source: "Origem",
    installments: "Parcelas",
    oldest: "Vencimento mais antigo",
    overdue: "Contratos em atraso",
    payments: "Pagamentos",
    summary: "Resumo",
    received: "Recebido",
    noClient: "Interno / sem cliente",
    others: "Outros",
  },
  en: {
    deliveries: "Deliveries made",
    productivity: "Team productivity",
    myProductivity: "My productivity",
    cxd: "Contracted x delivered",
    adjustments: "Adjustments",
    financial: "Financial",
    period: "Period",
    month: "Month",
    records: "Records",
    byDay: "By day",
    byPerson: "By person",
    byCategory: "By category",
    byClient: "By client",
    byType: "Pieces by type",
    byReason: "By reason",
    bySector: "By sector",
    date: "Date",
    day: "Day",
    person: "Person",
    sector: "Sector",
    task: "Task",
    type: "Type",
    category: "Category",
    client: "Client",
    project: "Project",
    pieces: "Pieces",
    deliveriesN: "Deliveries",
    note: "Note",
    hours: "Business hours",
    onTime: "On time",
    rework: "Internal adjustments",
    score: "Points",
    clientDates: "Client dates (%)",
    chases: "Client chases",
    shoots: "Shoots",
    idle: "Idle cards",
    production: "Production",
    account: "Account management",
    contracted: "Contracted",
    delivered: "Delivered",
    inProgress: "In progress",
    toStart: "To start",
    total: "Total",
    allClients: "All clients",
    internal: "Internal",
    clientKind: "Client",
    reason: "Reason",
    kind: "Kind",
    responsible: "Responsible",
    reworkHours: "Hours on adjustments",
    workedHours: "Hours worked",
    paidAt: "Paid on",
    amount: "Amount",
    method: "Method",
    source: "Source",
    installments: "Installments",
    oldest: "Oldest due date",
    overdue: "Overdue contracts",
    payments: "Payments",
    summary: "Summary",
    received: "Received",
    noClient: "Internal / no client",
    others: "Others",
  },
} as const;
type Labels = Record<keyof (typeof L)["pt-BR"], string>;

const periodText = (p: Period, locale: string, l: Labels) => {
  const f = (d: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "short" }).format(
      new Date(`${d}T12:00:00Z`),
    );
  return `${l.period}: ${f(p.from)} - ${f(p.to)}`;
};

const deliveriesDoc = (d: Deliveries, l: Labels, locale: string, title = l.deliveries): ExportDoc => ({
  title,
  subtitle: `${periodText(d.period, locale, l)} · ${l.pieces}: ${d.totalPieces}`,
  locale,
  sections: [
    {
      title: l.records,
      columns: [
        { key: "at", label: l.date, kind: "datetime" },
        { key: "person", label: l.person },
        { key: "client", label: l.client },
        { key: "task", label: l.task, width: 3 },
        { key: "type", label: l.type },
        { key: "category", label: l.category },
        { key: "qty", label: l.pieces, kind: "int" },
        { key: "note", label: l.note },
      ],
      rows: d.records.map((r) => ({
        at: r.deliveredAt,
        person: r.user.name,
        client: r.client ? `${r.client.code} - ${r.client.name}` : l.noClient,
        task: r.task.title,
        type: r.type?.label ?? "",
        category: r.category.id ? r.category.label : l.others,
        qty: r.quantity,
        note: r.note,
      })),
    },
    {
      title: l.byDay,
      columns: [
        { key: "day", label: l.day, kind: "date" },
        { key: "pieces", label: l.pieces, kind: "int" },
        { key: "n", label: l.deliveriesN, kind: "int" },
      ],
      rows: d.byDay.map((x) => ({ day: x.day, pieces: x.pieces, n: x.deliveries })),
    },
    {
      title: l.byPerson,
      columns: [
        { key: "name", label: l.person },
        { key: "pieces", label: l.pieces, kind: "int" },
        { key: "n", label: l.deliveriesN, kind: "int" },
      ],
      rows: d.byPerson.map((x) => ({ name: x.name, pieces: x.pieces, n: x.deliveries })),
    },
    {
      title: l.byCategory,
      columns: [
        { key: "label", label: l.category },
        { key: "pieces", label: l.pieces, kind: "int" },
      ],
      rows: d.byCategory.map((x) => ({ label: x.id ? x.label : l.others, pieces: x.pieces })),
    },
    {
      title: l.byType,
      columns: [
        { key: "label", label: l.type },
        { key: "category", label: l.category },
        { key: "pieces", label: l.pieces, kind: "int" },
      ],
      rows: d.byType.map((x) => ({ label: x.label ?? "-", category: x.category, pieces: x.pieces })),
    },
    {
      title: l.byClient,
      columns: [
        { key: "client", label: l.client },
        { key: "pieces", label: l.pieces, kind: "int" },
        { key: "n", label: l.deliveriesN, kind: "int" },
      ],
      rows: d.byClient.map((x) => ({
        client: x.client ? `${x.client.code} - ${x.client.name}` : l.noClient,
        pieces: x.pieces,
        n: x.deliveries,
      })),
    },
  ],
});

const productivityDoc = (d: Productivity, l: Labels, locale: string): ExportDoc => ({
  title: l.productivity,
  subtitle: periodText(d.period, locale, l),
  locale,
  sections: [
    {
      title: l.production,
      columns: [
        { key: "name", label: l.person },
        { key: "sector", label: l.sector },
        { key: "pieces", label: l.pieces, kind: "int" },
        { key: "hours", label: l.hours, kind: "num" },
        { key: "onTime", label: l.onTime, kind: "int" },
        { key: "rework", label: l.rework, kind: "int" },
        { key: "score", label: l.score, kind: "num" },
      ],
      rows: d.rows.map((r) => ({
        name: r.user.name,
        sector: r.sector?.name ?? "",
        ...r.production,
      })),
    },
    {
      title: l.account,
      columns: [
        { key: "name", label: l.person },
        { key: "pct", label: l.clientDates, kind: "pct" },
        { key: "chases", label: l.chases, kind: "int" },
        { key: "shoots", label: l.shoots, kind: "int" },
        { key: "pieces", label: l.pieces, kind: "int" },
        { key: "idle", label: l.idle, kind: "int" },
        { key: "score", label: l.score, kind: "num" },
      ],
      rows: d.rows
        .filter((r) => r.account)
        .sort((a, b) => b.account!.score - a.account!.score)
        .map((r) => ({
          name: r.user.name,
          pct: r.account!.clientDatesPct,
          chases: r.account!.chases,
          shoots: r.account!.shoots,
          pieces: r.account!.pieces,
          idle: r.account!.idleCards,
          score: r.account!.score,
        })),
    },
    {
      title: l.bySector,
      columns: [
        { key: "sector", label: l.sector },
        { key: "people", label: l.person, kind: "int" },
        { key: "pieces", label: l.pieces, kind: "int" },
        { key: "hours", label: l.hours, kind: "num" },
        { key: "score", label: l.score, kind: "num" },
      ],
      rows: d.sectors.map((x) => ({
        sector: x.sector?.name ?? "-",
        people: x.people,
        pieces: x.pieces,
        hours: x.hours,
        score: x.score,
      })),
    },
  ],
});

const cxdDoc = (d: CxD, l: Labels, locale: string): ExportDoc => {
  const cols = [
    { key: "category", label: l.category },
    { key: "contracted", label: l.contracted, kind: "num" as const },
    { key: "delivered", label: l.delivered, kind: "int" as const },
    { key: "inProgress", label: l.inProgress, kind: "int" as const },
    { key: "toStart", label: l.toStart, kind: "num" as const },
  ];
  const rowsOf = (cells: CxD["all"]["cells"], total: CxD["all"]["total"]) => [
    ...d.categories.map((c) => ({ category: c.slug === "outros" ? l.others : c.label, ...cells[c.slug]! })),
    { category: l.total, ...total },
  ];
  const [y, m] = d.month.split("-");
  return {
    title: l.cxd,
    subtitle: `${l.month}: ${m}/${y}`,
    locale,
    sections: [
      ...(d.clients.length > 1
        ? [{ title: l.allClients, columns: cols, rows: rowsOf(d.all.cells, d.all.total) }]
        : []),
      ...d.clients.map((c) => ({
        title: c.client ? `${c.client.code} - ${c.client.name}` : l.noClient,
        columns: cols,
        rows: rowsOf(c.cells, c.total),
      })),
    ],
  };
};

const adjustmentsDoc = (d: Adjustments, l: Labels, locale: string): ExportDoc => ({
  title: l.adjustments,
  subtitle: `${periodText(d.period, locale, l)} · ${l.total}: ${d.total} · ${l.reworkHours}: ${d.rework.reworkHours} (${d.rework.pct}%)`,
  locale,
  sections: [
    {
      title: l.records,
      columns: [
        { key: "at", label: l.date, kind: "datetime" },
        { key: "responsible", label: l.responsible },
        { key: "task", label: l.task, width: 3 },
        { key: "client", label: l.client },
        { key: "category", label: l.category },
        { key: "reason", label: l.reason, width: 2 },
        { key: "kind", label: l.kind },
      ],
      rows: d.records.map((r) => ({
        at: r.createdAt,
        responsible: r.responsible?.name ?? "",
        task: r.task.title,
        client: r.client ? r.client.code : "",
        category: r.category,
        reason: r.reason,
        kind: r.kind === "internal" ? l.internal : l.clientKind,
      })),
    },
    {
      title: l.byPerson,
      columns: [
        { key: "name", label: l.person },
        { key: "internal", label: l.internal, kind: "int" },
        { key: "client", label: l.clientKind, kind: "int" },
        { key: "total", label: l.total, kind: "int" },
        { key: "reworkHours", label: l.reworkHours, kind: "num" },
        { key: "workedHours", label: l.workedHours, kind: "num" },
      ],
      rows: d.byPerson.map((x) => ({ ...x, name: x.name ?? "-" })),
    },
    {
      title: l.byReason,
      columns: [
        { key: "reason", label: l.reason },
        { key: "internal", label: l.internal, kind: "int" },
        { key: "client", label: l.clientKind, kind: "int" },
        { key: "total", label: l.total, kind: "int" },
      ],
      rows: d.byReason,
    },
    {
      title: l.byCategory,
      columns: [
        { key: "label", label: l.category },
        { key: "internal", label: l.internal, kind: "int" },
        { key: "client", label: l.clientKind, kind: "int" },
        { key: "total", label: l.total, kind: "int" },
      ],
      rows: d.byCategory,
    },
  ],
});

const financialDoc = (d: Financial, l: Labels, locale: string): ExportDoc => ({
  title: l.financial,
  subtitle: `${periodText(d.period, locale, l)} · ${l.received}: ${new Intl.NumberFormat(locale, { style: "currency", currency: "BRL" }).format(d.receivedCents / 100)} · ${l.payments}: ${d.paymentsCount}`,
  locale,
  sections: [
    {
      title: l.payments,
      columns: [
        { key: "paidAt", label: l.paidAt, kind: "date" },
        { key: "client", label: l.client },
        { key: "source", label: l.source, width: 2.5 },
        { key: "method", label: l.method },
        { key: "amount", label: l.amount, kind: "money" },
      ],
      rows: d.payments.map((p) => ({
        paidAt: p.paidAt,
        client: p.client ? `${p.client.code} - ${p.client.name}` : "",
        source: p.project ?? p.source,
        method: p.method ?? "",
        amount: p.amountCents,
      })),
    },
    {
      title: l.overdue,
      columns: [
        { key: "project", label: l.project, width: 2.5 },
        { key: "client", label: l.client },
        { key: "n", label: l.installments, kind: "int" },
        { key: "oldest", label: l.oldest, kind: "date" },
        { key: "amount", label: l.amount, kind: "money" },
      ],
      rows: d.overdueContracts.map((o) => ({
        project: o.project.name,
        client: o.client ? `${o.client.code} - ${o.client.name}` : "",
        n: o.installments,
        oldest: o.oldestDueDate,
        amount: o.amountCents,
      })),
    },
  ],
});

export const REPORT_KINDS = [
  "deliveries",
  "productivity",
  "my-productivity",
  "contracted-delivered",
  "adjustments",
  "financial",
] as const;

export const reportRoutes = (deps: Deps) => {
  const r = router();
  r.use("/reports/*", requireTenant(deps.dbs), teamOnly);

  return r
    .openapi(
      createRoute({
        method: "get",
        path: "/reports/deliveries",
        tags,
        summary: "Entregas realizadas (por dia, pessoa, categoria, tipo e cliente)",
        request: { query: PeriodQuery.extend({ userId: Uuid, clientId: Uuid }) },
        responses: { 200: ok(report<Deliveries>("Entregas do período, agregadas e em registros")) },
      }),
      async (c) => {
        need(c, "reports.read");
        const q = c.req.valid("query");
        const res = await c.var.tenant.tx(async (tx) => deliveriesReport(tx, await periodOf(tx, q), q));
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/reports/productivity",
        tags,
        summary: "Placar de produtividade da equipe (produção e atendimento)",
        request: { query: PeriodQuery.extend({ sectorId: Uuid }) },
        responses: { 200: ok(report<Productivity>("Placar, setores e destaque do período")) },
      }),
      async (c) => {
        need(c, "productivity.team");
        const q = c.req.valid("query");
        const res = await c.var.tenant.tx(async (tx) => productivityReport(tx, await periodOf(tx, q), q));
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/reports/productivity/drill",
        tags,
        summary: "Registros por trás de um número do placar",
        request: { query: PeriodQuery.extend({ userId: z.uuid(), metric: z.enum(DRILL_METRICS) }) },
        responses: { 200: ok(report<Drill>("Itens que formam o número")) },
      }),
      async (c) => {
        const q = c.req.valid("query");
        const a = actorOf(c);
        if (!(a.can("productivity.team") || (q.userId === a.userId && a.can("productivity.own"))))
          throw new AppError(403, "FORBIDDEN", "Sem permissão para este relatório.");
        const res = await c.var.tenant.tx(async (tx) =>
          productivityDrill(tx, await periodOf(tx, q), q.userId, q.metric),
        );
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/reports/my-productivity",
        tags,
        summary: "Minha produtividade: entregas, horas úteis e entregas por categoria",
        request: { query: PeriodQuery },
        responses: {
          200: ok(
            report<{
              me: Productivity["rows"][number] | null;
              weights: Productivity["weights"];
              deliveries: Deliveries;
            }>("Meus números no período"),
          ),
        },
      }),
      async (c) => {
        const a = need(c, "productivity.own");
        const q = c.req.valid("query");
        const res = await c.var.tenant.tx(async (tx) => {
          const p = await periodOf(tx, q);
          const prod = await productivityReport(tx, p, { userId: a.userId! });
          return {
            me: prod.rows[0] ?? null,
            weights: prod.weights,
            deliveries: await deliveriesReport(tx, p, { userId: a.userId! }),
          };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/reports/contracted-delivered",
        tags,
        summary: "Contratado × entregue no mês, por cliente e categoria",
        request: {
          query: z.object({
            month: z
              .string()
              .regex(/^\d{4}-\d{2}$/)
              .optional(),
            clientId: Uuid,
          }),
        },
        responses: { 200: ok(report<CxD>("Células por cliente e categoria; avisos de contrato sem fim")) },
      }),
      async (c) => {
        need(c, "reports.read");
        const q = c.req.valid("query");
        const res = await c.var.tenant.tx(async (tx) =>
          contractedDelivered(tx, q.month ?? (await thisMonth(tx)), q),
        );
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/reports/adjustments",
        tags,
        summary: "Ajustes por pessoa, motivo e categoria; tempo de retrabalho",
        request: { query: PeriodQuery.extend({ userId: Uuid, clientId: Uuid }) },
        responses: { 200: ok(report<Adjustments>("Ajustes do período")) },
      }),
      async (c) => {
        need(c, "reports.read");
        const q = c.req.valid("query");
        const res = await c.var.tenant.tx(async (tx) => adjustmentsReport(tx, await periodOf(tx, q), q));
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/reports/financial",
        tags,
        summary: "Recebido no período, pagamentos e contratos em atraso",
        request: { query: PeriodQuery.extend({ clientId: Uuid }) },
        responses: { 200: ok(report<Financial>("Financeiro do período")) },
      }),
      async (c) => {
        need(c, "reports.read", "finance.read");
        const q = c.req.valid("query");
        const res = await c.var.tenant.tx(async (tx) => financialReport(tx, await periodOf(tx, q), q));
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/reports/export",
        tags,
        summary: "Exportar um relatório em CSV, XLSX ou PDF",
        request: {
          query: PeriodQuery.extend({
            report: z.enum(REPORT_KINDS),
            format: z.enum(["csv", "xlsx", "pdf"]),
            lang: z.enum(["pt-BR", "en"]).default("pt-BR"),
            month: z
              .string()
              .regex(/^\d{4}-\d{2}$/)
              .optional(),
            userId: Uuid,
            clientId: Uuid,
            sectorId: Uuid,
          }),
        },
        responses: { 200: { description: "Arquivo" } },
      }),
      async (c) => {
        const q = c.req.valid("query");
        const l = L[q.lang];
        const locale = q.lang;
        const a = actorOf(c);
        const doc = await c.var.tenant.tx(async (tx) => {
          switch (q.report) {
            case "deliveries":
              need(c, "reports.read");
              return deliveriesDoc(await deliveriesReport(tx, await periodOf(tx, q), q), l, locale);
            case "my-productivity":
              need(c, "productivity.own");
              return deliveriesDoc(
                await deliveriesReport(tx, await periodOf(tx, q), { userId: a.userId! }),
                l,
                locale,
                `${l.myProductivity} - ${c.var.session?.user.name ?? ""}`,
              );
            case "productivity":
              need(c, "productivity.team");
              return productivityDoc(await productivityReport(tx, await periodOf(tx, q), q), l, locale);
            case "contracted-delivered":
              need(c, "reports.read");
              return cxdDoc(await contractedDelivered(tx, q.month ?? (await thisMonth(tx)), q), l, locale);
            case "adjustments":
              need(c, "reports.read");
              return adjustmentsDoc(await adjustmentsReport(tx, await periodOf(tx, q), q), l, locale);
            case "financial":
              need(c, "reports.read", "finance.read");
              return financialDoc(await financialReport(tx, await periodOf(tx, q), q), l, locale);
          }
        });
        const f = await renderExport(doc, q.format);
        return c.body(f.body as Uint8Array<ArrayBuffer>, 200, {
          "Content-Type": f.mime,
          "Content-Disposition": `attachment; filename="${f.filename}"`,
          "Cache-Control": "no-store",
        });
      },
    );
};
