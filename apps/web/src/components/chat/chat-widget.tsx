/** Chat flutuante em todas as páginas (menos na própria /chat). */
import { Button, cn } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Maximize2, MessageCircle, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { badgeCount, conversationsQuery } from "../../lib/comms";
import { ChatPanel } from "./chat-panel";

export function ChatWidget() {
  const { t } = useTranslation();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const list = useQuery(conversationsQuery);
  if (path.startsWith("/chat")) return null;
  const unread = list.data?.unread ?? 0;
  return (
    <>
      {open && (
        <section
          aria-label={t("nav.chat")}
          className="fixed inset-0 z-40 flex flex-col bg-popover text-popover-foreground shadow-2xl sm:inset-auto sm:bottom-20 sm:right-4 sm:h-[min(36rem,calc(100dvh-7rem))] sm:w-96 sm:rounded-xl sm:border"
        >
          <div className="flex items-center gap-1 border-b px-3 py-1.5">
            <h2 className="flex-1 text-sm font-semibold">{t("nav.chat")}</h2>
            <Button variant="ghost" size="icon" className="size-8" asChild>
              <Link
                to="/chat"
                search={active ? { c: active } : {}}
                aria-label={t("chat.openFull")}
                onClick={() => setOpen(false)}
              >
                <Maximize2 className="size-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t("common.close")}
              onClick={() => setOpen(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel compact activeId={active} onSelect={setActive} />
          </div>
        </section>
      )}
      <Button
        size="icon"
        className={cn("fixed bottom-4 right-4 z-40 size-12 rounded-full shadow-lg", open && "max-sm:hidden")}
        aria-label={unread ? t("chat.widgetUnread", { count: unread }) : t("nav.chat")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <X /> : <MessageCircle />}
        {!open && unread > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white"
          >
            {badgeCount(unread)}
          </span>
        )}
      </Button>
    </>
  );
}
