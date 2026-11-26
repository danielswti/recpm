import { Card, CardDescription, CardHeader, CardTitle } from "@recpm/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../components/page-header";
import { meQuery } from "../../lib/queries";

export const Route = createFileRoute("/_app/")({ component: Dashboard });

/** Dashboard por perfil chega na Fase 4+; por ora, boas-vindas e próximos passos da conta. */
function Dashboard() {
  const { t } = useTranslation();
  const { data: me } = useSuspenseQuery(meQuery);
  if (!me?.tenant) return null;
  const firstName = me.user.name.split(" ")[0];
  const canInvite = me.tenant.permissions.includes("members.invite");

  return (
    <>
      <PageHeader
        title={t("dashboard.greeting", { name: firstName })}
        description={t("dashboard.intro", { workspace: me.tenant.name })}
      />
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
