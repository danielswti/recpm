import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "../components/app-shell";
import { requireUser } from "../lib/guards";
import { meQuery, workspaceQuery } from "../lib/queries";
import { applyBrand } from "../lib/theme";

/** Área logada da equipe: exige sessão e workspace ativo; cliente vai para o portal. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const me = await requireUser(context.queryClient, location.href);
    if (!me.tenant)
      throw redirect({
        to: me.user.platformRole === "super_admin" && !me.impersonating ? "/plataforma" : "/workspaces",
      });
    if (me.tenant.role === "cliente") throw redirect({ to: "/cliente" });
  },
  component: AppLayout,
});

function AppLayout() {
  const { data: me } = useSuspenseQuery(meQuery);
  const { data: ws } = useQuery(workspaceQuery);
  useEffect(() => {
    applyBrand(ws?.branding?.primaryColor);
    return () => applyBrand(null);
  }, [ws?.branding?.primaryColor]);
  if (!me) return null;
  return (
    <AppShell me={me}>
      <Outlet />
    </AppShell>
  );
}
