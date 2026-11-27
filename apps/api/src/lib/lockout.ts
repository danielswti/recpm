/**
 * Bloqueio contra força bruta por conta (complementa o limite por IP do Better Auth):
 * 10 senhas erradas para o mesmo e-mail em 15 min bloqueiam novos logins dele por 15 min,
 * venham de onde vierem. Login certo zera o contador. Usa o Valkey; sem ele, memória do processo.
 */
import type { Redis } from "ioredis";

export const LOCKOUT_MAX_FAILURES = 10;
export const LOCKOUT_WINDOW_S = 15 * 60;

export type Lockout = {
  /** Segundos restantes de bloqueio, ou 0. */
  lockedFor(email: string): Promise<number>;
  fail(email: string): Promise<void>;
  reset(email: string): Promise<void>;
};

const keyOf = (email: string) => `lockout:${email.trim().toLowerCase()}`;

export function createLockout(redis?: Redis): Lockout {
  if (redis) {
    return {
      async lockedFor(email) {
        const k = keyOf(email);
        const n = Number(await redis.get(k));
        if (n < LOCKOUT_MAX_FAILURES) return 0;
        return Math.max(1, await redis.ttl(k));
      },
      async fail(email) {
        const k = keyOf(email);
        const n = await redis.incr(k);
        // a janela conta da primeira falha; ao atingir o limite, o bloqueio dura a janela inteira
        if (n === 1 || n === LOCKOUT_MAX_FAILURES) await redis.expire(k, LOCKOUT_WINDOW_S);
      },
      async reset(email) {
        await redis.del(keyOf(email));
      },
    };
  }
  const mem = new Map<string, { n: number; until: number }>();
  const live = (email: string) => {
    const e = mem.get(keyOf(email));
    if (e && e.until < Date.now()) mem.delete(keyOf(email));
    return mem.get(keyOf(email));
  };
  return {
    async lockedFor(email) {
      const e = live(email);
      return e && e.n >= LOCKOUT_MAX_FAILURES ? Math.ceil((e.until - Date.now()) / 1000) : 0;
    },
    async fail(email) {
      const e = live(email) ?? { n: 0, until: Date.now() + LOCKOUT_WINDOW_S * 1000 };
      e.n++;
      if (e.n === LOCKOUT_MAX_FAILURES) e.until = Date.now() + LOCKOUT_WINDOW_S * 1000;
      mem.set(keyOf(email), e);
    },
    async reset(email) {
      mem.delete(keyOf(email));
    },
  };
}
