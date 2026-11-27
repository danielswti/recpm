import type { Deps } from "../deps";
import { asaasProvider } from "./asaas";
import type { BillingProvider } from "./provider";
import { stripeProvider } from "./stripe";

export type BillingProviders = Partial<Record<"stripe" | "asaas", BillingProvider>> & {
  /** Provedor usado em novos checkouts (BILLING_PROVIDER). */
  default: BillingProvider | null;
};

/** Monta os provedores configurados no ambiente. Sem chaves, a cobrança fica desligada (503). */
export function createBillingProviders(
  env: Deps["env"],
  planIdByPrice: (priceId: string) => Promise<string | null>,
): BillingProviders {
  const p: BillingProviders = { default: null };
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)
    p.stripe = stripeProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      planIdByPrice,
    });
  if (env.ASAAS_API_KEY && env.ASAAS_WEBHOOK_TOKEN)
    p.asaas = asaasProvider({
      apiKey: env.ASAAS_API_KEY,
      baseUrl: env.ASAAS_BASE_URL,
      webhookToken: env.ASAAS_WEBHOOK_TOKEN,
    });
  p.default = p[env.BILLING_PROVIDER] ?? null;
  return p;
}
