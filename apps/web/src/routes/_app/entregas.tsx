/**
 * Entregas realizadas (§6.5): por dia, pessoa, categoria, tipo e cliente, a partir das
 * entregas registradas (botão Concluído). Mesma base da produtividade e do contratado × entregue.
 */
import { Card, EmptyState } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { PackageCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import {
  BarList,
  DayColumns,
  ExportMenu,
  LoadingGrid,
  ReportFilters,
  Section,
  Stat,
} from "../../components/reports/report-ui";
import { TaskDrawer } from "../../components/work/task-drawer";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { deliveriesReportQuery, periodSearch, resolvePeriod } from "../../lib/reports";

export const Route = createFileRoute("/_app/entregas")({
  validateSearch: periodSearch.extend({ task: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("reports.read")) throw redirect({ to: "/" });
  },
  component: DeliveriesPage,
});

function DeliveriesPage() {
  const { t, i18n } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/entregas" });
  const p = resolvePeriod(search);
  const q = useQuery(deliveriesReportQuery({ ...p, userId: search.userId, clientId: search.clientId }));
  const [limit, setLimit] = useState(50);
  const when = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  const d = q.data;
  return (
    <>
      <PageHeader title={t("reports.deliveries.title")} description={t("reports.deliveries.subtitle")} />
      <ReportFilters
        search={search}
        onChange={(patch) => void navigate({ search: (s) => ({ ...s, ...patch }) })}
        show={["person", "client"]}
      >
        <ExportMenu
          report="deliveries"
          params={{ from: p.from, to: p.to, userId: search.userId, clientId: search.clientId }}
        />
      </ReportFilters>
      {q.isError ? (
        <p className="text-destructive">{errorMessage(t, q.error)}</p>
      ) : !d ? (
        <LoadingGrid />
      ) : !d.totalDeliveries ? (
        <EmptyState
          icon={<PackageCheck className="size-6" />}
          title={t("reports.deliveries.empty")}
          description={t("reports.deliveries.emptyText")}
        />
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t("reports.pieces")} value={d.totalPieces} />
            <Stat label={t("reports.deliveriesN")} value={d.totalDeliveries} />
            <Stat label={t("reports.people")} value={d.byPerson.length} />
            <Stat label={t("reports.clients")} value={d.byClient.filter((c) => c.client).length} />
          </div>
          <Section title={t("reports.byDay")}>
            <DayColumns days={d.byDay} from={p.from} to={p.to} label={t("reports.byDayLabel")} />
          </Section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t("reports.byPerson")}>
              <BarList items={d.byPerson.map((x) => ({ key: x.userId, label: x.name, value: x.pieces }))} />
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
            <Section title={t("reports.byType")}>
              <BarList
                items={d.byType.map((x) => ({
                  key: x.typeId ?? "none",
                  label: x.label ?? t("reports.noType"),
                  value: x.pieces,
                  title: x.category,
                }))}
              />
            </Section>
            <Section title={t("reports.byClient")}>
              <BarList
                items={d.byClient.map((x) => ({
                  key: x.client?.id ?? "none",
                  label: x.client ? `${x.client.code} · ${x.client.name}` : t("reports.noClient"),
                  value: x.pieces,
                }))}
              />
            </Section>
          </div>
          <Card className="relative overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="px-4 pt-3 text-left text-sm font-medium">{t("reports.records")}</caption>
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("reports.date")}</th>
                  <th className="px-4 py-2 font-medium">{t("reports.person")}</th>
                  <th className="px-4 py-2 font-medium">{t("reports.task")}</th>
                  <th className="px-4 py-2 font-medium">{t("reports.category")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("reports.pieces")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.records.slice(0, limit).map((r) => (
                  <tr key={r.id} className="hover:bg-accent/40">
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                      {when(r.deliveredAt)}
                    </td>
                    <td className="px-4 py-2">{r.user.name}</td>
                    <td className="max-w-72 px-4 py-2">
                      <button
                        type="button"
                        className="block max-w-full truncate text-left hover:underline"
                        onClick={() => void navigate({ search: (s) => ({ ...s, task: r.task.id }) })}
                      >
                        {r.task.title}
                      </button>
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.client ? r.client.code : t("reports.noClient")}
                        {r.type ? ` · ${r.type.label}` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-2">{r.category.id ? r.category.label : t("reports.others")}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.records.length > limit && (
              <div className="border-t p-2 text-center">
                <button
                  type="button"
                  className="text-sm text-primary hover:underline"
                  onClick={() => setLimit((n) => n + 100)}
                >
                  {t("reports.showMore", { n: d.records.length - limit })}
                </button>
              </div>
            )}
          </Card>
        </div>
      )}
      <TaskDrawer
        taskId={search.task ?? null}
        onClose={() => void navigate({ search: (s) => ({ ...s, task: undefined }) })}
      />
    </>
  );
}
