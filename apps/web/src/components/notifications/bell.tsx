/** Sino (§6.10): contador de não lidas (99+), lista, marcar uma ou todas como lidas. */
import { notificationPath } from "@recpm/shared";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bell, CheckCheck, Settings2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, unwrapVoid } from "../../lib/api";
import { badgeCount, type NotificationItem, notificationsQuery, unreadCountQuery } from "../../lib/comms";

export function NotificationsBell() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const count = useQuery(unreadCountQuery).data?.unread ?? 0;
  const list = useQuery({ ...notificationsQuery, enabled: open });
  const refresh = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const markRead = useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) =>
      unwrapVoid(api.notifications[":id"].read.$post({ param: { id }, json: { read } })),
    onSettled: refresh,
  });
  const readAll = useMutation({
    mutationFn: () => unwrapVoid(api.notifications["read-all"].$post()),
    onSettled: refresh,
  });
  const rel = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto", style: "short" });
  const ago = (iso: string) => {
    const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (min < 60) return rel.format(-min, "minute");
    if (min < 1440) return rel.format(-Math.round(min / 60), "hour");
    return rel.format(-Math.round(min / 1440), "day");
  };
  const openItem = (n: NotificationItem) => {
    if (!n.read) markRead.mutate({ id: n.id, read: true });
    setOpen(false);
    void navigate({ href: notificationPath(n.referenceType, n.referenceId) });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={count ? t("notifications.bellUnread", { count }) : t("nav.notifications")}
        >
          <Bell />
          {count > 0 && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white"
            >
              {badgeCount(count)}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-1rem))] p-0">
        <div className="flex items-center gap-2 px-3 py-2">
          <DropdownMenuLabel className="p-0">{t("nav.notifications")}</DropdownMenuLabel>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            disabled={!count || readAll.isPending}
            onClick={() => readAll.mutate()}
          >
            <CheckCheck className="size-3.5" /> {t("notifications.readAll")}
          </Button>
          <Button variant="ghost" size="icon" className="size-7" asChild>
            <Link
              to="/conta/notificacoes"
              aria-label={t("notifications.preferences")}
              onClick={() => setOpen(false)}
            >
              <Settings2 className="size-3.5" />
            </Link>
          </Button>
        </div>
        <DropdownMenuSeparator className="m-0" />
        <div className="max-h-[min(28rem,70vh)] overflow-y-auto">
          {list.isPending ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : !list.data?.data.length ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("nav.noNotifications")}</p>
          ) : (
            <ul className="divide-y">
              {list.data.data.map((n) => (
                <li
                  key={n.id}
                  className={cn("group relative flex gap-2 px-3 py-2.5", !n.read && "bg-primary/5")}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      n.read ? "bg-transparent" : "bg-primary",
                    )}
                  />
                  <button type="button" className="grid min-w-0 flex-1 text-left" onClick={() => openItem(n)}>
                    <span className={cn("text-sm", !n.read && "font-medium")}>{n.title}</span>
                    {n.message && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">{n.message}</span>
                    )}
                    <span className="mt-0.5 text-[11px] text-muted-foreground">{ago(n.createdAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="h-6 shrink-0 self-start rounded px-1.5 text-[11px] text-muted-foreground opacity-100 hover:bg-accent sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                    onClick={() => markRead.mutate({ id: n.id, read: !n.read })}
                  >
                    {n.read ? t("notifications.markUnread") : t("notifications.markRead")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
