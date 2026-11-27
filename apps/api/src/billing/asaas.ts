/**
 * Asaas (API v3). Diferenças em relação ao Stripe, tratadas aqui:
 *  - Não há checkout hospedado de assinatura: criamos cliente + assinatura (billingType UNDEFINED, o
 *    pagador escolhe Pix/boleto/cartão) e mandamos o usuário para a fatura da 1ª cobrança.
 *  - Não há proporcional automático: no upgrade criamos uma cobrança avulsa com a diferença
 *    proporcional aos dias restantes do ciclo.
 *  - Não há portal: o "portal" é a fatura em aberto mais recente.
 *  - Cancelamento ao fim do ciclo: endDate na assinatura; o job de ciclo aplica o plano gratuito.
 *  - Webhook autenticado pelo header `asaas-access-token` (token configurado no painel do Asaas).
 * O plano e o tenant vão em externalReference = "<tenantId>:<planId>".
 */
import { timingSafeEqual } from "node:crypto";
import { addMonths, type BillingEvent } from "@recpm/core";
import {
  type BillingProvider,
  type Interval,
  type ParsedWebhook,
  priceFor,
  WebhookSignatureError,
} from "./provider";

type Opts = { apiKey: string; baseUrl: string; webhookToken: string; fetch?: typeof fetch };

type AsaasPayment = {
  id: string;
  customer: string;
  subscription?: string | null;
  dueDate: string;
  status: string;
  invoiceUrl?: string;
  externalReference?: string | null;
};
type AsaasSubscription = {
  id: string;
  customer: string;
  cycle: "MONTHLY" | "YEARLY" | string;
  externalReference?: string | null;
  status?: string;
};

const CYCLE: Record<Interval, string> = { monthly: "MONTHLY", yearly: "YEARLY" };
const day = (d: Date) => d.toISOString().slice(0, 10);
const reais = (cents: number) => Math.round(cents) / 100;

