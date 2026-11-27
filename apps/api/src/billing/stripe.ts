import { DomainError } from "@recpm/core";
import Stripe from "stripe";
import {
  type BillingProvider,
  type Interval,
  type ParsedWebhook,
  type Plan,
  WebhookSignatureError,
} from "./provider";

type Opts = {
  secretKey: string;
  webhookSecret: string;
  /** Resolve o plano pelo price id quando a assinatura não traz metadata.planId. */
  planIdByPrice: (priceId: string) => Promise<string | null>;
};

const toDate = (s: number) => new Date(s * 1000);
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

export function stripeProvider(opts: Opts): BillingProvider {
  const stripe = new Stripe(opts.secretKey);

  const priceId = (plan: Plan, interval: Interval) => {
    const id = plan.stripePriceIds[interval];
    if (!id)
      throw new DomainError(
        503,
        "BILLING_NOT_CONFIGURED",
        `Plano ${plan.slug} sem preço no Stripe (${interval}).`,
      );
    return id;
  };

  async function syncedFrom(sub: Stripe.Subscription, eventId: string): Promise<ParsedWebhook["event"]> {
    const tenantId = sub.metadata.tenantId;
    const item = sub.items.data[0];
    if (!tenantId || !item) return null;
    const planId = sub.metadata.planId || (await opts.planIdByPrice(item.price.id));
    if (!planId) return null;
    const STATUS: Record<string, "active" | "trialing" | "past_due"> = {
      active: "active",
      trialing: "trialing",
      past_due: "past_due",
      unpaid: "past_due",
      incomplete: "past_due",
    };
    const status = STATUS[sub.status] ?? null;
    if (!status) return null; // canceled/incomplete_expired/paused: tratados por customer.subscription.deleted
    return {
      kind: "subscription.synced",
      provider: "stripe",
      eventId,
      tenantId,
      planId,
      interval: item.price.recurring?.interval === "year" ? "yearly" : "monthly",
      providerCustomerId: idOf(sub.customer)!,
      providerSubscriptionId: sub.id,
      status,
      periodStart: toDate(item.current_period_start),
      periodEnd: toDate(item.current_period_end),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
  }

  const invoiceSub = (inv: Stripe.Invoice) => idOf(inv.parent?.subscription_details?.subscription ?? null);

  return {
    name: "stripe",

    async createCheckout(i) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId(i.plan, i.interval), quantity: 1 }],
        ...(i.customerId ? { customer: i.customerId } : { customer_email: i.email }),
        client_reference_id: i.tenantId,
        metadata: { tenantId: i.tenantId, planId: i.plan.id },
        subscription_data: { metadata: { tenantId: i.tenantId, planId: i.plan.id } },
        allow_promotion_codes: true,
        locale: "pt-BR",
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      });
      if (!session.url) throw new Error("Stripe não devolveu a URL do checkout");
      return { url: session.url };
    },

    async createPortal(i) {
      const s = await stripe.billingPortal.sessions.create({
        customer: i.customerId,
        return_url: i.returnUrl,
      });
      return { url: s.url };
    },

    async changePlan(i) {
      const sub = await stripe.subscriptions.retrieve(i.subscriptionId);
      const item = sub.items.data[0];
      if (!item) throw new Error("Assinatura Stripe sem item");
      await stripe.subscriptions.update(i.subscriptionId, {
        items: [{ id: item.id, price: priceId(i.plan, i.interval) }],
        // upgrade cobra a diferença agora; downgrade passa a cobrar o preço menor na próxima fatura
        proration_behavior: i.mode === "upgrade" ? "always_invoice" : "none",
        metadata: { tenantId: i.tenantId, planId: i.plan.id },
        cancel_at_period_end: false,
      });
    },

    async setCancelAtPeriodEnd(i) {
      await stripe.subscriptions.update(i.subscriptionId, { cancel_at_period_end: i.cancel });
    },

    async parseWebhook(rawBody, headers) {
      let ev: Stripe.Event;
      try {
        ev = await stripe.webhooks.constructEventAsync(
          rawBody,
          headers.get("stripe-signature") ?? "",
          opts.webhookSecret,
        );
      } catch {
        throw new WebhookSignatureError("assinatura Stripe inválida");
      }
      switch (ev.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
          return { event: await syncedFrom(ev.data.object, ev.id), payload: ev };
        case "customer.subscription.deleted":
          return {
            event: {
              kind: "subscription.canceled",
              provider: "stripe",
              eventId: ev.id,
              providerSubscriptionId: ev.data.object.id,
            },
            payload: ev,
          };
        case "invoice.paid":
        case "invoice.payment_failed": {
          const subId = invoiceSub(ev.data.object);
          if (!subId) return { event: null, payload: ev };
          return {
            event: {
              kind: ev.type === "invoice.paid" ? "payment.succeeded" : "payment.failed",
              provider: "stripe",
              eventId: ev.id,
              providerSubscriptionId: subId,
            },
            payload: ev,
          };
        }
        default:
          return { event: null, payload: ev };
      }
    },
  };
}
