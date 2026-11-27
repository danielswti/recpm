/**
 * Relatórios (§6.5): peças entregues por tipo, ajustes (pessoa, motivo, categoria, interno ×
 * cliente, % do tempo em retrabalho) e financeiro (recebido, pagamentos, contratos em atraso).
 */
import { Card, cn, EmptyState } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { BarChart3 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import {
  BarList,
  ExportMenu,
  HelpPanel,
  LoadingGrid,
  ReportFilters,
  Section,
  Stat,
} from "../../components/reports/report-ui";
import { TaskDrawer } from "../../components/work/task-drawer";
import { errorMessage } from "../../lib/errors";
import { brl } from "../../lib/finance";
import { meQuery } from "../../lib/queries";
import {
  adjustmentsReportQuery,
  deliveriesReportQuery,
  financialReportQuery,
  periodSearch,
  resolvePeriod,
} from "../../lib/reports";

const TABS = ["tipos", "ajustes", "financeiro"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/relatorios")({
  validateSearch: periodSearch.extend({ tab: z.enum(TABS).optional(), task: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("reports.read")) throw redirect({ to: "/" });
  },
  component: ReportsPage,
});

function ReportsPage() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/relatorios" });
  const { data: me } = useQuery(meQuery);
  const canFinance = !!me?.tenant?.permissions.includes("finance.read");
  const tabs = TABS.filter((k) => k !== "financeiro" || canFinance);
  const tab: Tab = search.tab && tabs.includes(search.tab) ? search.tab : "tipos";
  const p = resolvePeriod(search);
  const show: ("person" | "client")[] = tab === "financeiro" ? ["client"] : ["person", "client"];
  const params = {
    from: p.from,
    to: p.to,
    clientId: search.clientId,
    userId: tab === "financeiro" ? undefined : search.userId,
  };
  const report = tab === "tipos" ? "deliveries" : tab === "ajustes" ? "adjustments" : "financial";

  return (
    <>
      <PageHeader title={t("reports.all.title")} description={t("reports.all.subtitle")} />
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b">
        {tabs.map((k) => (
          <Link
            key={k}
            role="tab"
            aria-selected={tab === k}
            to="/relatorios"
            search={(s) => ({ ...s, tab: k === "tipos" ? undefined : k })}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 pb-2 text-sm",
              tab === k
                ? "border-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`reports.all.tabs.${k}`)}
          </Link>
        ))}
      </div>
      <ReportFilters
        search={search}
        onChange={(patch) => void navigate({ search: (s) => ({ ...s, ...patch }) })}
        show={show}
      >
        <ExportMenu report={report} params={params} />
      </ReportFilters>
      {tab === "tipos" && <TypesTab q={params} />}
      {tab === "ajustes" && (
        <AdjustmentsTab
          q={params}
          onOpenTask={(id) => void navigate({ search: (s) => ({ ...s, task: id }) })}
        />
      )}
      {tab === "financeiro" && canFinance && <FinancialTab q={params} />}
      <TaskDrawer
        taskId={search.task ?? null}
        onClose={() => void navigate({ search: (s) => ({ ...s, task: undefined }) })}
      />
    </>
  );
}

type Q = { from: string; to: string; userId?: string; clientId?: string };

function TypesTab({ q }: { q: Q }) {
  const { t } = useTranslation();
  const r = useQuery(deliveriesReportQuery(q));
  const d = r.data;
  if (r.isError) return <p className="text-destructive">{errorMessage(t, r.error)}</p>;
  if (!d) return <LoadingGrid />;
  if (!d.totalPieces)
    return <EmptyState icon={<BarChart3 className="size-6" />} title={t("reports.deliveries.empty")} />;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t("reports.pieces")} value={d.totalPieces} />
        <Stat label={t("reports.types")} value={d.byType.length} />
      </div>
      <Section title={t("reports.byType")}>
        <BarList
          items={d.byType.map((x) => ({
            key: x.typeId ?? "none",
            label: x.label ?? t("reports.noType"),
            value: x.pieces,
            title: `${x.label ?? t("reports.noType")} · ${x.category === "Outros" ? t("reports.others") : x.category}: ${x.pieces}`,
          }))}
        />
      </Section>
      <Section title={t("reports.byCategory")}>
        <BarList
          items={d.byCategory.map((x) => ({
            key: x.slug,
            label: x.id ? x.label : t("reports.others"),
            value: x.pieces,
          }))}
        />
      </Section>
    </div>
  );
}

