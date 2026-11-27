/** Chat (§6.9) em tela cheia: lista de conversas e a conversa aberta (?c=). */
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ChatPanel } from "../../components/chat/chat-panel";
import { meQuery } from "../../lib/queries";

const searchSchema = z.object({ c: z.string().optional() });

export const Route = createFileRoute("/_app/chat")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("chat.use")) throw redirect({ to: "/" });
  },
  component: ChatPage,
});

function ChatPage() {
  const { t } = useTranslation();
  const { c } = Route.useSearch();
  const navigate = useNavigate({ from: "/chat" });
  // ocupa exatamente o resto da tela (abaixo do cabeçalho e de avisos como o do plano)
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const fit = () => {
      const el = box.current;
      if (el) setHeight(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY));
    };
    fit();
    window.addEventListener("resize", fit);
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("resize", fit);
      ro.disconnect();
    };
  }, []);
  return (
    <div
      ref={box}
      style={{ height }}
      className="-mx-4 -mb-20 -mt-4 flex min-h-80 flex-col md:-mx-8 md:-mb-24 md:-mt-8 md:p-6"
    >
      <h1 className="sr-only">{t("nav.chat")}</h1>
      <ChatPanel activeId={c ?? null} onSelect={(id) => void navigate({ search: id ? { c: id } : {} })} />
    </div>
  );
}
