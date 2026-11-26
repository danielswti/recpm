/**
 * Valkey (protocolo Redis). Usado como secondaryStorage do Better Auth (cache de sessão e
 * rate limit) e, nas próximas fases, para pub/sub do WebSocket e filas do BullMQ.
 */
import type { SecondaryStorage } from "better-auth";
import { Redis } from "ioredis";

export const createRedis = (url: string) => new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });

export const redisSecondaryStorage = (redis: Redis): SecondaryStorage => ({
  get: (key) => redis.get(key),
  getAndDelete: (key) => redis.getdel(key),
  set: async (key, value, ttl) => {
    if (ttl) await redis.set(key, value, "EX", ttl);
    else await redis.set(key, value);
  },
  delete: async (key) => {
    await redis.del(key);
  },
  increment: async (key, ttl) => {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttl);
    return n;
  },
});
