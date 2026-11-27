/**
 * API pública (§6.13): `Authorization: Bearer pk_live_<prefixo>_<segredo>`.
 *
 * - A chave é procurada pelo prefixo (função SECURITY DEFINER, antes de saber o tenant) e o
 *   segredo é comparado pelo hash SHA-256 em tempo constante.
 * - Vale como uma sessão de quem criou a chave, no tenant dela: as permissões são as dessa pessoa
 *   (admin ou gestor) e continuam passando pelo RBAC e pelo RLS de cada rota.
 * - Sem cookie, então não há CSRF: o middleware de origem deixa passar pedidos com Bearer.
 * - Limite por chave (janela de 1 minuto, no Valkey quando houver; senão em memória).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { assertFeature, loadEntitlements } from "@recpm/core";
import { schema, withTenant } from "@recpm/db";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Deps } from "../deps";
import { AppError } from "../lib/errors";
import type { AppEnv, SessionData } from "../types";

const KEY_RE = /^pk_live_([0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/;
export const API_RATE_LIMIT_PER_MINUTE = 120;

export const bearerKey = (header: string | undefined) => {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m?.[1] ?? null;
};

type Resolved = {
  tenant_id: string;
  api_key_id: string;
  hashed_key: string;
  created_by: string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
};

export function apiKeyAuth(deps: Deps) {
  const memory = new Map<string, { n: number; reset: number }>();

  /** Conta o pedido na janela do minuto atual; devolve quantos já foram e quando a janela vira. */
  async function hit(keyId: string): Promise<{ n: number; reset: number }> {
    const window = Math.floor(Date.now() / 60_000);
    const reset = (window + 1) * 60;
    if (deps.redis) {
      const k = `rl:api:${keyId}:${window}`;
      try {
        const n = await deps.redis.incr(k);
        if (n === 1) await deps.redis.expire(k, 61);
        return { n, reset };
      } catch {
        // Valkey fora do ar: cai para a contagem em memória
      }
    }
    const cur = memory.get(keyId);
    if (!cur || cur.reset !== reset) {
      memory.set(keyId, { n: 1, reset });
      return { n: 1, reset };
    }
    cur.n += 1;
    return cur;
  }

  return createMiddleware<AppEnv>(async (c, next) => {
    const raw = bearerKey(c.req.header("authorization"));
    if (!raw) {
      await next();
      return;
    }
    const m = KEY_RE.exec(raw);
    if (!m) throw new AppError(401, "INVALID_API_KEY", "Chave de API inválida.");
    const [, prefix, secret] = m;

    const res = await deps.dbs.appDb.execute<Resolved>(sql`SELECT * FROM app.resolve_api_key(${prefix})`);
    const k = res.rows[0];
    const hash = createHash("sha256").update(secret!).digest();
    const ok =
      !!k &&
      k.hashed_key.length === 64 &&
      timingSafeEqual(hash, Buffer.from(k.hashed_key, "hex")) &&
      !k.revoked_at &&
      (!k.expires_at || new Date(k.expires_at) > new Date());
    if (!k || !ok) throw new AppError(401, "INVALID_API_KEY", "Chave de API inválida, revogada ou vencida.");

    const rl = await hit(k.api_key_id);
    c.header("X-RateLimit-Limit", String(API_RATE_LIMIT_PER_MINUTE));
    c.header("X-RateLimit-Remaining", String(Math.max(0, API_RATE_LIMIT_PER_MINUTE - rl.n)));
    c.header("X-RateLimit-Reset", String(rl.reset));
    if (rl.n > API_RATE_LIMIT_PER_MINUTE) {
      c.header("Retry-After", String(Math.max(1, rl.reset - Math.floor(Date.now() / 1000))));
      throw new AppError(429, "RATE_LIMITED", "Limite de pedidos da chave atingido. Tente em instantes.");
    }

    const ctx = { tenantId: k.tenant_id, userId: k.created_by };
    const found = await withTenant(deps.dbs.appDb, ctx, async (tx) => {
      const ent = await loadEntitlements(tx);
      const [u] = await tx
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, k.created_by));
      // último uso: no máximo uma escrita por minuto por chave
      await tx
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(
          and(
            eq(schema.apiKeys.id, k.api_key_id),
            or(
              isNull(schema.apiKeys.lastUsedAt),
              lt(schema.apiKeys.lastUsedAt, new Date(Date.now() - 60_000)),
            ),
          ),
        );
      return { ent, u };
    });
    assertFeature(found.ent, "publicApi");
    if (!found.u) throw new AppError(401, "INVALID_API_KEY", "Chave de API sem dono.");

    // A chave vale como uma sessão do criador, no tenant da chave.
    const now = new Date();
    c.set("session", {
      user: {
        id: found.u.id,
        name: found.u.name,
        email: found.u.email,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: `api_key:${k.api_key_id}`,
        userId: found.u.id,
        token: "",
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
        activeOrganizationId: k.tenant_id,
      },
    } as unknown as SessionData);
    c.set("apiKeyId", k.api_key_id);
    await next();
  });
}
