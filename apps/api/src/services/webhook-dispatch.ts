/**
 * Entrega dos webhooks de saída (§6.13). As linhas de webhook_deliveries nascem nos gatilhos do
 * banco (app.enqueue_webhook); aqui cada lote é reivindicado com FOR UPDATE SKIP LOCKED e uma
 * "concessão" de 2 min em next_attempt_at, então várias instâncias da API não entregam duas vezes
 * e uma entrega interrompida volta sozinha para a fila.
 *
 * Assinatura: X-RecPM-Signature: t=<unix>,v1=<hex(HMAC-SHA256(segredo, "<t>.<corpo>"))>.
 * Novas tentativas: 1 min, 5 min, 30 min, 2 h, 6 h e 24 h; depois disso a entrega fica como falha.
 */
import { createHmac } from "node:crypto";
import { schema } from "@recpm/db";
import { eq, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { decryptSecret, secretsKey } from "../lib/secrets";

const s = schema;
export const WEBHOOK_RETRY_MINUTES = [1, 5, 30, 120, 360, 1440];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_MINUTES.length + 1;
const TIMEOUT_MS = 10_000;

export const signWebhook = (secret: string, timestamp: number, body: string) =>
  `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

type Claimed = {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event: string;
  payload: unknown;
  attempts: number;
  created_at: Date | string;
};

export function createWebhookDispatcher(deps: Deps) {
  const db = deps.dbs.platformDb;
  const doFetch = deps.fetch ?? fetch;

  async function deliver(row: Claimed) {
    const [ep] = await db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, row.endpoint_id));
    const attempt = row.attempts;
    const finish = async (ok: boolean, status: number | null, error: string | null) => {
      const retryIn = WEBHOOK_RETRY_MINUTES[attempt - 1];
      await db
        .update(s.webhookDeliveries)
        .set(
          ok
            ? {
                status: "succeeded",
                responseStatus: status,
                lastError: null,
                deliveredAt: new Date(),
                nextAttemptAt: null,
              }
            : {
                status: "failed",
                responseStatus: status,
                lastError: error?.slice(0, 500) ?? null,
                nextAttemptAt:
                  ep?.active && retryIn !== undefined ? new Date(Date.now() + retryIn * 60_000) : null,
              },
        )
        .where(eq(s.webhookDeliveries.id, row.id));
      return ok;
    };
    if (!ep || !ep.active) return finish(false, null, "Webhook desativado ou removido.");

    const body = JSON.stringify({
      id: row.id,
      event: row.event,
      createdAt: new Date(row.created_at).toISOString(),
      tenantId: row.tenant_id,
      data: row.payload,
    });
    const ts = Math.floor(Date.now() / 1000);
    let secret: string;
    try {
      secret = decryptSecret(ep.secretEnc, secretsKey(deps.env));
    } catch {
      return finish(false, null, "Não foi possível ler o segredo do webhook.");
    }
    try {
      const res = await doFetch(ep.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "RecPM-Webhooks/1.0",
          "x-recpm-event": row.event,
          "x-recpm-delivery": row.id,
          "x-recpm-signature": signWebhook(secret, ts, body),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      return finish(res.ok, res.status, res.ok ? null : `HTTP ${res.status}`);
    } catch (err) {
      return finish(false, null, err instanceof Error ? err.message : String(err));
    }
  }

  async function runOnce(limit = 50): Promise<{ claimed: number; ok: number }> {
    const claimed = await db.execute<Claimed>(sql`
      UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
       WHERE id IN (
         SELECT id FROM webhook_deliveries
          WHERE status IN ('pending', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
            AND attempts < ${WEBHOOK_MAX_ATTEMPTS}
          ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, endpoint_id, event, payload, attempts, created_at`);
    let ok = 0;
    for (const row of claimed.rows) {
      try {
        if (await deliver(row)) ok++;
      } catch (err) {
        deps.logger.warn({ err, delivery: row.id }, "falha ao entregar webhook");
      }
    }
    return { claimed: claimed.rows.length, ok };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let again = false;
  const kick = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          while ((await runOnce()).claimed === 50);
        } while (again);
      } catch (err) {
        deps.logger.error({ err }, "despachante de webhooks falhou");
      } finally {
        running = false;
      }
    })();
  };

  return {
    runOnce,
    kick,
    start() {
      const off = deps.live?.subscribe("recpm_webhooks", "*", kick);
      timer = setInterval(kick, 30_000);
      kick();
      return () => {
        off?.();
        if (timer) clearInterval(timer);
      };
    },
  };
}
