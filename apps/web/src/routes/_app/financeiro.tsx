/**
 * Financeiro (§6.6): KPIs (recebido no mês, pendente, atrasado, a receber em 30 dias, MRR),
 * mensalidades ativas com selo "em dia" e a tabela de contratos dos projetos.
 */
import { Badge, Card, EmptyState, Skeleton } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AlertTriangle, CalendarClock, CheckCircle2, Hourglass, Repeat, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/errors";
import { brl, CONTRACT_TONE, financeOverviewQuery } from "../../lib/finance";
import { meQuery } from "../../lib/queries";
import { calendarDate } from "../../lib/work";

export const Route = createFileRoute("/_app/financeiro")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("finance.read")) throw redirect({ to: "/" });
  },
  component: FinancePage,
});

function FinancePage() {
  const { t, i18n } = useTranslation();
  const q = useQuery(financeOverviewQuery);
  const L = i18n.language;

  if (q.isError) return <p className="text-destructive">{errorMessage(t, q.error)}</p>;
  const d = q.data;
  const kpis = d
    ? [
        {
          k: "received",
          v: brl(d.kpis.receivedCents, L),
          sub: t("finance.kpi.receivedSub", { count: d.kpis.paymentsCount }),
          icon: CheckCircle2,
          tone: "text-success",
        },
        { k: "pending", v: brl(d.kpis.pendingCents, L), icon: Hourglass, tone: "text-muted-foreground" },
        {
          k: "overdue",
          v: brl(d.kpis.overdueCents, L),
          sub: t("finance.kpi.overdueSub", { count: d.kpis.overdueCount }),
          icon: AlertTriangle,
          tone: d.kpis.overdueCents ? "text-destructive" : "text-muted-foreground",
        },
        { k: "receivable30", v: brl(d.kpis.receivable30Cents, L), icon: CalendarClock, tone: "text-primary" },
        {
          k: "mrr",
          v: brl(d.kpis.mrrCents, L),
          sub: t("finance.kpi.mrrSub", { count: d.kpis.activeSubscriptions }),
          icon: Repeat,
          tone: "text-primary",
        },
      ]
    : [];

  return (
    <>
      <PageHeader
        title={t("finance.title")}
        description={
          d
            ? t("finance.subtitle", {
                from: calendarDate(d.period.from, L),
                to: calendarDate(d.period.to, L),
              })
            : undefined
        }
      />
      <section
        aria-label={t("finance.kpisLabel")}
        className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
      >
        {!d
          ? ["a", "b", "c", "d", "e"].map((k) => <Skeleton key={k} className="h-24" />)
          : kpis.map(({ k, v, sub, icon: Icon, tone }) => (
              <Card key={k} className={`p-4 ${k === "mrr" ? "col-span-2 md:col-span-1" : ""}`}>
                <Icon className={`size-5 ${tone}`} />
                <p className="mt-2 truncate text-xl font-semibold tabular-nums">{v}</p>
                <p className="text-xs text-muted-foreground">{t(`finance.kpi.${k}`)}</p>
                {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
              </Card>
            ))}
      </section>

      <section className="mb-8" aria-labelledby="fin-subs">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="fin-subs" className="text-sm font-medium text-muted-foreground">
            {t("finance.activeSubscriptions")}
          </h2>
          <Link to="/mensalidades" className="text-sm text-primary hover:underline">
            {t("finance.seeAll")}
          </Link>
        </div>
        {!d ? (
          <Skeleton className="h-24" />
        ) : !d.subscriptions.length ? (
          <Card className="p-4 text-sm text-muted-foreground">{t("finance.noActiveSubscriptions")}</Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {d.subscriptions.map((s) => (
              <Card key={s.id} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{s.client.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {s.project?.name ?? s.client.code}
                    {s.nextDueDate
                      ? ` · ${t("finance.nextDue", { date: calendarDate(s.nextDueDate, L) })}`
                      : ""}
                  </p>
                </div>
                <div className="grid justify-items-end gap-1">
                  <span className="font-semibold tabular-nums">{brl(s.amountCents, L)}</span>
                  <Badge variant={s.upToDate ? "success" : "destructive"}>
                    {t(s.upToDate ? "finance.upToDate" : "finance.behind")}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="fin-contracts">
        <h2 id="fin-contracts" className="mb-3 text-sm font-medium text-muted-foreground">
          {t("finance.contracts")}
        </h2>
        {!d ? (
          <Skeleton className="h-40" />
        ) : !d.contracts.length ? (
          <EmptyState
            icon={<Wallet className="size-6" />}
            title={t("finance.noContracts")}
            description={t("finance.noContractsOverview")}
          />
        ) : (
          <Card className="relative overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("finance.cols.project")}</th>
                  <th className="px-4 py-2 font-medium">{t("finance.modality")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("finance.stats.total")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("finance.stats.paid")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("finance.stats.remaining")}</th>
                  <th className="px-4 py-2 font-medium">{t("finance.cols.status")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.contracts.map((c) => (
                  <tr key={c.id} className="hover:bg-accent/40">
                    <td className="px-4 py-3">
                      <Link
                        to="/projetos/$id"
                        params={{ id: c.project.id }}
                        search={{ tab: "financeiro" }}
                        className="grid hover:underline"
                      >
                        <span className="font-medium">{c.project.name}</span>
                        {c.project.clientCode && (
                          <span className="font-mono text-xs text-muted-foreground">
                            {c.project.clientCode}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {t(`finance.modalities.${c.modality}`)}
                      <span className="block text-xs text-muted-foreground">
                        {t("finance.countShort", { count: c.installmentsCount })}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{brl(c.totalValueCents, L)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-success">{brl(c.paidCents, L)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {brl(c.remainingCents, L)}
                      {!!c.overdueCents && (
                        <span className="block text-xs text-destructive">
                          {t("finance.overdueAmount", { amount: brl(c.overdueCents, L) })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={CONTRACT_TONE[c.status]}>
                        {t(`finance.contractStatus.${c.status}`)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </>
  );
}
