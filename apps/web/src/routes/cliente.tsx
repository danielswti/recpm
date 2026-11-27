/**
 * Portal do cliente (§6.11): área própria, com a marca da agência (logo e cor), para quem tem
 * perfil cliente. Vê só os projetos do próprio cliente e o que a equipe marcou como visível.
 */
import { Avatar, Button, cn, Skeleton } from "@recpm/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { FileSignature, Home, Inbox, LogOut, UserRound } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { NotificationsBell } from "../components/notifications/bell";
import { ThemeToggle } from "../components/theme-toggle";
import { authClient } from "../lib/auth-client";
import { useUserStream } from "../lib/comms";
import { errorMessage } from "../lib/errors";
import { requireUser } from "../lib/guards";
import { portalHomeQuery } from "../lib/portal";
import { applyBrand } from "../lib/theme";

export const Route = createFileRoute("/cliente")({
  beforeLoad: async ({ context, location }) => {
    const me = await requireUser(context.queryClient, location.href);
    if (me.tenant?.role !== "cliente") throw redirect({ to: "/" });
  },
  component: PortalLayout,
});

const NAV = [
  { to: "/cliente", key: "portal.nav.home", icon: Home, exact: true },
  { to: "/cliente/demandas", key: "portal.nav.demands", icon: Inbox },
  { to: "/cliente/documentos", key: "portal.nav.documents", icon: FileSignature },
  { to: "/cliente/perfil", key: "portal.nav.profile", icon: UserRound },
] as const;

function PortalLayout() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const home = useQuery(portalHomeQuery);
  useUserStream(true);
  const color = home.data?.workspace.primaryColor;
  useEffect(() => {
    applyBrand(color);
    return () => applyBrand(null);
  }, [color]);

  const logout = async () => {
    await authClient.signOut();
    qc.clear();
    await navigate({ to: "/entrar" });
  };

  if (home.isError)
    return (
      <div className="mx-auto grid min-h-dvh max-w-md place-content-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold">{t("portal.title")}</h1>
        <p className="text-muted-foreground">{errorMessage(t, home.error)}</p>
        <Button variant="outline" onClick={logout}>
          <LogOut /> {t("nav.logout")}
        </Button>
      </div>
    );

  const ws = home.data?.workspace;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Link to="/cliente" className="flex min-w-0 items-center gap-2">
            {ws?.logoUrl ? (
              <img src={ws.logoUrl} alt="" className="h-8 max-w-28 object-contain" />
            ) : (
              <span className="grid size-8 place-content-center rounded-md bg-primary font-semibold text-primary-foreground">
                {(ws?.name ?? "·").slice(0, 1)}
              </span>
            )}
            <span className="truncate font-semibold">{ws?.name ?? <Skeleton className="h-4 w-28" />}</span>
          </Link>
          <nav aria-label={t("portal.nav.label")} className="ml-6 hidden items-center gap-1 md:flex">
            {NAV.map((n) => (
              <PortalLink key={n.to} item={n} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <NotificationsBell />
            <Button variant="ghost" size="icon" aria-label={t("nav.logout")} onClick={logout}>
              <LogOut />
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 max-w-5xl flex-1 p-4 pb-24 md:p-8">
        {home.data && (
          <p className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Avatar name={home.data.user.name} className="size-5" />
            <span className="truncate">
              {home.data.user.name} · {home.data.client.name}
            </span>
          </p>
        )}
        <Outlet />
      </main>
      <nav
        aria-label={t("portal.nav.label")}
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-background md:hidden"
      >
        {NAV.map((n) => (
          <PortalLink key={n.to} item={n} mobile />
        ))}
      </nav>
    </div>
  );
}

function PortalLink({ item, mobile }: { item: (typeof NAV)[number]; mobile?: boolean }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: "exact" in item }}
      className={cn(
        mobile
          ? "flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground"
          : "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent",
      )}
      activeProps={{
        className: mobile ? "text-primary font-medium" : "bg-primary/15 text-primary font-medium",
      }}
    >
      <Icon className={mobile ? "size-5" : "size-4"} />
      {t(item.key)}
    </Link>
  );
}
