/**
 * Eventos em tempo real vindos do Postgres (LISTEN/NOTIFY). Uma conexão por processo da API,
 * aberta só quando alguém assina; o gatilho em time_entries manda o tenant_id no canal
 * `recpm_time`. Quem assina recebe só os avisos do próprio tenant e reconsulta com RLS.
 */
import { Client } from "pg";
import type { Logger } from "./logger";

type Fn = () => void;

export type LiveHub = {
  subscribe: (tenantId: string, fn: Fn) => () => void;
  close: () => Promise<void>;
};

export function createLiveHub(url: string, logger?: Logger): LiveHub {
  const subs = new Map<string, Set<Fn>>();
  let client: Client | null = null;
  let connecting: Promise<void> | null = null;
  let closed = false;

  const connect = () => {
    if (client || connecting || closed) return;
    connecting = (async () => {
      const c = new Client({ connectionString: url });
      c.on("notification", (m) => {
        if (m.channel !== "recpm_time" || !m.payload) return;
        for (const fn of subs.get(m.payload) ?? []) fn();
      });
      c.on("error", (err) => {
        logger?.warn({ err }, "live: conexão LISTEN caiu; reconectando");
        client = null;
        c.end().catch(() => {});
        if (subs.size) setTimeout(connect, 2000);
      });
      try {
        await c.connect();
        await c.query("LISTEN recpm_time");
        client = c;
      } catch (err) {
        logger?.warn({ err }, "live: falha ao conectar");
        if (subs.size) setTimeout(connect, 5000);
      } finally {
        connecting = null;
      }
    })();
  };

  return {
    subscribe(tenantId, fn) {
      const set = subs.get(tenantId) ?? new Set<Fn>();
      subs.set(tenantId, set);
      set.add(fn);
      connect();
      return () => {
        set.delete(fn);
        if (!set.size) subs.delete(tenantId);
      };
    },
    async close() {
      closed = true;
      subs.clear();
      await client?.end().catch(() => {});
      client = null;
    },
  };
}
