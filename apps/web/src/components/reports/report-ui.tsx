/** Peças comuns das telas de relatório: filtros na URL, exportar, números, barras e detalhamento. */
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { CircleHelp, Download, FileSpreadsheet, FileText, Table2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { catalogQuery } from "../../lib/catalogs";
import { clientsQuery } from "../../lib/clients";
import { errorMessage } from "../../lib/errors";
import { membersQuery } from "../../lib/queries";
import {
  type DrillMetric,
  drillQuery,
  exportUrl,
  type PeriodSearch,
  type ReportKind,
  resolvePeriod,
} from "../../lib/reports";
import { calendarDate } from "../../lib/work";

export function ReportFilters({
  search,
  onChange,
  show = [],
  children,
}: {
  search: PeriodSearch;
  onChange: (patch: Partial<PeriodSearch>) => void;
  show?: ("person" | "client" | "sector")[];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const p = resolvePeriod(search);
  const people = useQuery({ ...membersQuery("team"), enabled: show.includes("person") });
  const clients = useQuery({ ...clientsQuery({ status: "all" }), enabled: show.includes("client") });
  const sectors = useQuery({ ...catalogQuery("sectors"), enabled: show.includes("sector") });
  return (
    <fieldset
      className="mb-6 flex min-w-0 flex-wrap items-end gap-2 border-0 p-0"
      aria-label={t("reports.filters")}
    >
      <label className="grid gap-1 text-xs text-muted-foreground">
        {t("reports.period")}
        <Select
          className="w-44"
          value={p.preset}
          onChange={(e) => {
            const preset = e.target.value as NonNullable<PeriodSearch["preset"]>;
            onChange(
              preset === "custom"
                ? { preset, from: p.from, to: p.to }
                : { preset, from: undefined, to: undefined },
            );
          }}
        >
          {(["month", "lastMonth", "30d", "custom"] as const).map((k) => (
            <option key={k} value={k}>
              {t(`reports.presets.${k}`)}
            </option>
          ))}
        </Select>
      </label>
      {p.preset === "custom" && (
        <>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t("reports.from")}
            <Input
              type="date"
              className="w-40"
              value={p.from}
              max={p.to}
              onChange={(e) => e.target.value && onChange({ from: e.target.value })}
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t("reports.to")}
            <Input
              type="date"
              className="w-40"
              value={p.to}
              min={p.from}
              onChange={(e) => e.target.value && onChange({ to: e.target.value })}
            />
          </label>
        </>
      )}
      {show.includes("person") && (
        <label className="grid gap-1 text-xs text-muted-foreground">
          {t("reports.person")}
          <Select
            className="w-44"
            value={search.userId ?? ""}
            onChange={(e) => onChange({ userId: e.target.value || undefined })}
          >
            <option value="">{t("reports.everyone")}</option>
            {people.data?.data
              .filter((m) => m.active !== false)
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
          </Select>
        </label>
      )}
      {show.includes("client") && (
        <label className="grid gap-1 text-xs text-muted-foreground">
          {t("reports.client")}
          <Select
            className="w-44"
            value={search.clientId ?? ""}
            onChange={(e) => onChange({ clientId: e.target.value || undefined })}
          >
            <option value="">{t("reports.allClients")}</option>
            {clients.data?.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {show.includes("sector") && (
        <label className="grid gap-1 text-xs text-muted-foreground">
          {t("reports.sector")}
          <Select
            className="w-44"
            value={search.sectorId ?? ""}
            onChange={(e) => onChange({ sectorId: e.target.value || undefined })}
          >
            <option value="">{t("reports.allSectors")}</option>
            {sectors.data?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className="ml-auto flex gap-2">{children}</div>
    </fieldset>
  );
}

export function ExportMenu({
  report,
  params,
}: {
  report: ReportKind;
  params: Record<string, string | undefined>;
}) {
  const { t, i18n } = useTranslation();
  const items = [
    { f: "xlsx" as const, icon: FileSpreadsheet, label: "Excel (.xlsx)" },
    { f: "csv" as const, icon: Table2, label: "CSV" },
    { f: "pdf" as const, icon: FileText, label: "PDF" },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Download /> {t("reports.export")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map(({ f, icon: Icon, label }) => (
          <DropdownMenuItem key={f} asChild>
            <a href={exportUrl(report, f, i18n.language, params)} download>
              <Icon /> {label}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Stat({
  label,
  value,
  sub,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <p className="truncate text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="rounded-xl text-left focus-visible:outline-2">
      <Card className="h-full p-4 transition-colors hover:border-primary/50">{body}</Card>
    </button>
  ) : (
    <Card className="h-full p-4">{body}</Card>
  );
}

/**
 * Barras horizontais de uma série só (magnitude): uma cor, ponta arredondada, valor escrito
 * ao lado (a cor nunca é a única pista) e dica ao passar o mouse.
 */
export function BarList({
  items,
  empty,
  format = (n) => String(n),
}: {
  items: { key: string; label: ReactNode; value: number; title?: string }[];
  empty?: string;
  format?: (n: number) => string;
}) {
  const { t } = useTranslation();
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty ?? t("reports.noData")}</p>;
  return (
    <ul className="grid gap-2">
      {items.map((i) => (
        <li
          key={i.key}
          className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm"
          title={i.title ?? `${i.title ?? ""}${format(i.value)}`}
        >
          <span className="truncate">{i.label}</span>
          <span className="h-2.5 rounded-r bg-muted/50" aria-hidden>
            <span
              className="block h-full rounded-r bg-primary"
              style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }}
            />
          </span>
          <span className="w-12 text-right tabular-nums">{format(i.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Colunas por dia (uma série). Cada coluna tem dica com a data e o valor; a tabela fica no export. */
export function DayColumns({
  days,
  from,
  to,
  label,
}: {
  days: { day: string; pieces: number }[];
  from: string;
  to: string;
  label: string;
}) {
  const { i18n } = useTranslation();
  const all: { day: string; pieces: number }[] = [];
  const map = new Map(days.map((d) => [d.day, d.pieces]));
  for (
    let d = new Date(`${from}T12:00:00Z`);
    d.toISOString().slice(0, 10) <= to && all.length < 400;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const k = d.toISOString().slice(0, 10);
    all.push({ day: k, pieces: map.get(k) ?? 0 });
  }
  const max = Math.max(1, ...all.map((d) => d.pieces));
  return (
    <figure aria-label={label}>
      <div className="flex h-32 items-end gap-0.5 border-b" role="img" aria-label={label}>
        {all.map((d) => (
          <div
            key={d.day}
            className="group relative flex h-full flex-1 items-end"
            title={`${calendarDate(d.day, i18n.language)}: ${d.pieces}`}
          >
            <div
              className="w-full rounded-t-[3px] bg-primary transition-opacity group-hover:opacity-80"
              style={{ height: d.pieces ? `${Math.max(4, (d.pieces / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <figcaption className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{calendarDate(from, i18n.language)}</span>
        <span>{calendarDate(to, i18n.language)}</span>
      </figcaption>
    </figure>
  );
}

export function HelpPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="mb-6 rounded-lg border bg-muted/30 px-4 py-3 text-sm [&_li]:mt-1">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <CircleHelp className="size-4 text-primary" /> {title}
      </summary>
      <div className="mt-2 grid gap-2 text-muted-foreground">{children}</div>
    </details>
  );
}

export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const id = `s-${title.replace(/\W+/g, "-")}`;
  return (
    <Card className="min-w-0 p-4" aria-labelledby={id}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

export const LoadingGrid = () => (
  <div className="grid gap-3 md:grid-cols-3">
    {["a", "b", "c"].map((k) => (
      <Skeleton key={k} className="h-24" />
    ))}
  </div>
);

/** Registros por trás de um número do placar. */
export function DrillDialog({
  q,
  title,
  onClose,
  onOpenTask,
}: {
  q: { from: string; to: string; userId: string; metric: DrillMetric } | null;
  title: string;
  onClose: () => void;
  onOpenTask?: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const d = useQuery({
    ...drillQuery(q ?? { from: "", to: "", userId: "", metric: "pieces" }),
    enabled: !!q,
  });
  const when = (iso: string) =>
    iso
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(
          new Date(iso),
        )
      : "—";
  const detailOf = (v: string | number, metric: DrillMetric) => {
    if (metric === "onTime") return t("reports.drill.deadline", { date: when(String(v)) });
    if (metric === "clientDates")
      return t("reports.drill.clientDate", { date: calendarDate(String(v), i18n.language) });
    if (metric === "hours") return t("reports.hoursShort", { n: v });
    if (metric === "idleCards") return t("reports.drill.idleFor", { n: v });
    return String(v);
  };
  return (
    <Dialog open={!!q} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")} className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {q && <DialogDescription>{t(`reports.drill.help.${q.metric}`)}</DialogDescription>}
        </DialogHeader>
        {d.isPending ? (
          <Skeleton className="h-24" />
        ) : d.isError ? (
          <p className="text-destructive">{errorMessage(t, d.error)}</p>
        ) : !d.data.items.length ? (
          <p className="text-sm text-muted-foreground">{t("reports.noData")}</p>
        ) : (
          <ul className="divide-y text-sm">
            {d.data.items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  {i.taskId && onOpenTask ? (
                    <button
                      type="button"
                      className="block max-w-full truncate text-left font-medium hover:underline"
                      onClick={() => onOpenTask(i.taskId!)}
                    >
                      {i.title}
                    </button>
                  ) : (
                    <p className="truncate font-medium">{i.title}</p>
                  )}
                  <p className="truncate text-xs text-muted-foreground">
                    {when(i.at)}
                    {i.detail ? ` · ${i.detail}` : ""}
                  </p>
                </div>
                <span
                  className={`shrink-0 text-right text-xs tabular-nums ${i.ok === false ? "text-destructive" : i.ok ? "text-success" : ""}`}
                >
                  {i.ok === false
                    ? `✕ ${detailOf(i.value, q!.metric)}`
                    : i.ok
                      ? `✓ ${detailOf(i.value, q!.metric)}`
                      : detailOf(i.value, q!.metric)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
