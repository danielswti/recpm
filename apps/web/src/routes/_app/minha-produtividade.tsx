/**
 * Minha produtividade (§6.5): minhas entregas e horas úteis no período, entregas por categoria
 * e meus pontos. Cada número abre os registros.
 */
import { Card, EmptyState } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Gauge } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import {
  BarList,
  DayColumns,
  DrillDialog,
  ExportMenu,
  HelpPanel,
  LoadingGrid,
  ReportFilters,
  Section,
  Stat,
} from "../../components/reports/report-ui";
import { TaskDrawer } from "../../components/work/task-drawer";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { type DrillMetric, hours, myProductivityQuery, periodSearch, resolvePeriod } from "../../lib/reports";

export const Route = createFileRoute("/_app/minha-produtividade")({
  validateSearch: periodSearch
    .pick({ preset: true, from: true, to: true })
    .extend({ task: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("productivity.own")) throw redirect({ to: "/" });
  },
  component: MyProductivity,
});

function MyProductivity() {
  const { t, i18n } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/minha-produtividade" });
  const p = resolvePeriod(search);
  const q = useQuery(myProductivityQuery(p));
  const { data: me } = useQuery(meQuery);
  const [drill, setDrill] = useState<DrillMetric | null>(null);
  const d = q.data;
  const prod = d?.me?.production;
  const acc = d?.me?.account;
  const W = d?.weights;
  const L = i18n.language;

  return (
    <>
      <PageHeader title={t("reports.mine.title")} description={t("reports.mine.subtitle")} />
      <ReportFilters
        search={search}
        onChange={(patch) => void navigate({ search: (s) => ({ ...s, ...patch }) })}
      >
        <ExportMenu report="my-productivity" params={{ from: p.from, to: p.to }} />
      </ReportFilters>
      {q.isError ? (
        <p className="text-destructive">{errorMessage(t, q.error)}</p>
      ) : !d ? (
        <LoadingGrid />
      ) : !prod ? (
        <EmptyState icon={<Gauge className="size-6" />} title={t("reports.mine.notMember")} />
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label={t("reports.pieces")} value={prod.pieces} onClick={() => setDrill("pieces")} />
            <Stat
              label={t("reports.businessHours")}
              value={hours(prod.hours, L)}
              onClick={() => setDrill("hours")}
            />
            <Stat label={t("reports.onTime")} value={prod.onTime} onClick={() => setDrill("onTime")} />
            <Stat
              label={t("reports.reworkInternal")}
              value={prod.rework}
              onClick={() => setDrill("rework")}
            />
            <Stat
              label={t("reports.score")}
              value={hours(prod.score, L)}
              sub={acc ? t("reports.mine.accountScore", { n: hours(acc.score, L) }) : undefined}
            />
          </div>
          {W && (
            <HelpPanel title={t("reports.mine.howTitle")}>
              <p>
                {t("reports.mine.how", {
                  piece: W.production.perPiece,
                  hour: W.production.perBusinessHour,
                  onTime: W.production.onTimeBonus,
                  rework: W.production.reworkPenalty,
                })}
              </p>
            </HelpPanel>
          )}
          {!d.deliveries.totalDeliveries ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              {t("reports.mine.noDeliveries")}
            </Card>
          ) : (
            <>
              <Section title={t("reports.byDay")}>
                <DayColumns
                  days={d.deliveries.byDay}
                  from={p.from}
                  to={p.to}
                  label={t("reports.byDayLabel")}
                />
              </Section>
              <div className="grid gap-4 lg:grid-cols-2">
                <Section title={t("reports.byCategory")}>
                  <BarList
                    items={d.deliveries.byCategory.map((x) => ({
                      key: x.slug,
                      label: x.id ? x.label : t("reports.others"),
                      value: x.pieces,
                    }))}
                  />
                </Section>
                <Section title={t("reports.byClient")}>
                  <BarList
                    items={d.deliveries.byClient.map((x) => ({
                      key: x.client?.id ?? "none",
                      label: x.client ? `${x.client.code} · ${x.client.name}` : t("reports.noClient"),
                      value: x.pieces,
                    }))}
                  />
                </Section>
              </div>
            </>
          )}
        </div>
      )}
      <DrillDialog
        q={drill && me?.user ? { from: p.from, to: p.to, userId: me.user.id, metric: drill } : null}
        title={drill ? t(`reports.drill.metric.${drill}`) : ""}
        onClose={() => setDrill(null)}
        onOpenTask={(id) => {
          setDrill(null);
          void navigate({ search: (s) => ({ ...s, task: id }) });
        }}
      />
      <TaskDrawer
        taskId={search.task ?? null}
        onClose={() => void navigate({ search: (s) => ({ ...s, task: undefined }) })}
      />
    </>
  );
}
