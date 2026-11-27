import type { Permission } from "@recpm/shared";
import {
  Avatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@recpm/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  CalendarDays,
  CheckSquare,
  CreditCard,
  FolderKanban,
  Gauge,
  Languages,
  LayoutDashboard,
  ListChecks,
  LogOut,
  type LucideIcon,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Repeat,
  Scale,
  Settings,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../lib/auth-client";
import { LOCALES } from "../lib/i18n";
import type { Me } from "../lib/queries";
import { PlanBanner } from "./plan-banner";
import { ThemeToggle } from "./theme-toggle";
import { UpgradeDialog } from "./upgrade-dialog";

type NavItem = {
  key: string;
  icon: LucideIcon;
  /** Rota já implementada; sem `to`, o item aparece desabilitado com a fase em que chega. */
  to?: "/" | "/membros" | "/assinatura" | "/clientes" | "/cadastros" | "/projetos" | "/tarefas";
  phase?: number;
  perm?: Permission;
};

/** Menu lateral conforme a spec (§7): principal, Gerenciar, Administração. */
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "nav.main",
    items: [
      { key: "nav.dashboard", icon: LayoutDashboard, to: "/" },
      { key: "nav.projects", icon: FolderKanban, to: "/projetos", perm: "projects.read" },
      { key: "nav.tasks", icon: CheckSquare, to: "/tarefas", perm: "tasks.read" },
      { key: "nav.calendar", icon: CalendarDays, phase: 6, perm: "calendar.read" },
      { key: "nav.myProductivity", icon: Gauge, phase: 8, perm: "productivity.own" },
    ],
  },
  {
    group: "nav.manage",
    items: [
      { key: "nav.finance", icon: Wallet, phase: 7, perm: "finance.read" },
      { key: "nav.subscriptions", icon: Repeat, phase: 7, perm: "finance.read" },
      { key: "nav.reports", icon: BarChart3, phase: 8, perm: "reports.read" },
      { key: "nav.productivity", icon: TrendingUp, phase: 8, perm: "productivity.team" },
      { key: "nav.contractedDelivered", icon: Scale, phase: 8, perm: "reports.read" },
      { key: "nav.deliveries", icon: ListChecks, phase: 8, perm: "reports.read" },
      { key: "nav.clients", icon: Building2, to: "/clientes", perm: "clients.read" },
      { key: "nav.users", icon: Users, to: "/membros", perm: "members.read" },
    ],
  },
  {
    group: "nav.admin",
    items: [
      { key: "nav.catalogs", icon: BookOpen, to: "/cadastros", perm: "catalogs.manage" },
      { key: "nav.settings", icon: Settings, phase: 5, perm: "tenant.settings" },
      { key: "nav.billing", icon: CreditCard, to: "/assinatura", perm: "tenant.billing" },
    ],
  },
];

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const perms = new Set(me.tenant?.permissions ?? []);

  const sidebar = (
    <nav aria-label={t("nav.main")} className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <div className="flex items-center gap-2 px-2 py-1">
        <img src="/favicon.svg" alt="" className="size-7 shrink-0" />
        {!collapsed && <span className="truncate font-semibold">{me.tenant?.name ?? "Rec PM"}</span>}
      </div>
      {NAV.map(({ group, items }) => {
        const visible = items.filter((i) => !i.perm || perms.has(i.perm));
        if (!visible.length) return null;
        return (
          <div key={group} className="grid gap-0.5">
            {!collapsed && (
              <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(group)}
              </p>
            )}
            {visible.map((item) => (
              <NavLink
                key={item.key}
                item={item}
                collapsed={collapsed}
                onNavigate={() => setMobileOpen(false)}
              />
            ))}
          </div>
        );
      })}
      <div className="mt-auto">
        <UserCard me={me} collapsed={collapsed} />
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 border-r bg-sidebar text-sidebar-foreground transition-[width] md:block",
          collapsed ? "w-16" : "w-64",
        )}
      >
        {sidebar}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label={t("nav.collapse")}
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 border-r bg-sidebar text-sidebar-foreground">
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={t("nav.openMenu")}
            onClick={() => setMobileOpen(true)}
          >
            <Menu />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <NotificationsBell />
          </div>
        </header>
        {me.impersonating && <ImpersonationBanner me={me} />}
        <PlanBanner canManage={perms.has("tenant.billing")} />
        <main className="flex-1 p-4 md:p-8">{children}</main>
        <UpgradeDialog canManage={perms.has("tenant.billing")} />
      </div>
    </div>
  );
}

function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const label = t(item.key);
  const Icon = item.icon;
  const base = "flex items-center gap-3 rounded-md px-2 py-2 text-sm";
  if (!item.to) {
    const soon = `${t("common.comingSoon")} · ${t("common.phase", { n: item.phase })}`;
    return (
      <span
        className={cn(base, "cursor-not-allowed opacity-45")}
        aria-disabled="true"
        title={`${label} · ${soon}`}
      >
        <Icon className="size-4 shrink-0" />
        {!collapsed && <span className="truncate">{label}</span>}
      </span>
    );
  }
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={cn(base, "hover:bg-accent hover:text-accent-foreground")}
      activeProps={{
        className: "bg-primary/15 text-primary font-medium hover:bg-primary/20 hover:text-primary",
      }}
      activeOptions={{ exact: item.to === "/" }}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

function UserCard({ me, collapsed }: { me: Me; collapsed: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const logout = async () => {
    await authClient.signOut();
    qc.clear();
    await navigate({ to: "/entrar" });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("nav.userMenu")}
        className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-accent"
      >
        <Avatar name={me.user.name} src={me.user.image} />
        {!collapsed && (
          <span className="grid min-w-0 text-sm leading-tight">
            <span className="truncate font-medium">{me.user.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {me.tenant ? t(`roles.${me.tenant.role}`) : me.user.email}
            </span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuLabel className="truncate">{me.user.email}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => navigate({ to: "/conta/seguranca" })}>
          <ShieldCheck /> {t("nav.security")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate({ to: "/workspaces" })}>
          <ArrowLeftRight /> {t("nav.switchWorkspace")}
        </DropdownMenuItem>
        {me.user.platformRole === "super_admin" && !me.impersonating && (
          <DropdownMenuItem onSelect={() => navigate({ to: "/plataforma" })}>
            <Building2 /> {t("nav.platform")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2">
          <Languages className="size-3.5" /> {t("nav.language")}
        </DropdownMenuLabel>
        {LOCALES.map((l) => (
          <DropdownMenuItem key={l.code} onSelect={() => i18n.changeLanguage(l.code)}>
            <span className={cn("ml-6", i18n.language === l.code && "font-semibold text-primary")}>
              {l.label}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>
          <LogOut /> {t("nav.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Faixa fixa enquanto o super_admin navega como outro usuário (sessão de 1 h, auditada). */
function ImpersonationBanner({ me }: { me: Me }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const stop = async () => {
    await authClient.admin.stopImpersonating();
    qc.clear();
    await navigate({ to: "/plataforma" });
  };
  return (
    <div role="status" className="flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm text-black">
      <span>{t("platform.impersonatingAs", { name: me.user.name, tenant: me.tenant?.name ?? "" })}</span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-7 border-black/30 bg-transparent"
        onClick={stop}
      >
        {t("platform.stopImpersonating")}
      </Button>
    </div>
  );
}

/** Sino de notificações — a central real (SSE/WebSocket) chega na Fase 6. */
function NotificationsBell() {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("nav.notifications")}>
          <Bell />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t("nav.notifications")}</DropdownMenuLabel>
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t("nav.noNotifications")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
