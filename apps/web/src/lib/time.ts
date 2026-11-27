/** Tempo ("Estou nessa"), entregas, ajustes e configurações: consultas e utilidades. */
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "./api";
import { errorMessage } from "./errors";

export const currentTimerQuery = queryOptions({
  queryKey: ["time", "current"],
  queryFn: () => unwrap(api.time.current.$get()),
  refetchInterval: 60_000,
  refetchOnWindowFocus: true,
});
export type CurrentTimer = InferResponseType<typeof api.time.current.$get, 200>;

export const taskTimeQuery = (id: string) =>
  queryOptions({
    queryKey: ["time", "task", id],
    queryFn: () => unwrap(api.tasks[":id"].time.$get({ param: { id } })),
  });
export const taskDeliveriesQuery = (id: string) =>
  queryOptions({
    queryKey: ["time", "deliveries", id],
    queryFn: () => unwrap(api.tasks[":id"].deliveries.$get({ param: { id } })),
  });

export const adjustmentsQuery = (status: "pending" | "reviewed" | "all", mine?: boolean) =>
  queryOptions({
    queryKey: ["time", "adjustments", status, !!mine],
    queryFn: () =>
      unwrap(api.time.adjustments.$get({ query: { status, ...(mine ? { mine: "true" } : {}) } as never })),
  });
export type TimeAdjustment = InferResponseType<typeof api.time.adjustments.$get, 200>["data"][number];

export const workingNowQuery = queryOptions({
  queryKey: ["time", "working-now"],
  queryFn: () => unwrap(api.time["working-now"].$get()),
});
export type WorkingNow = InferResponseType<(typeof api.time)["working-now"]["$get"], 200>;

export const timeEntriesQuery = (f: { userId?: string; from?: string; to?: string }) =>
  queryOptions({
    queryKey: ["time", "entries", f],
    queryFn: () =>
      unwrap(
        api.time.entries.$get({
          query: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as never,
        }),
      ),
  });

export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: () => unwrap(api.settings.$get()),
});
export type WorkspaceSettings = InferResponseType<typeof api.settings.$get, 200>;
export const apiKeysQuery = queryOptions({
  queryKey: ["settings", "api-keys"],
  queryFn: () => unwrap(api.settings["api-keys"].$get()),
});

/** "2h 05min", "12min", "45s". */
export function formatDuration(ms: number, opts: { seconds?: boolean } = {}) {
  const neg = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  let out: string;
  if (h) out = `${h}h ${String(m).padStart(2, "0")}min`;
  else if (m || !opts.seconds) out = opts.seconds ? `${m}min ${String(s).padStart(2, "0")}s` : `${m}min`;
  else out = `${s}s`;
  return neg ? `−${out}` : out;
}

/** Relógio que anda a cada segundo a partir de um valor do servidor (para o timer na tela). */
export function useTicking(baseMs: number | null | undefined, running: boolean) {
  // âncora = (valor do servidor, quando chegou); a cada novo valor o relógio recomeça dele
  const [anchor, setAnchor] = useState({ base: baseMs, at: Date.now() });
  if (anchor.base !== baseMs) setAnchor({ base: baseMs, at: Date.now() });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [running]);
  if (baseMs == null) return null;
  return running ? baseMs + Math.max(0, now - anchor.at) : baseMs;
}

/** Iniciar/parar o timer, atualizando o que depende dele. */
export function useTimer() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["time"] });
  };
  const start = useMutation({
    mutationFn: (taskId: string) => unwrap(api.time.start.$post({ json: { taskId } })),
    onSuccess: (data) => {
      qc.setQueryData(currentTimerQuery.queryKey, data);
      done();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const stop = useMutation({
    mutationFn: () => unwrapVoid(api.time.stop.$post()),
    onSuccess: () => {
      qc.setQueryData(currentTimerQuery.queryKey, null);
      done();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return { start, stop, pending: start.isPending || stop.isPending };
}
