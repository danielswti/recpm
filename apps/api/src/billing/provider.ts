/**
 * Abstração de cobrança (§4 Billing). Stripe primeiro, Asaas depois; o resto da API só conhece
 * esta interface. Os eventos dos webhooks saem já normalizados (`BillingEvent` do @recpm/core).
 */
import type { BillingEvent } from "@recpm/core";
import type { schema } from "@recpm/db";

export type Plan = typeof schema.plans.$inferSelect;
export type Interval = "monthly" | "yearly";

export type CheckoutInput = {
  tenantId: string;
  tenantName: string;
  email: string;
  plan: Plan;
  interval: Interval;
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
};

export type ParsedWebhook = { event: BillingEvent | null; payload: unknown };

export interface BillingProvider {
  readonly name: "stripe" | "asaas";
  /** URL para o usuário pagar (Stripe Checkout / fatura do Asaas). */
  createCheckout(input: CheckoutInput): Promise<{ url: string }>;
  /** Portal de pagamento (cartão, faturas). null quando o provedor não tem portal. */
  createPortal(input: {
    customerId: string;
    subscriptionId: string | null;
    returnUrl: string;
  }): Promise<{ url: string } | null>;
  /** Upgrade: cobra a diferença proporcional agora. Downgrade: preço novo só no próximo ciclo. */
  changePlan(input: {
    subscriptionId: string;
    tenantId: string;
    plan: Plan;
    currentPlan: Plan;
    interval: Interval;
    mode: "upgrade" | "downgrade";
    periodStart: Date;
    periodEnd: Date;
  }): Promise<void>;
  setCancelAtPeriodEnd(input: { subscriptionId: string; cancel: boolean; periodEnd: Date }): Promise<void>;
  /** Valida a assinatura do webhook (lança WebhookSignatureError) e normaliza o evento. */
  parseWebhook(rawBody: string, headers: Headers): Promise<ParsedWebhook>;
}

export class WebhookSignatureError extends Error {}

export const priceFor = (plan: Plan, interval: Interval) =>
  interval === "yearly" ? plan.priceYearlyCents : plan.priceMonthlyCents;