function AdjustmentsTab({ q, onOpenTask }: { q: Q; onOpenTask: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const r = useQuery(adjustmentsReportQuery(q));
  const [limit, setLimit] = useState(50);
  const d = r.data;
  const num = (v: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(v);
  const when = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  if (r.isError) return <p className="text-destructive">{errorMessage(t, r.error)}</p>;
  if (!d) return <LoadingGrid />;
  const split = (x: { internal: number; client: number }) =>
    t("reports.adj.split", { internal: x.internal, client: x.client });
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t("reports.adj.total")} value={d.total} />
        <Stat label={t("reports.adj.internal")} value={d.internal} />
        <Stat label={t("reports.adj.client")} value={d.client} />
        <Stat
          label={t("reports.adj.reworkPct")}
          value={`${num(d.rework.pct)}%`}
          sub={t("reports.adj.reworkOf", {
            rework: num(d.rework.reworkHours),
            worked: num(d.rework.workedHours),
          })}
        />
      </div>
      <HelpPanel title={t("reports.help.title")}>
        <ul className="list-disc pl-5">
          <li>{t("reports.adj.help.kinds")}</li>
          <li>{t("reports.adj.help.rework")}</li>
        </ul>
      </HelpPanel>
      {!d.total && !d.rework.workedHours ? (
        <EmptyState icon={<BarChart3 className="size-6" />} title={t("reports.adj.empty")} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Section title={t("reports.byPerson")}>
              <BarList
                empty={t("reports.adj.noResponsible")}
                items={d.byPerson
                  .filter((x) => x.total && x.userId)
                  .map((x) => ({
                    key: x.userId ?? "",
                    label: x.name,
                    value: x.total,
                    title: `${x.name}: ${split(x)}`,
                  }))}
              />
            </Section>
            <Section title={t("reports.adj.byReason")}>
              <BarList
                items={d.byReason.map((x) => ({
                  key: x.reason,
                  label: x.reason,
                  value: x.total,
                  title: `${x.reason}: ${split(x)}`,
                }))}
              />
            </Section>
            <Section title={t("reports.byCategory")}>
              <BarList
                items={d.byCategory.map((x) => ({
                  key: x.label,
                  label: x.label,
                  value: x.total,
                  title: `${x.label}: ${split(x)}`,
                }))}
              />
            </Section>
          </div>
          {!!d.byPerson.length && (
            <Card className="relative min-w-0 overflow-x-auto">
              <p className="px-4 pt-3 text-sm font-medium">{t("reports.adj.peopleTable")}</p>
              <table className="w-full min-w-[520px] text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t("reports.person")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("reports.adj.internal")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("reports.adj.client")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("reports.adj.reworkHours")}</th>
                    <th className="px-4 py-2 text-right font-medium">{t("reports.adj.reworkPct")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {d.byPerson.map((x) => (
                    <tr key={x.userId ?? "none"}>
                      <td className="px-4 py-2">{x.name ?? t("reports.adj.noOne")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{x.internal}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{x.client}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {num(x.reworkHours)} / {num(x.workedHours)} h
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {x.workedHours ? `${num((x.reworkHours / x.workedHours) * 100)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {!!d.records.length && (
            <Card className="relative min-w-0 overflow-x-auto">
              <p className="px-4 pt-3 text-sm font-medium">{t("reports.records")}</p>
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t("reports.when")}</th>
                    <th className="px-3 py-2 font-medium">{t("reports.task")}</th>
                    <th className="px-3 py-2 font-medium">{t("reports.adj.kind")}</th>
                    <th className="px-3 py-2 font-medium">{t("reports.adj.reason")}</th>
                    <th className="px-3 py-2 font-medium">{t("reports.adj.responsible")}</th>
                    <th className="px-4 py-2 font-medium">{t("reports.client")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {d.records.slice(0, limit).map((x) => (
                    <tr key={x.id}>
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums">{when(x.createdAt)}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-left hover:underline"
                          onClick={() => onOpenTask(x.task.id)}
                        >
                          {x.task.title}
                        </button>
                      </td>
                      <td className="px-3 py-2">{t(`reports.adj.kinds.${x.kind}`)}</td>
                      <td className="px-3 py-2">{x.reason}</td>
                      <td className="px-3 py-2">{x.responsible?.name ?? "—"}</td>
                      <td className="px-4 py-2">{x.client ? x.client.code : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.records.length > limit && (
                <button
                  type="button"
                  className="w-full border-t py-2 text-sm text-primary hover:underline"
                  onClick={() => setLimit((l) => l + 50)}
                >
                  {t("reports.showMore", { n: d.records.length - limit })}
                </button>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function FinancialTab({ q }: { q: Q }) {
  const { t, i18n } = useTranslation();
  const r = useQuery(financialReportQuery(q));
  const d = r.data;
  const L = i18n.language;
  const date = (s: string) =>
    new Intl.DateTimeFormat(L, { dateStyle: "short", timeZone: s.length === 10 ? "UTC" : undefined }).format(
      new Date(s.length === 10 ? `${s}T12:00:00Z` : s),
    );
  if (r.isError) return <p className="text-destructive">{errorMessage(t, r.error)}</p>;
  if (!d) return <LoadingGrid />;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t("reports.fin.received")} value={brl(d.receivedCents, L)} />
        <Stat label={t("reports.fin.payments")} value={d.paymentsCount} />
        <Stat
          label={t("reports.fin.overdue")}
          value={brl(d.overdueCents, L)}
          sub={t("reports.fin.overdueContracts", { count: d.overdueContracts.length })}
        />
      </div>
      <Card className="relative min-w-0 overflow-x-auto">
        <p className="px-4 pt-3 text-sm font-medium">{t("reports.fin.paymentsTitle")}</p>
        {!d.payments.length ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t("reports.fin.noPayments")}</p>
        ) : (
          <table className="w-full min-w-[620px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("reports.fin.paidAt")}</th>
                <th className="px-3 py-2 font-medium">{t("reports.client")}</th>
                <th className="px-3 py-2 font-medium">{t("reports.fin.origin")}</th>
                <th className="px-3 py-2 font-medium">{t("reports.fin.method")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("reports.fin.amount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {d.payments.map((x) => (
                <tr key={x.id}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">{date(x.paidAt)}</td>
                  <td className="px-3 py-2">{x.client ? `${x.client.code} · ${x.client.name}` : "—"}</td>
                  <td className="px-3 py-2">
                    {t(`reports.fin.sources.${x.source}`)}
                    {x.project ? ` · ${x.project}` : ""} · {x.number}
                  </td>
                  <td className="px-3 py-2">{x.method ?? "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{brl(x.amountCents, L)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {!!d.overdueContracts.length && (
        <Card className="relative min-w-0 overflow-x-auto">
          <p className="px-4 pt-3 text-sm font-medium">{t("reports.fin.overdueTitle")}</p>
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("reports.project")}</th>
                <th className="px-3 py-2 font-medium">{t("reports.client")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("reports.fin.installments")}</th>
                <th className="px-3 py-2 font-medium">{t("reports.fin.oldest")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("reports.fin.amount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {d.overdueContracts.map((x) => (
                <tr key={x.contractId}>
                  <td className="px-4 py-2">
                    {x.project ? (
                      <Link
                        to="/projetos/$id"
                        params={{ id: x.project.id }}
                        search={{ tab: "financeiro" }}
                        className="hover:underline"
                      >
                        {x.project.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">{x.client ? `${x.client.code} · ${x.client.name}` : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{x.installments}</td>
                  <td className="px-3 py-2 tabular-nums">{date(x.oldestDueDate)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-destructive">
                    {brl(x.amountCents, L)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
