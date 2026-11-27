import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api, unwrap } from "./api";

/** Filtros comuns dos relatórios, guardados na URL. */
export const periodSearch = z.object({
  preset: z.enum(["month", "lastMonth", "30d", "custom"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().optional(),
  clientId: z.string().optional(),
  sectorId: z.string().optional(),
});
export type PeriodSearch = z.infer<typeof periodSearch>;

const pad = (n: number) => String(n).padStart(2, "0");
const ymdLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Preset → { from, to } ("AAAA-MM-DD"). Padrão: este mês até hoje. */
export function resolvePeriod(s: PeriodSearch, now = new Date()) {
  const preset = s.preset ?? (s.from || s.to ? "custom" : "month");
  if (preset === "custom" && s.from && s.to) return { preset, from: s.from, to: s.to };
  if (preset === "lastMonth") {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { preset, from: ymdLocal(first), to: ymdLocal(last) };
  }
  if (preset === "30d")
    return { preset, from: ymdLocal(new Date(now.getTime() - 29 * 86_400_000)), to: ymdLocal(now) };
  return {
    preset: "month" as const,
    from: ymdLocal(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: ymdLocal(now),
  };
}

export const thisMonth = () => ymdLocal(new Date()).slice(0, 7);

type Q = { from: string; to: string; userId?: string; clientId?: string; sectorId?: string };
const clean = <T extends Record<string, string | undefined>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as T;

export const deliveriesReportQuery = (q: Q) =>
  queryOptions({
    queryKey: ["reports", "deliveries", q],
    queryFn: () =>
      unwrap(
        api.reports.deliveries.$get({
          query: clean({ from: q.from, to: q.to, userId: q.userId, clientId: q.clientId }),
        }),
      ),
  });
export const productivityReportQuery = (q: Q) =>
  queryOptions({
    queryKey: ["reports", "productivity", q],
    queryFn: () =>
      unwrap(
        api.reports.productivity.$get({ query: clean({ from: q.from, to: q.to, sectorId: q.sectorId }) }),
      ),
  });
export const myProductivityQuery = (q: Q) =>
  queryOptions({
    queryKey: ["reports", "my-productivity", q],
    queryFn: () => unwrap(api.reports["my-productivity"].$get({ query: { from: q.from, to: q.to } })),
  });
export const contractedDeliveredQuery = (month: string, clientId?: string) =>
  queryOptions({
    queryKey: ["reports", "cxd", month, clientId],
    queryFn: () => unwrap(api.reports["contracted-delivered"].$get({ query: clean({ month, clientId }) })),
  });
export const adjustmentsReportQuery = (q: Q) =>
  queryOptions({
    queryKey: ["reports", "adjustments", q],
    queryFn: () =>
      unwrap(
        api.reports.adjustments.$get({
          query: clean({ from: q.from, to: q.to, userId: q.userId, clientId: q.clientId }),
        }),
      ),
  });
export const financialReportQuery = (q: Q) =>
  queryOptions({
    queryKey: ["reports", "financial", q],
    queryFn: () =>
      unwrap(api.reports.financial.$get({ query: clean({ from: q.from, to: q.to, clientId: q.clientId }) })),
  });

export type DrillMetric =
  | "pieces"
  | "hours"
  | "onTime"
  | "rework"
  | "clientDates"
  | "chases"
  | "shoots"
  | "amPieces"
  | "idleCards";
export const drillQuery = (q: { from: string; to: string; userId: string; metric: DrillMetric }) =>
  queryOptions({
    queryKey: ["reports", "drill", q],
    queryFn: () => unwrap(api.reports.productivity.drill.$get({ query: q })),
  });

export type ReportKind =
  | "deliveries"
  | "productivity"
  | "my-productivity"
  | "contracted-delivered"
  | "adjustments"
  | "financial";

/** Link de download (o navegador baixa direto; a sessão vai no cookie). */
export function exportUrl(
  report: ReportKind,
  format: "csv" | "xlsx" | "pdf",
  lang: string,
  params: Record<string, string | undefined>,
) {
  const qs = new URLSearchParams(
    clean({ report, format, lang: lang.startsWith("en") ? "en" : "pt-BR", ...params }) as Record<
      string,
      string
    >,
  );
  return `/api/v1/reports/export?${qs}`;
}

export const hours = (n: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
