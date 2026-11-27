/**
 * Webhooks de cobrança: sem sessão e sem CSRF (fora de /api/v1); autenticados pela assinatura do
 * provedor. Idempotentes: (provider, eventId) único em billing_events.
 * Respostas: 200 processado/ignorado/duplicado, 400 assinatura inválida, 404 provedor desligado.
 */
import { applyBillingEvent } from "@recpm/core";
import { Hono } from "hono";
import type { BillingProviders } from "../billing";
import { WebhookSignatureError } from "../billing/provider";
import type { Deps } from "../deps";
import { errorBody } from "../lib/errors";

export const webhookRoutes = (deps: Deps, providers: BillingProviders) =>
  new Hono().post("/:provider{stripe|asaas}", async (c) => {
    const name = c.req.param("provider") as "stripe" | "asaas";
    const provider = providers[name];
    if (!provider) return c.json(errorBody("BILLING_NOT_CONFIGURED", "Provedor não configurado."), 404);

    const raw = await c.req.text();
    let parsed: Awaited<ReturnType<typeof provider.parseWebhook>>;
    try {
      parsed = await provider.parseWebhook(raw, c.req.raw.headers);
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        deps.logger.warn({ provider: name }, "webhook com assinatura inválida");
        return c.json(errorBody("INVALID_SIGNATURE", "Assinatura inválida."), 400);
      }
      throw e;
    }
    if (!parsed.event) return c.json({ received: true, ignored: true }, 200);

    const result = await applyBillingEvent(deps.dbs.platformDb, parsed.event, parsed.payload);
    deps.logger.info({ provider: name, kind: parsed.event.kind, ...result }, "webhook de cobrança");
    return c.json({ received: true, duplicate: result.duplicate }, 200);
  });
