import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@recpm/ui";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Hourglass,
  ShieldCheck,
  ThumbsUp,
  UserPlus,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../components/page-header";
import { UsageMeter } from "../../components/usage-meter";
import { useEntitlements } from "../../lib/plan-limits";
import { meQuery } from "../../lib/queries";
import { tasksSummaryQuery } from "../../lib/work";

export const Route = createFileRoute("/_app/")({ component: Dashboard });

/** Painel: o seu dia (tarefas) e o uso do plano. Os painéis por perfil crescem nas próximas fases. */
function Dashboard() {
  const { t } = useTranslation();
  const { data: me } = useSuspenseQuery(meQuery);
  const { data: ent } = useEntitlements();
  if (!me?.tenant) return null;
  const firstName = me.user.name.split(" ")[0];
  const canInvite = me.tenant.permissions.includes("members.invite");

  return (
    <>
      <PageHeader
        title={t("dashboard.greeting", { name: firstName })}
        description={t("dashboard.intro", { workspace: me.tenant.name })}
      />
      {me.tenant.permissions.includes("tasks.read") && <YourDay />}
      {ent && (
        <Card className="mb-8 max-w-2xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-base">{t("dashboard.planUsage", { plan: ent.plan.name })}</CardTitle>
          </CardHeader>
          <CardContent>
            <UsageMeter e={ent} />
          </CardContent>
        </Card>
      )}
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t("dashboard.nextSteps")}</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {canInvite && (
          <Link to="/membros" className="rounded-xl focus-visible:outline-2">
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader>
                <UserPlus className="size-5 text-primary" />
                <CardTitle className="text-base">{t("dashboard.inviteTeam")}</CardTitle>
                <CardDescription>{t("dashboard.inviteTeamDesc")}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}
        {!me.user.twoFactorEnabled && (
          <Link to="/conta/seguranca" className="rounded-xl">
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader>
                <ShieldCheck className="size-5 text-primary" />
                <CardTitle className="text-base">{t("dashboard.secureAccount")}</CardTitle>
                <CardDescription>{t("dashboard.secureAccountDesc")}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}
      </div>
    </>
  );
}

function YourDay() {
  const { t } = useTranslation();
  const { data } = useQuery(tasksSummaryQuery);
  const cards = [
    {
      key: "overdue",
      icon: AlertTriangle,
      n: data?.overdue,
      tone: "text-destructive",
      search: { scope: "mine", overdue: true },
    },
    {
      key: "due24h",
      icon: Clock,
      n: data?.due24h,
      tone: "text-amber-600 dark:text-amber-400",
      search: { scope: "mine", due24h: true },
    },
    {
      key: "adjustments",
      icon: Wrench,
      n: data?.adjustments,
      tone: "text-amber-600 dark:text-amber-400",
      search: { scope: "mine", status: "ajustes" },
    },
    {
      key: "approvals",
      icon: ThumbsUp,
      n: data?.approvals,
      tone: "text-primary",
      search: { scope: "all", status: "aguardando_aprovacao" },
    },
    {
      key: "waitingClient",
      icon: Hourglass,
      n: data?.waitingClient,
      tone: "text-muted-foreground",
      search: { scope: "mine", waitingClient: true },
    },
    { key: "open", icon: CheckCircle2, n: data?.open, tone: "text-success", search: { scope: "mine" } },
  ] as const;
  return (
    <section className="mb-8" aria-labelledby="your-day">
      <h2 id="your-day" className="mb-3 text-sm font-medium text-muted-foreground">
        {t("dashboard.yourDay")}
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map(({ key, icon: Icon, n, tone, search }) => (
          <Link key={key} to="/tarefas" search={search} className="rounded-xl focus-visible:outline-2">
            <Card className="h-full p-4 transition-colors hover:border-primary/50">
              <Icon className={`size-5 ${tone}`} />
              <p className="mt-2 text-2xl font-semibold tabular-nums">{n ?? "–"}</p>
              <p className="text-xs text-muted-foreground">{t(`dashboard.day.${key}`)}</p>
            </Card>
          </Link>
        ))}
        {!!data?.archiveRequests && (
          <Link to="/tarefas" search={{ scope: "all", archiveRequested: true }} className="rounded-xl">
            <Card className="h-full p-4 transition-colors hover:border-primary/50">
              <p className="text-2xl font-semibold tabular-nums">{data.archiveRequests}</p>
              <p className="text-xs text-muted-foreground">{t("dashboard.day.archiveRequests")}</p>
            </Card>
          </Link>
        )}
      </div>
    </section>
  );
}
