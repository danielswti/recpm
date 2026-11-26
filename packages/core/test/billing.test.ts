import { type AppDb, schema, withTenant } from "@recpm/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  addDays,
  addMonths,
  applyBillingEvent,
  consumeTaskQuota,
  DomainError,
  loadEntitlements,
  planChangeFor,
  recordPlanChange,
  runBillingCycle,
} from "../src";

const urls = inject("db");
const pools: Pool[] = [];
const mk = (url: string, max = 10) => {
  const pool = new Pool({ connectionString: url, max });
  pools.push(pool);
  return drizzle({ client: pool, schema, casing: "snake_case" }) as AppDb;
};
let app: AppDb;
let platform: AppDb;
const plan: Record<string, typeof schema.plans.$inferSelect> = {};

beforeAll(async () => {
  app = mk(urls.app, 25);
  platform = mk(urls.platform);
  for (const p of await platform.select().from(schema.plans)) plan[p.slug] = p;
  // plano de teste com cota pequena
  const [tiny] = await platform
    .insert(schema.plans)
    .values({
      slug: "teste-5",
      name: "Teste 5",
      priceMonthlyCents: 1000,
      priceYearlyCents: null,
      limits: { tasksPerCycle: 5, maxUsers: 3, maxClientPortalUsers: 3, storageGb: 1, aiMessagesPerCycle: 0 },
      features: { ...plan.basico!.features },
    })
    .returning();
  plan["teste-5"] = tiny!;
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

type SubInit = Partial<typeof schema.tenantSubscriptions.$inferInsert> & { planSlug?: string };

async function tenant(init: SubInit = {}) {
  const id = uuidv7();
  const now = new Date();
  const start = init.currentPeriodStart ?? now;
  const end = init.currentPeriodEnd ?? addMonths(start, 1);
  await platform.insert(schema.tenants).values({ id, name: "T", slug: `t-${id.slice(-12)}` });
  const { planSlug, ...rest } = init;
  await platform.insert(schema.tenantSubscriptions).values({
    tenantId: id,
    planId: plan[planSlug ?? "teste-5"]!.id,
    status: "active",
    ...rest,
    currentPeriodStart: start,
    currentPeriodEnd: end,
  });
  await platform.insert(schema.usageCounters).values({ tenantId: id, periodStart: start, periodEnd: end });
  return id;
}
const sub = async (tenantId: string) =>
  (
    await platform
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
  )[0]!;
const tstatus = async (tenantId: string) =>
  (
    await platform
      .select({ s: schema.tenants.status })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId))
  )[0]!.s;
const asTenant = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { tenantId, actor: "system" }, fn);

describe("cota de tarefas", () => {
  test("20 criações concorrentes com limite 5 → exatamente 5 passam, o resto recebe 402", async () => {
    const t = await tenant();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => asTenant(t, (tx) => consumeTaskQuota(tx))),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const fail = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(5);
    expect(fail).toHaveLength(15);
    for (const f of fail) {
      expect(f.reason).toBeInstanceOf(DomainError);
      expect(f.reason.status).toBe(402);
      expect(f.reason.code).toBe("PLAN_TASK_LIMIT_REACHED");
    }
    const e = await asTenant(t, loadEntitlements);
    expect(e.usage).toEqual({ tasksCreated: 5, tasksPercent: 100 });
  });

  test("avisos de 80/90/100% saem uma única vez por ciclo", async () => {
    const t = await tenant();
    const warnings: number[][] = [];
    for (let i = 0; i < 5; i++) warnings.push((await asTenant(t, (tx) => consumeTaskQuota(tx))).warnings);
    // 4/5 = 80%, 5/5 = 100% (90% cruzado junto)
    expect(warnings).toEqual([[], [], [], [80], [90, 100]]);
  });

  test("consumo é desfeito se a transação da tarefa falhar", async () => {
    const t = await tenant();
    await expect(
      asTenant(t, async (tx) => {
        await consumeTaskQuota(tx);
        throw new Error("insert da tarefa falhou");
      }),
    ).rejects.toThrow("insert da tarefa falhou");
    expect((await asTenant(t, loadEntitlements)).usage.tasksCreated).toBe(0);
  });

  test("plano ilimitado não tem teto nem avisos", async () => {
    const t = await tenant({ planSlug: "enterprise" });
    const r = await asTenant(t, (tx) => consumeTaskQuota(tx, 500));
    expect(r).toEqual({ used: 500, limit: null, warnings: [] });
    expect((await asTenant(t, loadEntitlements)).usage.tasksPercent).toBeNull();
  });

  test("tenant somente leitura não cria tarefas", async () => {
    const t = await tenant();
    await platform.update(schema.tenants).set({ status: "read_only" }).where(eq(schema.tenants.id, t));
    await expect(asTenant(t, (tx) => consumeTaskQuota(tx))).rejects.toMatchObject({
      code: "TENANT_READ_ONLY",
    });
  });

  test("a cota é do tenant: o consumo de um não afeta outro", async () => {
    const a = await tenant();
    const b = await tenant();
    await asTenant(a, (tx) => consumeTaskQuota(tx, 5));
    await expect(asTenant(b, (tx) => consumeTaskQuota(tx, 5))).resolves.toMatchObject({ used: 5 });
  });
});

