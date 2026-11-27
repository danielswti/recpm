import { addMonths, consumeTaskQuota } from "@recpm/core";
import { schema, withTenant } from "@recpm/db";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { beforeAll, describe, expect, test } from "vitest";
import type { BillingProvider } from "../src/billing/provider";
import { sendUsageWarnings } from "../src/services/usage-warnings";
import { Browser, createWorkspace, setupApp, signUp, uniq } from "./helpers";

/** Provedor falso: registra as chamadas, devolve URLs previsíveis. */
const calls: { fn: string; args: Record<string, unknown> }[] = [];
const fake: BillingProvider = {
  name: "stripe",
  createCheckout: async (i) => {
    calls.push({ fn: "createCheckout", args: { plan: i.plan.slug, tenantId: i.tenantId } });
    return { url: `https://pay.example/checkout/${i.plan.slug}` };
  },
  createPortal: async () => ({ url: "https://pay.example/portal" }),
  changePlan: async (i) => void calls.push({ fn: "changePlan", args: { plan: i.plan.slug, mode: i.mode } }),
  setCancelAtPeriodEnd: async (i) =>
    void calls.push({ fn: "setCancelAtPeriodEnd", args: { cancel: i.cancel } }),
  parseWebhook: async () => ({ event: null, payload: {} }),
};

const WHSEC = "whsec_test_secret";
const ctx = setupApp({
  billing: { stripe: fake, default: fake },
});
// Instância com o adaptador Stripe real (assinatura de webhook verificada de verdade, sem rede).
const real = setupApp({ env: { STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_WEBHOOK_SECRET: WHSEC } });
const { app, dbs, mailer } = ctx;
const platform = dbs.platformDb;
const plans: Record<string, string> = {};

beforeAll(async () => {
  for (const p of await platform.select({ id: schema.plans.id, slug: schema.plans.slug }).from(schema.plans))
    plans[p.slug] = p.id;
});

async function adminWithWorkspace(name = "Lia") {
  const b = new Browser(app);
  const u = await signUp(b, name);
  const ws = await createWorkspace(b, `Agência ${name}`);
  return { b, ...u, tenantId: ws.id };
}
const setSub = (tenantId: string, patch: Partial<typeof schema.tenantSubscriptions.$inferInsert>) =>
  platform
    .update(schema.tenantSubscriptions)
    .set(patch)
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId));

