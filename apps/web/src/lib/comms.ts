/** Notificações, agenda e chat (Fase 6): consultas, o fluxo SSE do usuário e o "digitando". */
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { useEffect } from "react";
import { create } from "zustand";
import { api, unwrap } from "./api";

// ── notificações ────────────────────────────────────────────────────────────
export const notificationsQuery = queryOptions({
  queryKey: ["notifications", "list"],
  queryFn: () => unwrap(api.notifications.$get({ query: { limit: "30" } as never })),
});
export type NotificationItem = InferResponseType<typeof api.notifications.$get, 200>["data"][number];
export const unreadCountQuery = queryOptions({
  queryKey: ["notifications", "unread"],
  queryFn: () => unwrap(api.notifications["unread-count"].$get()),
  refetchInterval: 120_000,
});
export const notificationPrefsQuery = queryOptions({
  queryKey: ["notifications", "preferences"],
  queryFn: () => unwrap(api.notifications.preferences.$get()),
});
export type NotificationPref = InferResponseType<
  typeof api.notifications.preferences.$get,
  200
>["data"][number];

/** "99+" a partir de 100. */
export const badgeCount = (n: number) => (n > 99 ? "99+" : String(n));

// ── agenda ──────────────────────────────────────────────────────────────────
export type CalendarTab = "schedule" | "team" | "deliveries";
export const calendarQuery = (f: {
  from: string;
  to: string;
  tab: CalendarTab;
  types?: string;
  mine?: boolean;
}) =>
  queryOptions({
    queryKey: ["calendar", f],
    queryFn: () =>
      unwrap(
        api.calendar.$get({
          query: {
            from: f.from,
            to: f.to,
            tab: f.tab,
            ...(f.types ? { types: f.types } : {}),
            ...(f.mine ? { mine: "true" } : {}),
          } as never,
        }),
      ),
  });
export type CalendarItem = InferResponseType<typeof api.calendar.$get, 200>["data"][number];
export const holidaysQuery = queryOptions({
  queryKey: ["calendar", "holidays"],
  queryFn: () => unwrap(api.calendar.holidays.$get()),
});

// ── chat ────────────────────────────────────────────────────────────────────
export const conversationsQuery = queryOptions({
  queryKey: ["chat", "conversations"],
  queryFn: () => unwrap(api.chat.conversations.$get()),
});
export type Conversation = InferResponseType<typeof api.chat.conversations.$get, 200>["data"][number];
export const messagesQuery = (id: string) =>
  queryOptions({
    queryKey: ["chat", "messages", id],
    queryFn: () =>
      unwrap(api.chat.conversations[":id"].messages.$get({ param: { id }, query: { limit: "50" } as never })),
  });
export type ChatMessage = InferResponseType<
  (typeof api.chat.conversations)[":id"]["messages"]["$get"],
  200
>["data"][number];

/** Quem está digitando em cada conversa (some sozinho depois de 4 s). */
type Typing = { at: number; name: string };
export const useTypingStore = create<{
  typing: Record<string, Record<string, Typing>>;
  add: (conv: string, userId: string, name: string) => void;
  clear: (conv: string, userId: string) => void;
}>((set) => ({
  typing: {},
  add: (conv, userId, name) =>
    set((s) => ({
      typing: { ...s.typing, [conv]: { ...s.typing[conv], [userId]: { at: Date.now(), name } } },
    })),
  clear: (conv, userId) =>
    set((s) => {
      const c = { ...s.typing[conv] };
      delete c[userId];
      return { typing: { ...s.typing, [conv]: c } };
    }),
}));
export function useTypingNames(conv: string | null) {
  const map = useTypingStore((s) => (conv ? s.typing[conv] : undefined));
  return Object.values(map ?? {})
    .filter((x) => Date.now() - x.at < 4000)
    .map((x) => x.name);
}

/** Um único fluxo SSE por aba: atualiza o sino, as conversas e o "digitando". */
export function useUserStream(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/v1/stream", { withCredentials: true });
    es.addEventListener("notification", (e) => {
      const { unread } = JSON.parse((e as MessageEvent).data) as { unread: number };
      const prev = qc.getQueryData<{ unread: number }>(unreadCountQuery.queryKey);
      qc.setQueryData(unreadCountQuery.queryKey, { unread });
      if (prev && prev.unread !== unread)
        void qc.invalidateQueries({ queryKey: notificationsQuery.queryKey });
    });
    es.addEventListener("chat", (e) => {
      const { conversationId } = JSON.parse((e as MessageEvent).data) as { conversationId: string };
      void qc.invalidateQueries({ queryKey: conversationsQuery.queryKey });
      void qc.invalidateQueries({ queryKey: ["chat", "messages", conversationId] });
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    es.addEventListener("typing", (e) => {
      const { conversationId, userId, name } = JSON.parse((e as MessageEvent).data) as {
        conversationId: string;
        userId: string;
        name: string;
      };
      const st = useTypingStore.getState();
      st.add(conversationId, userId, name);
      const key = `${conversationId}:${userId}`;
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => st.clear(conversationId, userId), 4000),
      );
    });
    return () => {
      es.close();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [enabled, qc]);
}

/** Datas locais "AAAA-MM-DD" (sem fuso). */
export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parseYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