describe("entitlements", () => {
  test("refletem plano, limites, recursos e trial", async () => {
    const trialEnd = addDays(new Date(), 14);
    const t = await tenant({
      planSlug: "profissional",
      status: "trialing",
      trialEndsAt: trialEnd,
      currentPeriodEnd: trialEnd,
    });
    const e = await asTenant(t, loadEntitlements);
    expect(e.plan).toMatchObject({ slug: "profissional", priceMonthlyCents: 24700, currency: "BRL" });
    expect(e.status).toBe("trialing");
    expect(e.trialEndsAt).toBe(trialEnd.toISOString());
    expect(e.limits.tasksPerCycle).toBe(1500);
    expect(e.features.eSignature).toBe(true);
    expect(e.features.sso).toBe(false);
    expect(e.readOnly).toBe(false);
  });
});

describe("job de ciclo", () => {
  test("trial vencido sem pagamento volta ao Básico com cota nova", async () => {
    const past = addDays(new Date(), -15);
    const t = await tenant({
      planSlug: "profissional",
      status: "trialing",
      trialEndsAt: addDays(past, 14),
      currentPeriodStart: past,
      currentPeriodEnd: addDays(past, 14),
    });
    const r = await runBillingCycle(platform);
    expect(r.trialsEnded).toBeGreaterThanOrEqual(1);
    const s = await sub(t);
    expect(s.planId).toBe(plan.basico!.id);
    expect(s.status).toBe("active");
    const e = await asTenant(t, loadEntitlements);
    expect(e.usage.tasksCreated).toBe(0);
    expect(e.limits.tasksPerCycle).toBe(50);
  });

  test("virada do ciclo zera a cota e aplica o downgrade agendado", async () => {
    const start = addMonths(new Date(), -1);
    const t = await tenant({
      planSlug: "essencial",
      currentPeriodStart: start,
      currentPeriodEnd: addDays(new Date(), -1),
    });
    await asTenant(t, (tx) => consumeTaskQuota(tx, 10));
    await platform
      .update(schema.tenantSubscriptions)
      .set({ pendingPlanId: plan.basico!.id })
      .where(eq(schema.tenantSubscriptions.tenantId, t));
    await runBillingCycle(platform);
    const s = await sub(t);
    expect(s.planId).toBe(plan.basico!.id);
    expect(s.pendingPlanId).toBeNull();
    expect(s.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    expect((await asTenant(t, loadEntitlements)).usage.tasksCreated).toBe(0);
    // rodar de novo não muda nada
    const again = await runBillingCycle(platform);
    expect((await sub(t)).currentPeriodStart.getTime()).toBe(s.currentPeriodStart.getTime());
    expect(again.trialsEnded + again.periodsRolled + again.readOnly).toBe(0);
  });

  test("carência vencida deixa o tenant somente leitura, sem apagar nada", async () => {
    const t = await tenant({
      status: "past_due",
      provider: "stripe",
      providerSubscriptionId: `sub_${t8()}`,
      pastDueSince: addDays(new Date(), -8),
      graceEndsAt: addDays(new Date(), -1),
    });
    await runBillingCycle(platform);
    expect(await tstatus(t)).toBe("read_only");
    expect((await asTenant(t, loadEntitlements)).readOnly).toBe(true);
  });
});

const t8 = () => uuidv7().slice(-8);

describe("eventos de cobrança (webhooks normalizados)", () => {
  test("assinatura sincronizada, idempotência, falha → carência, pagamento → reativa, cancelamento → Básico", async () => {
    const trialEnd = addDays(new Date(), 10);
    const t = await tenant({
      planSlug: "profissional",
      status: "trialing",
      trialEndsAt: trialEnd,
      currentPeriodEnd: trialEnd,
    });
    const subId = `sub_${t8()}`;
    const start = new Date();
    const synced = {
      kind: "subscription.synced" as const,
      provider: "stripe" as const,
      eventId: `evt_${t8()}`,
      tenantId: t,
      planId: plan.essencial!.id,
      interval: "monthly" as const,
      providerCustomerId: "cus_1",
      providerSubscriptionId: subId,
      status: "active" as const,
      periodStart: start,
      periodEnd: addMonths(start, 1),
      cancelAtPeriodEnd: false,
    };
    expect(await applyBillingEvent(platform, synced, {})).toEqual({ tenantId: t, duplicate: false });
    expect(await applyBillingEvent(platform, synced, {})).toEqual({ tenantId: null, duplicate: true });
    let s = await sub(t);
    expect(s).toMatchObject({
      planId: plan.essencial!.id,
      status: "active",
      provider: "stripe",
      trialEndsAt: null,
    });

    await applyBillingEvent(
      platform,
      { kind: "payment.failed", provider: "stripe", eventId: `evt_${t8()}`, providerSubscriptionId: subId },
      {},
    );
    s = await sub(t);
    expect(s.status).toBe("past_due");
    const graceDays = (s.graceEndsAt!.getTime() - s.pastDueSince!.getTime()) / 86_400_000;
    expect(graceDays).toBe(7);

    await platform.update(schema.tenants).set({ status: "read_only" }).where(eq(schema.tenants.id, t));
    await applyBillingEvent(
      platform,
      {
        kind: "payment.succeeded",
        provider: "stripe",
        eventId: `evt_${t8()}`,
        providerSubscriptionId: subId,
      },
      {},
    );
    expect((await sub(t)).status).toBe("active");
    expect(await tstatus(t)).toBe("active");

    await applyBillingEvent(
      platform,
      {
        kind: "subscription.canceled",
        provider: "stripe",
        eventId: `evt_${t8()}`,
        providerSubscriptionId: subId,
      },
      {},
    );
    s = await sub(t);
    expect(s).toMatchObject({
      planId: plan.basico!.id,
      provider: null,
      providerSubscriptionId: null,
      status: "active",
    });
  });

  test("downgrade pago: o plano atual vale até a virada do ciclo", async () => {
    const start = new Date();
    const subId = `sub_${t8()}`;
    const t = await tenant({
      planSlug: "profissional",
      provider: "stripe",
      providerSubscriptionId: subId,
      providerCustomerId: "cus_2",
      currentPeriodStart: start,
    });
    await asTenant(t, async (tx) => recordPlanChange(tx, await planChangeFor(tx, "essencial")));
    expect((await sub(t)).pendingPlanId).toBe(plan.essencial!.id);
    const base = {
      kind: "subscription.synced" as const,
      provider: "stripe" as const,
      tenantId: t,
      planId: plan.essencial!.id,
      interval: "monthly" as const,
      providerCustomerId: "cus_2",
      providerSubscriptionId: subId,
      status: "active" as const,
      cancelAtPeriodEnd: false,
    };
    await applyBillingEvent(
      platform,
      { ...base, eventId: `evt_${t8()}`, periodStart: start, periodEnd: addMonths(start, 1) },
      {},
    );
    expect((await sub(t)).planId).toBe(plan.profissional!.id); // ainda no ciclo atual
    const next = addMonths(start, 1);
    await applyBillingEvent(
      platform,
      { ...base, eventId: `evt_${t8()}`, periodStart: next, periodEnd: addMonths(next, 1) },
      {},
    );
    const s = await sub(t);
    expect(s.planId).toBe(plan.essencial!.id);
    expect(s.pendingPlanId).toBeNull();
    const [counter] = await platform
      .select()
      .from(schema.usageCounters)
      .where(and(eq(schema.usageCounters.tenantId, t), eq(schema.usageCounters.periodStart, next)));
    expect(counter?.tasksCreated).toBe(0);
  });
});

describe("troca de plano", () => {
  test("modos conforme assinatura e preço", async () => {
    const trial = await tenant({
      planSlug: "profissional",
      status: "trialing",
      trialEndsAt: addDays(new Date(), 5),
    });
    const mode = (t: string, slug: string) =>
      asTenant(t, (tx) => planChangeFor(tx, slug).then((c) => c.mode));
    expect(await mode(trial, "essencial")).toBe("checkout");
    await expect(mode(trial, "basico")).rejects.toMatchObject({ code: "TRIAL_ENDS_ON_FREE" });
    await expect(mode(trial, "enterprise")).rejects.toMatchObject({ code: "PLAN_REQUIRES_CONTACT" });

    const paid = await tenant({
      planSlug: "essencial",
      provider: "asaas",
      providerSubscriptionId: `sub_${t8()}`,
    });
    expect(await mode(paid, "profissional")).toBe("upgrade");
    expect(await mode(paid, "basico")).toBe("cancel_at_period_end");
    await expect(mode(paid, "essencial")).rejects.toMatchObject({ code: "PLAN_UNCHANGED" });

    const free = await tenant({ planSlug: "basico" });
    expect(await mode(free, "essencial")).toBe("checkout");
  });
});

describe("cancelamento ao fim do ciclo (assinatura paga)", () => {
  test("ciclo vencido com cancelAtPeriodEnd volta ao Básico e solta o provedor", async () => {
    const t = await tenant({
      planSlug: "essencial",
      provider: "asaas",
      providerSubscriptionId: `sub_${t8()}`,
      cancelAtPeriodEnd: true,
      currentPeriodStart: addMonths(new Date(), -1),
      currentPeriodEnd: addDays(new Date(), -1),
    });
    await runBillingCycle(platform);
    expect(await sub(t)).toMatchObject({ planId: plan.basico!.id, provider: null, cancelAtPeriodEnd: false });
  });
});
