/**
 * Produtividade da equipe (§6.5): placar de produção e de atendimento, por setor, com o
 * destaque do período. Todo número abre os registros por trás dele. Pesos em Configurações.
 */
import { Avatar, Badge, Card, EmptyState } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Award, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import {
  DrillDialog,
  ExportMenu,
  HelpPanel,
  LoadingGrid,
  ReportFilters,
} from "../../components/reports/report-ui";
import { TaskDrawer } from "../../components/work/task-drawer";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import {
  type DrillMetric,
  hours,
  periodSearch,
  productivityReportQuery,
  resolvePeriod,
} from "../../lib/reports";

export const Route = createFileRoute("/_app/produtividade")({
  validateSearch: periodSearch.extend({ task: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("productivity.team")) throw redirect({ to: "/" });
  },
  component: TeamProductivity,
});

function Num({
  v,
  onClick,
  label,
  tone,
}: {
  v: React.ReactNode;
  onClick: () => void;
  label: string;
  tone?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`rounded px-1 tabular-nums underline-offset-4 hover:bg-accent hover:underline ${tone ?? ""}`}
    >
      {v}
    </button>
  );
}

function TeamProductivity() {
  const { t, i18n } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/produtividade" });
  const p = resolvePeriod(search);
  const q = useQuery(productivityReportQuery({ ...p, sectorId: search.sectorId }));
  const { data: me } = useQuery(meQuery);
  const [drill, setDrill] = useState<{ userId: string; metric: DrillMetric; name: string } | null>(null);
  const open = (userId: string, name: string, metric: DrillMetric) => setDrill({ userId, name, metric });
  const d = q.data;
  const W = d?.weights;
  const accounts = d?.rows.filter((r) => r.account).sort((a, b) => b.account!.score - a.account!.score) ?? [];
  const L = i18n.language;

  return (
    <>
      <PageHeader title={t("reports.productivity.title")} description={t("reports.productivity.subtitle")} />
      <ReportFilters
        search={search}
        onChange={(patch) => void navigate({ search: (s) => ({ ...s, ...patch }) })}
        show={["sector"]}
      >
        <ExportMenu report="productivity" params={{ from: p.from, to: p.to, sectorId: search.sectorId }} />
      </ReportFilters>
      {W && (
        <HelpPanel title={t("reports.help.title")}>
          <p>{t("reports.help.intro")}</p>
          <p className="font-medium text-foreground">{t("reports.help.production")}</p>
          <ul className="list-disc pl-5">
            <li>{t("reports.help.perPiece", { n: W.production.perPiece })}</li>
            <li>{t("reports.help.perHour", { n: W.production.perBusinessHour })}</li>
            <li>{t("reports.help.onTime", { n: W.production.onTimeBonus })}</li>
            <li>{t("reports.help.rework", { n: W.production.reworkPenalty })}</li>
          </ul>
          <p className="font-medium text-foreground">{t("reports.help.account")}</p>
          <ul className="list-disc pl-5">
            <li>{t("reports.help.clientDates")}</li>
            <li>{t("reports.help.chases", { n: W.accountManagement.perClientChase })}</li>
            <li>{t("reports.help.shoots", { n: W.accountManagement.perShootBooked })}</li>
            <li>{t("reports.help.amPieces", { n: W.accountManagement.perPiece })}</li>
            <li>
              {t("reports.help.idle", {
                n: W.accountManagement.perIdleCard,
                h: d.idleCardHours,
                cap: W.accountManagement.idleCardPenaltyCap,
              })}
            </li>
          </ul>
          <p>{t("reports.help.drill")}</p>
          {me?.tenant?.permissions.includes("tenant.settings") && (
            <Link
              to="/configuracoes"
              search={{ tab: "productivity" }}
              className="text-primary hover:underline"
            >
              {t("reports.help.editWeights")}
            </Link>
          )}
        </HelpPanel>
      )}
      {q.isError ? (
        <p className="text-destructive">{errorMessage(t, q.error)}</p>
      ) : !d ? (
        <LoadingGrid />
      ) : !d.rows.length ? (
        <EmptyState icon={<Users className="size-6" />} title={t("reports.productivity.empty")} />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Card className="flex items-center gap-4 p-4">
              {d.highlight ? (
                <>
                  <div className="relative">
                    <Avatar name={d.highlight.user.name} src={d.highlight.user.image} className="size-14" />
                    <Award className="absolute -bottom-1 -right-1 size-6 rounded-full bg-background p-0.5 text-amber-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                      {t(
                        p.preset === "month" || p.preset === "lastMonth"
                          ? "reports.productivity.highlightMonth"
                          : "reports.productivity.highlight",
                      )}
                    </p>
                    <p className="truncate text-lg font-semibold">{d.highlight.user.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("reports.productivity.highlightSub", {
                        score: hours(d.highlight.score, L),
                        pieces: d.highlight.pieces,
                      })}
                      {d.highlight.sector ? ` · ${d.highlight.sector.name}` : ""}
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t("reports.productivity.noHighlight")}</p>
              )}
            </Card>
            <Card className="p-4">
              <p className="mb-2 text-sm font-medium">{t("reports.productivity.bySector")}</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {d.sectors.map((s) => (
                  <li
                    key={s.sector?.id ?? "none"}
                    className="flex items-baseline justify-between gap-2 text-sm"
                  >
                    <span className="truncate">
                      {s.sector?.name ?? t("reports.productivity.noSector")}{" "}
                      <span className="text-xs text-muted-foreground">({s.people})</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {t("reports.productivity.sectorLine", {
                        pieces: s.pieces,
                        hours: hours(s.hours, L),
                        score: hours(s.score, L),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card className="relative overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <caption className="px-4 pt-3 text-left text-sm font-medium">
                {t("reports.productivity.production")}
              </caption>
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 px-4 py-2 font-medium">#</th>
                  <th className="px-4 py-2 font-medium">{t("reports.person")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("reports.pieces")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("reports.businessHours")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("reports.onTime")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("reports.reworkInternal")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("reports.score")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.rows.map((r, i) => {
                  const n = r.user.name;
                  return (
                    <tr key={r.user.id}>
                      <td className="px-4 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-2">
                          <Avatar name={n} src={r.user.image} className="size-6" />
                          <span className="min-w-0">
                            <span className="block truncate">{n}</span>
                            {r.sector && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {r.sector.name}
                              </span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Num
                          v={r.production.pieces}
                          label={t("reports.drill.open", { what: t("reports.pieces"), name: n })}
                          onClick={() => open(r.user.id, n, "pieces")}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Num
                          v={hours(r.production.hours, L)}
                          label={t("reports.drill.open", { what: t("reports.businessHours"), name: n })}
                          onClick={() => open(r.user.id, n, "hours")}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Num
                          v={r.production.onTime}
                          label={t("reports.drill.open", { what: t("reports.onTime"), name: n })}
                          onClick={() => open(r.user.id, n, "onTime")}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Num
                          v={r.production.rework}
                          tone={r.production.rework ? "text-destructive" : undefined}
                          label={t("reports.drill.open", { what: t("reports.reworkInternal"), name: n })}
                          onClick={() => open(r.user.id, n, "rework")}
                        />
                      </td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">
                        {hours(r.production.score, L)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {!!accounts.length && (
            <Card className="relative overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <caption className="px-4 pt-3 text-left text-sm font-medium">
                  {t("reports.productivity.account")}
                </caption>
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t("reports.person")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("reports.clientDates")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("reports.chases")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("reports.shoots")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("reports.pieces")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("reports.idleCards")}</th>
                    <th className="px-4 py-2 text-right font-medium">{t("reports.score")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {accounts.map((r) => {
                    const a = r.account!;
                    const n = r.user.name;
                    return (
                      <tr key={r.user.id}>
                        <td className="px-4 py-2">
                          <span className="flex items-center gap-2">
                            <Avatar name={n} src={r.user.image} className="size-6" />
                            <span className="truncate">{n}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Num
                            v={
                              a.clientDatesPct === null
                                ? "—"
                                : `${a.clientDatesPct}% (${a.clientDatesMet}/${a.clientDatesTotal})`
                            }
                            label={t("reports.drill.open", { what: t("reports.clientDates"), name: n })}
                            onClick={() => open(r.user.id, n, "clientDates")}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Num
                            v={a.chases}
                            label={t("reports.drill.open", { what: t("reports.chases"), name: n })}
                            onClick={() => open(r.user.id, n, "chases")}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Num
                            v={a.shoots}
                            label={t("reports.drill.open", { what: t("reports.shoots"), name: n })}
                            onClick={() => open(r.user.id, n, "shoots")}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Num
                            v={a.pieces}
                            label={t("reports.drill.open", { what: t("reports.pieces"), name: n })}
                            onClick={() => open(r.user.id, n, "amPieces")}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Num
                            v={a.idleCards}
                            tone={a.idleCards ? "text-destructive" : undefined}
                            label={t("reports.drill.open", { what: t("reports.idleCards"), name: n })}
                            onClick={() => open(r.user.id, n, "idleCards")}
                          />
                        </td>
                        <td className="px-4 py-2 text-right font-semibold tabular-nums">
                          {hours(a.score, L)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
          <p className="text-xs text-muted-foreground">
            <Badge variant="outline">{t("reports.tip")}</Badge> {t("reports.productivity.clickHint")}
          </p>
        </div>
      )}
      <DrillDialog
        q={drill ? { from: p.from, to: p.to, userId: drill.userId, metric: drill.metric } : null}
        title={
          drill
            ? t("reports.drill.title", { what: t(`reports.drill.metric.${drill.metric}`), name: drill.name })
            : ""
        }
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
