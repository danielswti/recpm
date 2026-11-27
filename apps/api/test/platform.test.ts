import { schema } from "@recpm/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { Browser, createWorkspace, setupApp, signUp } from "./helpers";

const { app, dbs } = setupApp({ billing: { default: null } });
const platform = dbs.platformDb;
let root: Browser;
let rootId: string;
let tenantId: string;
let owner: Browser;
let ownerId: string;

beforeAll(async () => {
  root = new Browser(app);
  const r = await signUp(root, "Root");
  rootId = r.userId;
  await platform.update(schema.users).set({ role: "super_admin" }).where(eq(schema.users.id, rootId));
  // nova sessão para o papel valer
  root = new Browser(app);
  expect((await root.post("/api/auth/sign-in/email", { email: r.email, password: r.password })).status).toBe(
    200,
  );

  owner = new Browser(app);
  const o = await signUp(owner, "Dona");
  ownerId = o.userId;
  tenantId = (await createWorkspace(owner, "Agência Plataforma")).id;
});

const audits = (action: string) =>
  platform.select().from(schema.platformAuditLogs).where(eq(schema.platformAuditLogs.action, action));

describe("back-office do super_admin", () => {
  test("só super_admin acessa", async () => {
    expect((await owner.get("/api/v1/platform/metrics")).status).toBe(403);
    expect((await owner.get("/api/v1/platform/tenants")).status).toBe(403);
    expect((await new Browser(app).get("/api/v1/platform/metrics")).status).toBe(401);
    expect((await root.get("/api/v1/platform/metrics")).status).toBe(200);
  });

  test("lista tenants com plano, uso e admin; busca por nome", async () => {
    const r = await root.get("/api/v1/platform/tenants?q=Plataforma");
    expect(r.status).toBe(200);
    const row = r.json.data.find((t: { id: string }) => t.id === tenantId);
    expect(row).toMatchObject({
      name: "Agência Plataforma",
      status: "active",
      plan: { slug: "profissional" },
      subscriptionStatus: "trialing",
      tasksCreated: 0,
      tasksLimit: 1500,
      members: 1,
    });
    expect(row.adminEmail).toContain("dona");
    expect(
      (await root.get("/api/v1/platform/tenants?status=suspended")).json.data.some(
        (t: { id: string }) => t.id === tenantId,
      ),
    ).toBe(false);
  });

  test("suspender bloqueia o tenant; reativar libera; tudo auditado", async () => {
    expect(
      (await root.post(`/api/v1/platform/tenants/${tenantId}/suspend`, { reason: "teste de suspensão" }))
        .status,
    ).toBe(200);
    const blocked = await owner.get("/api/v1/members");
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe("TENANT_SUSPENDED");
    expect((await root.post(`/api/v1/platform/tenants/${tenantId}/reactivate`)).status).toBe(200);
    expect((await owner.get("/api/v1/members")).status).toBe(200);
    expect(
      (await audits("tenant.suspend")).some((a) => a.tenantId === tenantId && a.actorId === rootId),
    ).toBe(true);
  });

  test("plano manual (Enterprise) vale na hora e entra no MRR", async () => {
    const before = (await root.get("/api/v1/platform/metrics")).json.mrrCents;
    expect(
      (await root.post(`/api/v1/platform/tenants/${tenantId}/plan`, { planSlug: "enterprise", months: 12 }))
        .status,
    ).toBe(200);
    const e = (await owner.get("/api/v1/entitlements")).json;
    expect(e.plan.slug).toBe("enterprise");
    expect(e.provider).toBe("manual");
    expect(e.limits.tasksPerCycle).toBeNull();
    expect((await root.get("/api/v1/platform/metrics")).json.mrrCents).toBe(before + 31900);
  });

  test("edita plano e a página de cobrança reflete", async () => {
    const r = await root.req("PATCH", "/api/v1/platform/plans/essencial", {
      stripePriceIds: { monthly: "price_essencial" },
      limits: {
        tasksPerCycle: 350,
        maxUsers: 10,
        maxClientPortalUsers: 20,
        storageGb: 20,
        aiMessagesPerCycle: 600,
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.stripePriceIds.monthly).toBe("price_essencial");
    const plans = (await owner.get("/api/v1/billing")).json.plans;
    expect(plans.find((p: { slug: string }) => p.slug === "essencial").limits.tasksPerCycle).toBe(350);
    // restaura
    await root.req("PATCH", "/api/v1/platform/plans/essencial", {
      limits: {
        tasksPerCycle: 300,
        maxUsers: 10,
        maxClientPortalUsers: 20,
        storageGb: 20,
        aiMessagesPerCycle: 600,
      },
    });
  });

  test("personificar o admin: sessão marcada, back-office bloqueado durante, auditoria de início e fim", async () => {
    const t = await root.post(`/api/v1/platform/tenants/${tenantId}/impersonation`, {
      reason: "suporte chamado #12",
    });
    expect(t.json).toEqual({ userId: ownerId, tenantId });
    const imp = await root.post("/api/auth/admin/impersonate-user", { userId: ownerId });
    expect(imp.status, JSON.stringify(imp.json)).toBe(200);
    await root.post("/api/auth/organization/set-active", { organizationId: tenantId });
    const me = (await root.get("/api/v1/me")).json;
    expect(me.user.id).toBe(ownerId);
    expect(me.impersonating).toBe(true);
    expect(me.tenant.id).toBe(tenantId);
    expect((await root.get("/api/v1/platform/metrics")).status).toBe(403);

    expect((await root.post("/api/auth/admin/stop-impersonating")).status).toBe(200);
    const back = (await root.get("/api/v1/me")).json;
    expect(back.user.id).toBe(rootId);
    expect(back.impersonating).toBe(false);

    expect((await audits("tenant.impersonate")).some((a) => a.tenantId === tenantId)).toBe(true);
    const start = await platform
      .select()
      .from(schema.platformAuditLogs)
      .where(
        and(
          eq(schema.platformAuditLogs.action, "user.impersonate.start"),
          eq(schema.platformAuditLogs.actorId, rootId),
        ),
      );
    expect(start.length).toBe(1);
    expect((await audits("user.impersonate.stop")).some((a) => a.actorId === rootId)).toBe(true);
  });
});
