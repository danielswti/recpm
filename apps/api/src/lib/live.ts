/**
 * Eventos em tempo real vindos do Postgres (LISTEN/NOTIFY). Uma conexão por processo da API,
 * aberta só quando alguém assina. Os gatilhos mandam só identificadores (nunca dados):
 *   recpm_time    "tenant"            (time_entries)
 *   recpm_notify  "tenant:usuário"    (notificações novas)
 *   recpm_chat    "tenant:conversa"   (mensagens e participantes)
 *   recpm_typing  "tenant:conversa:usuário:nome" (publicado pela própria API)
 *   recpm_webhooks "tenant"           (entregas de webhook na fila)
 *   recpm_exports  "tenant"           (exportação de dados pedida)
 * Quem assina reconsulta com RLS, então nada vaza entre tenants.
 */
import { Client } from "pg";
import type { Logger } from "./logger";

export const CHANNELS = [
  "recpm_time",
  "recpm_notify",
  "recpm_chat",
  "recpm_typing",
  "recpm_webhooks",
  "recpm_exports",
] as const;
export type Channel = (typeof CHANNELS)[number];
type Fn = (payload: string) => void;

export type LiveHub = {
  /** Assina um canal; `key` filtra pelo prefixo do payload (ex.: o tenant). "*" = tudo. */
  subscribe: (channel: Channel, key: string, fn: Fn) => () => void;
  publish: (channel: Channel, payload: string) => Promise<void>;
  close: () => Promise<void>;
};

export function createLiveHub(url: string, logger?: Logger): LiveHub {
  const subs = new Map<string, Set<Fn>>(); // "canal|chave" → assinantes
  let client: Client | null = null;
  let connecting: Promise<void> | null = null;
  let closed = false;

  const dispatch = (channel: string, payload: string) => {
    // entrega para "canal|tenant" e "canal|tenant:resto" (o que alguém tiver assinado)
    for (const fn of subs.get(`${channel}|*`) ?? []) fn(payload);
    const parts = payload.split(":");
    for (let i = 1; i <= parts.length; i++) {
      const key = `${channel}|${parts.slice(0, i).join(":")}`;
      for (const fn of subs.get(key) ?? []) fn(payload);
    }
  };

  const connect = (): Promise<void> => {
    if (client) return Promise.resolve();
    if (connecting) return connecting;
    if (closed) return Promise.resolve();
    connecting = (async () => {
      const c = new Client({ connectionString: url });
      c.on("notification", (m) => {
        if (m.payload) dispatch(m.channel, m.payload);
      });
      c.on("error", (err) => {
        logger?.warn({ err }, "live: conexão LISTEN caiu; reconectando");
        client = null;
        c.end().catch(() => {});
        if (subs.size) setTimeout(() => void connect(), 2000);
      });
      try {
        await c.connect();
        for (const ch of CHANNELS) await c.query(`LISTEN ${ch}`);
        client = c;
      } catch (err) {
        logger?.warn({ err }, "live: falha ao conectar");
        if (subs.size) setTimeout(() => void connect(), 5000);
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  return {
    subscribe(channel, key, fn) {
      const k = `${channel}|${key}`;
      const set = subs.get(k) ?? new Set<Fn>();
      subs.set(k, set);
      set.add(fn);
      void connect();
      return () => {
        set.delete(fn);
        if (!set.size) subs.delete(k);
      };
    },
    async publish(channel, payload) {
      await connect();
      await client?.query("SELECT pg_notify($1, $2)", [channel, payload]);
    },
    async close() {
      closed = true;
      subs.clear();
      await client?.end().catch(() => {});
      client = null;
    },
  };
}