describe("entitlements e página de cobrança", () => {
  test("workspace novo: trial de 14 dias no Profissional, cota de 1.500", async () => {
    const { b } = await adminWithWorkspace();
    const e = await b.get("/api/v1/entitlements");
    expect(e.status).toBe(200);
    expect(e.json.plan.slug).toBe("profissional");
    expect(e.json.status).toBe("trialing");
    expect(e.json.limits.tasksPerCycle).toBe(1500);
    expect(e.json.usage).toEqual({ tasksCreated: 0, tasksPercent: 0 });
    const days = (Date.parse(e.json.trialEndsAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);

    const billing = await b.get("/api/v1/billing");
    expect(billing.status).toBe(200);
    expect(billing.json.billingEnabled).toBe(true);
    expect(billing.json.plans.map((p: { slug: string }) => p.slug)).toEqual([
      "basico",
      "essencial",
      "profissional",
      "enterprise",
    ]);
    expect(billing.json.plans.map((p: { priceMonthlyCents: number }) => p.priceMonthlyCents)).toEqual([
      0, 9900, 24700, 31900,
    ]);
    expect(billing.json.plans[3].priceIsStartingAt).toBe(true);
  });

  test("só o admin vê e mexe na cobrança", async () => {
    const { b, tenantId } = await adminWithWorkspace("Rui");
    const g = new Browser(app);
    const { userId } = await signUp(g, "Gestora");
    await withTenant(dbs.appDb, { tenantId, actor: "system" }, (tx) =>
      tx.insert(schema.memberships).values({ tenantId, userId, role: "gestor" }),
    );
    await g.post("/api/auth/organization/set-active", { organizationId: tenantId });
    expect((await g.get("/api/v1/entitlements")).status).toBe(200);
    expect((await g.get("/api/v1/billing")).status).toBe(403);
    expect((await g.post("/api/v1/billing/change-plan", { planSlug: "essencial" })).status).toBe(403);
    expect((await b.get("/api/v1/billing")).status).toBe(200);
  });
});

describe("troca de plano", () => {
  test("no trial, plano pago abre checkout e nada muda até o pagamento", async () => {
    const { b, tenantId } = await adminWithWorkspace("Ivo");
    const r = await b.post("/api/v1/billing/change-plan", { planSlug: "essencial" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ mode: "checkout", url: "https://pay.example/checkout/essencial" });
    expect(calls.at(-1)).toEqual({ fn: "createCheckout", args: { plan: "essencial", tenantId } });
    expect((await b.get("/api/v1/entitlements")).json.plan.slug).toBe("profissional");
  });

  test("Enterprise é com o comercial; anual indisponível sem preço anual", async () => {
    const { b } = await adminWithWorkspace("Ana2");
    expect((await b.post("/api/v1/billing/change-plan", { planSlug: "enterprise" })).json.error.code).toBe(
      "PLAN_REQUIRES_CONTACT",
    );
    expect(
      (await b.post("/api/v1/billing/change-plan", { planSlug: "essencial", interval: "yearly" })).json.error
        .code,
    ).toBe("INTERVAL_UNAVAILABLE");
  });

  test("assinatura paga: upgrade vale na hora; downgrade fica agendado e pode ser desfeito", async () => {
    const { b, tenantId } = await adminWithWorkspace("Edu");
    await setSub(tenantId, {
      planId: plans.essencial!,
      status: "active",
      provider: "stripe",
      providerCustomerId: "cus_x",
      providerSubscriptionId: `sub_${uniq("x")}`,
      trialEndsAt: null,
    });
    const up = await b.post("/api/v1/billing/change-plan", { planSlug: "profissional" });
    expect(up.json).toEqual({ mode: "upgrade", url: null });
    expect(calls.at(-1)).toEqual({ fn: "changePlan", args: { plan: "profissional", mode: "upgrade" } });
    expect((await b.get("/api/v1/entitlements")).json.plan.slug).toBe("profissional");

    const down = await b.post("/api/v1/billing/change-plan", { planSlug: "essencial" });
    expect(down.json.mode).toBe("downgrade");
    let e = (await b.get("/api/v1/entitlements")).json;
    expect(e.plan.slug).toBe("profissional");
    expect(e.pendingPlan.slug).toBe("essencial");

    expect((await b.post("/api/v1/billing/undo-scheduled")).status).toBe(200);
    e = (await b.get("/api/v1/entitlements")).json;
    expect(e.pendingPlan).toBeNull();

    const cancel = await b.post("/api/v1/billing/change-plan", { planSlug: "basico" });
    expect(cancel.json.mode).toBe("cancel_at_period_end");
    expect(calls.at(-1)).toEqual({ fn: "setCancelAtPeriodEnd", args: { cancel: true } });
    expect((await b.get("/api/v1/entitlements")).json.cancelAtPeriodEnd).toBe(true);
    expect((await b.post("/api/v1/billing/portal")).json.url).toBe("https://pay.example/portal");
  });

  test("sem provedor configurado: checkout responde 503 BILLING_NOT_CONFIGURED", async () => {
    const off = setupApp({ billing: { default: null } });
    const b = new Browser(off.app);
    await signUp(b, "Off");
    await createWorkspace(b, "Sem cobrança");
    const r = await b.post("/api/v1/billing/change-plan", { planSlug: "essencial" });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("BILLING_NOT_CONFIGURED");
    expect((await b.get("/api/v1/billing")).json.billingEnabled).toBe(false);
  });
});

describe("webhook do Stripe (adaptador real)", () => {
  const stripe = new Stripe("sk_test_dummy");
  const send = async (event: object, signature?: string) => {
    const payload = JSON.stringify(event);
    const header = signature ?? stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    const res = await real.app.request("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": header, "content-type": "application/json" },
      body: payload,
    });
    return { status: res.status, json: await res.json() };
  };

  test("assinatura criada ativa o plano; reenvio é idempotente; assinatura inválida é recusada", async () => {
    const { b, tenantId } = await adminWithWorkspace("Web");
    const start = Math.floor(Date.now() / 1000);
    const end = Math.floor(addMonths(new Date(start * 1000), 1).getTime() / 1000);
    const event = {
      id: `evt_${uniq("s")}`,
      object: "event",
      type: "customer.subscription.created",
      data: {
        object: {
          id: `sub_${uniq("s")}`,
          object: "subscription",
          customer: "cus_web",
          status: "active",
          cancel_at_period_end: false,
          metadata: { tenantId, planId: plans.essencial },
          items: {
            data: [
              {
                id: "si_1",
                price: { id: "price_x", recurring: { interval: "month" } },
                current_period_start: start,
                current_period_end: end,
              },
            ],
          },
        },
      },
    };
    expect(await send(event)).toEqual({ status: 200, json: { received: true, duplicate: false } });
    expect(await send(event)).toEqual({ status: 200, json: { received: true, duplicate: true } });
    const e = (await b.get("/api/v1/entitlements")).json;
    expect(e).toMatchObject({
      status: "active",
      hasPaidSubscription: true,
      provider: "stripe",
      trialEndsAt: null,
    });
    expect(e.plan.slug).toBe("essencial");

    expect((await send({ ...event, id: "evt_forjado" }, "t=1,v1=deadbeef")).status).toBe(400);
    expect(
      (await send({ id: `evt_${uniq("i")}`, object: "event", type: "charge.refunded", data: { object: {} } }))
        .json,
    ).toEqual({
      received: true,
      ignored: true,
    });
  });

  test("provedor sem chave → 404", async () => {
    const r = await app.request("http://localhost:3000/api/webhooks/asaas", { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });
});

describe("guardas do plano", () => {
  test("somente leitura: lê tudo, não convida, mas pode regularizar a cobrança", async () => {
    const { b, tenantId } = await adminWithWorkspace("Roberta");
    await platform.update(schema.tenants).set({ status: "read_only" }).where(eq(schema.tenants.id, tenantId));
    expect((await b.get("/api/v1/members")).status).toBe(200);
    expect((await b.get("/api/v1/entitlements")).json.readOnly).toBe(true);
    const inv = await b.post("/api/auth/organization/invite-member", {
      email: `${uniq("x")}@example.test`,
      role: "funcionario",
    });
    expect(inv.status).toBe(403);
    expect(inv.json.code).toBe("TENANT_READ_ONLY");
    expect((await b.post("/api/v1/billing/change-plan", { planSlug: "essencial" })).status).toBe(200);
  });

  test("limite de usuários do Básico (3, contando convites pendentes)", async () => {
    const { b, tenantId } = await adminWithWorkspace("Bel");
    await setSub(tenantId, { planId: plans.basico!, status: "active", trialEndsAt: null });
    const invite = (n: number) =>
      b.post("/api/auth/organization/invite-member", {
        email: `${uniq(`p${n}`)}@example.test`,
        role: "funcionario",
      });
    expect((await invite(1)).status).toBe(200);
    expect((await invite(2)).status).toBe(200);
    const third = await invite(3);
    expect(third.status).toBe(402);
    expect(third.json.code).toBe("PLAN_USER_LIMIT_REACHED");
  });

  test("avisos de cota: e-mail para os admins em 80% e 100%", async () => {
    const { email, tenantId } = await adminWithWorkspace("Cota");
    await setSub(tenantId, { planId: plans.basico!, status: "active", trialEndsAt: null });
    const consume = (n: number) =>
      withTenant(dbs.appDb, { tenantId, actor: "system" }, (tx) => consumeTaskQuota(tx, n));
    const a = await consume(40);
    await sendUsageWarnings(ctx.deps, tenantId, a.warnings, a.used, 50);
    expect(mailer.outbox.findLast((m) => m.to === email)?.subject).toContain("80% das tarefas");
    const c = await consume(10);
    expect(c.warnings).toEqual([90, 100]);
    await sendUsageWarnings(ctx.deps, tenantId, c.warnings, c.used, 50);
    expect(mailer.outbox.findLast((m) => m.to === email)?.subject).toContain(
      "limite de tarefas do plano atingido",
    );
    await expect(consume(1)).rejects.toMatchObject({ status: 402, code: "PLAN_TASK_LIMIT_REACHED" });
  });
});
