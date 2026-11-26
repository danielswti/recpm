import { Button } from "@recpm/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "../components/auth-layout";
import { authClient } from "../lib/auth-client";
import { requireUser } from "../lib/guards";

/** Portal do cliente (Fase 9). Por ora, só o destino correto para usuários com perfil cliente. */
export const Route = createFileRoute("/cliente")({
  beforeLoad: async ({ context, location }) => {
    const me = await requireUser(context.queryClient, location.href);
    if (me.tenant?.role !== "cliente") throw redirect({ to: "/" });
  },
  component: Portal,
});

function Portal() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (
    <AuthLayout title={t("portal.title")} description={t("portal.soon")}>
      <Button
        variant="outline"
        className="w-full"
        onClick={async () => {
          await authClient.signOut();
          qc.clear();
          await navigate({ to: "/entrar" });
        }}
      >
        {t("nav.logout")}
      </Button>
    </AuthLayout>
  );
}