export const parseRef = (ref: string | null | undefined) => {
  const [tenantId, planId] = (ref ?? "").split(":");
  return tenantId && planId ? { tenantId, planId } : null;
};

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function asaasProvider(opts: Opts): BillingProvider {
  const http = opts.fetch ?? fetch;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await http(`${opts.baseUrl}${path}`, {
      method,
      headers: { access_token: opts.apiKey, "content-type": "application/json", "user-agent": "recpm" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { errors?: { description: string }[] };
    if (!res.ok)
      throw new Error(`Asaas ${method} ${path}: ${res.status} ${json.errors?.[0]?.description ?? ""}`);
    return json;
  };
  const firstOpenPayment = async (subscriptionId: string) => {
    const { data } = await call<{ data: AsaasPayment[] }>("GET", `/subscriptions/${subscriptionId}/payments`);
    return data.find((p) => p.status === "PENDING" || p.status === "OVERDUE") ?? data[0] ?? null;
  };

  return {
    name: "asaas",

    async createCheckout(i) {
      const value = priceFor(i.plan, i.interval);
      if (value === null) throw new Error(`Plano ${i.plan.slug} sem preço ${i.interval}`);
      const customer =
        i.customerId ??
        (
          await call<{ id: string }>("POST", "/customers", {
            name: i.tenantName,
            email: i.email,
            externalReference: i.tenantId,
          })
        ).id;
      const sub = await call<{ id: string }>("POST", "/subscriptions", {
        customer,
        billingType: "UNDEFINED",
        value: reais(Number(value)),
        nextDueDate: day(new Date()),
        cycle: CYCLE[i.interval],
        description: `Rec PM ${i.plan.name}`,
        externalReference: `${i.tenantId}:${i.plan.id}`,
      });
      const payment = await firstOpenPayment(sub.id);
      if (!payment?.invoiceUrl) throw new Error("Asaas não gerou a fatura da assinatura");
      return { url: payment.invoiceUrl };
    },

    async createPortal(i) {
      if (!i.subscriptionId) return null;
      const p = await firstOpenPayment(i.subscriptionId);
      return p?.invoiceUrl ? { url: p.invoiceUrl } : null;
    },

    async changePlan(i) {
      const value = priceFor(i.plan, i.interval);
      if (value === null) throw new Error(`Plano ${i.plan.slug} sem preço ${i.interval}`);
      const sub = await call<AsaasSubscription>("GET", `/subscriptions/${i.subscriptionId}`);
      await call("POST", `/subscriptions/${i.subscriptionId}`, {
        value: reais(Number(value)),
        description: `Rec PM ${i.plan.name}`,
        externalReference: `${i.tenantId}:${i.plan.id}`,
        // downgrade não mexe na cobrança já emitida deste ciclo
        updatePendingPayments: false,
        endDate: null,
      });
      if (i.mode === "upgrade") {
        const total = i.periodEnd.getTime() - i.periodStart.getTime();
        const left = Math.max(0, i.periodEnd.getTime() - Date.now());
        const old = priceFor(i.currentPlan, i.interval) ?? 0;
        const diffCents = Math.round(((Number(value) - Number(old)) * left) / total);
        if (diffCents >= 500)
          await call("POST", "/payments", {
            customer: sub.customer,
            billingType: "UNDEFINED",
            value: reais(diffCents),
            dueDate: day(new Date()),
            description: `Rec PM: diferença proporcional para ${i.plan.name}`,
            externalReference: `proration:${i.tenantId}`,
          });
      }
    },

    async setCancelAtPeriodEnd(i) {
      await call("POST", `/subscriptions/${i.subscriptionId}`, {
        endDate: i.cancel ? day(i.periodEnd) : null,
      });
    },

    async parseWebhook(rawBody, headers): Promise<ParsedWebhook> {
      if (!opts.webhookToken || !safeEqual(headers.get("asaas-access-token") ?? "", opts.webhookToken))
        throw new WebhookSignatureError("token do webhook Asaas inválido");
      const body = JSON.parse(rawBody) as {
        id?: string;
        event: string;
        payment?: AsaasPayment;
        subscription?: AsaasSubscription;
      };
      const eventId = body.id ?? `${body.event}:${body.payment?.id ?? body.subscription?.id}`;
      const p = body.payment;

      if ((body.event === "PAYMENT_CONFIRMED" || body.event === "PAYMENT_RECEIVED") && p?.subscription) {
        const sub = await call<AsaasSubscription>("GET", `/subscriptions/${p.subscription}`);
        const ref = parseRef(sub.externalReference);
        if (!ref) return { event: null, payload: body };
        const interval: Interval = sub.cycle === "YEARLY" ? "yearly" : "monthly";
        const start = new Date(`${p.dueDate}T00:00:00Z`);
        const event: BillingEvent = {
          kind: "subscription.synced",
          provider: "asaas",
          eventId,
          tenantId: ref.tenantId,
          planId: ref.planId,
          interval,
          providerCustomerId: sub.customer,
          providerSubscriptionId: sub.id,
          status: "active",
          periodStart: start,
          periodEnd: addMonths(start, interval === "yearly" ? 12 : 1),
          cancelAtPeriodEnd: false,
        };
        return { event, payload: body };
      }
      if (body.event === "PAYMENT_OVERDUE" && p?.subscription)
        return {
          event: {
            kind: "payment.failed",
            provider: "asaas",
            eventId,
            providerSubscriptionId: p.subscription,
          },
          payload: body,
        };
      if (
        (body.event === "SUBSCRIPTION_DELETED" || body.event === "SUBSCRIPTION_INACTIVATED") &&
        body.subscription
      )
        return {
          event: {
            kind: "subscription.canceled",
            provider: "asaas",
            eventId,
            providerSubscriptionId: body.subscription.id,
          },
          payload: body,
        };
      return { event: null, payload: body };
    },
  };
}
