/**
 * Fase 1 — critérios de aceite da fundação, de ponta a ponta pela API (Postgres real, RLS ligado):
 * cadastro, workspace com trial e padrões, convite, RBAC, isolamento entre tenants, reset de senha e 2FA.
 */
import { schema } from "@recpm/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Browser, createWorkspace, setupApp, signUp, totp, uniq } from "./helpers";

const { app, mailer, urls } = setupApp();
const ownerPool = new Pool({ connectionString: urls.owner });
const owner = drizzle({ client: ownerPool, schema, casing: "snake_case" });
afterAll(() => ownerPool.end());

describe("cadastro e workspace", () => {
  const ana = new Browser(app);
  let ws: { id: string; slug: string };

  test("cadastro exige aceite dos termos", async () => {
    const r = await new Browser(app).post("/api/auth/sign-up/email", {
      name: "Sem Aceite",
      email: `${uniq("x")}@example.test`,
      password: "senha-forte-123",
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("TERMS_NOT_ACCEPTED");
  });

  test("cadastro cria usuário, guarda o aceite e já autentica", async () => {
    const { userId } = await signUp(ana, "Ana");
    const [u] = await owner.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u?.termsAcceptedAt).toBeInstanceOf(Date);
    const [acc] = await owner.select().from(schema.accounts).where(eq(schema.accounts.userId, userId));
    expect(acc?.password).toMatch(/^\$argon2id\$/);
    const me = await ana.get("/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.json.tenant).toBeNull();
  });

  test("criar workspace: tenant + admin + catálogos + trial de 14 dias, numa transação", async () => {
    ws = await createWorkspace(ana, "Agência Ápice");
    const me = await ana.get("/api/v1/me");
    expect(me.json.tenant).toMatchObject({ id: ws.id, role: "admin", name: "Agência Ápice" });
    expect(me.json.tenant.permissions).toContain("tenant.billing");

    const cols = await owner
      .select()
      .from(schema.kanbanColumns)
      .where(eq(schema.kanbanColumns.tenantId, ws.id));
    expect(cols).toHaveLength(10);
    expect(cols.find((c) => c.isFinal)?.key).toBe("concluido");
    expect(cols.find((c) => c.isApproval)?.key).toBe("aguardando_aprovacao");
    const cats = await owner
      .select()
      .from(schema.reportCategories)
      .where(eq(schema.reportCategories.tenantId, ws.id));
    expect(cats.map((c) => c.label)).toEqual(
      expect.arrayContaining(["Artes", "Vídeos", "Captações", "Planejamento"]),
    );
    const [sub] = await owner
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, ws.id));
    expect(sub?.status).toBe("trialing");
    const days = (sub!.trialEndsAt!.getTime() - sub!.currentPeriodStart.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
    const [usage] = await owner
      .select()
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.tenantId, ws.id));
    expect(usage?.tasksCreated).toBe(0);
  });

  test("slug repetido devolve 409", async () => {
    const r = await ana.post("/api/v1/workspaces", { name: "Outra", slug: ws.slug });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("SLUG_TAKEN");
  });

  test("slug reservado é recusado na validação", async () => {
    const r = await ana.post("/api/v1/workspaces", { name: "App", slug: "app" });
    expect(r.status).toBe(400);
  });

  test("CSRF: origem desconhecida é bloqueada", async () => {
    const r = await ana.req(
      "POST",
      "/api/v1/workspaces",
      { name: "X", slug: uniq("ws") },
      { origin: "https://evil.example" },
    );
    expect(r.status).toBe(403);
  });

  test("sem sessão: 401", async () => {
    const r = await new Browser(app).get("/api/v1/me");
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("convites, RBAC e isolamento entre tenants", () => {
  const admin = new Browser(app);
  const bia = new Browser(app); // será funcionaria do tenant A
  const outsider = new Browser(app); // admin do tenant B
  let tenantA: string;
  let tenantB: string;
  let biaEmail: string;

  beforeAll(async () => {
    await signUp(admin, "Carla");
    tenantA = (await createWorkspace(admin, "Tenant A")).id;
    await signUp(outsider, "Otto");
    tenantB = (await createWorkspace(outsider, "Tenant B")).id;
    const meB = await outsider.get("/api/v1/me");
    if (meB.json.tenant?.id !== tenantB)
      throw new Error(`B não ativo após criar: ${JSON.stringify(meB.json)}`);
    biaEmail = (await signUp(bia, "Bia")).email;
    // convite só pode ser aceito com e-mail confirmado (prova de que o convidado é dono do e-mail)
    const verify = mailer.outbox.findLast((m) => m.to === biaEmail && m.subject.includes("Confirme"))!;
    const url = new URL(verify.text.match(/https?:\/\/\S+/)![0]);
    await bia.get(url.pathname + url.search);
  });

  test("admin convida funcionária; e-mail sai com o link do convite", async () => {
    const r = await admin.post("/api/auth/organization/invite-member", {
      email: biaEmail,
      role: "funcionario",
      organizationId: tenantA,
    });
    expect(r.status).toBe(200);
    const mail = mailer.outbox.findLast((m) => m.to === biaEmail);
    expect(mail?.subject).toContain("Tenant A");
    expect(mail?.text).toContain(`/convite/${r.json.id}`);
  });

  test("convidada aceita, entra no tenant como funcionario e vê só o que pode", async () => {
    const inv = mailer.outbox.findLast((m) => m.to === biaEmail)!;
    const invitationId = inv.text.match(/convite\/([0-9a-f-]{36})/)![1];
    const acc = await bia.post("/api/auth/organization/accept-invitation", { invitationId });
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    await bia.post("/api/auth/organization/set-active", { organizationId: tenantA });
    const me = await bia.get("/api/v1/me");
    expect(me.json.tenant.role).toBe("funcionario");
    expect(me.json.tenant.permissions).not.toContain("tenant.billing");
    const members = await bia.get("/api/v1/members");
    expect(members.status).toBe(200);
    expect(members.json.data.map((m: { email: string }) => m.email)).toContain(biaEmail);
  });

  test("funcionario não convida ninguém", async () => {
    const r = await bia.post("/api/auth/organization/invite-member", {
      email: `${uniq("z")}@example.test`,
      role: "funcionario",
      organizationId: tenantA,
    });
    expect(r.status).toBe(403);
  });

  test("convite de cliente exige um cliente do tenant", async () => {
    const r = await admin.post("/api/auth/organization/invite-member", {
      email: `${uniq("c")}@example.test`,
      role: "cliente",
      organizationId: tenantA,
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("CLIENT_REQUIRED");
  });

  test("admin de outro tenant não consegue ativar nem ler o tenant A", async () => {
    const r = await outsider.post("/api/auth/organization/set-active", { organizationId: tenantA });
    expect(r.status).toBe(403);
    // O Better Auth falha fechado: a tentativa limpa o tenant ativo da sessão.
    const me = await outsider.get("/api/v1/me");
    expect(me.json.tenant).toBeNull();
    expect((await outsider.get("/api/v1/members")).status).toBe(409);
    // Reativando o próprio tenant, só enxerga os próprios dados.
    expect(
      (await outsider.post("/api/auth/organization/set-active", { organizationId: tenantB })).status,
    ).toBe(200);
    const members = await outsider.get("/api/v1/members");
    expect(members.status).toBe(200);
    const emails = members.json.data.map((m: { email: string }) => m.email);
    expect(emails).not.toContain(biaEmail);
    expect(members.json.data).toHaveLength(1);
    const ws = await outsider.get("/api/v1/workspace");
    expect(ws.json.id).toBe(tenantB);
  });
});

describe("senha e 2FA", () => {
  test("reset de senha por e-mail troca a senha e derruba as sessões antigas", async () => {
    const b = new Browser(app);
    const { email } = await signUp(b, "Davi");
    const req = await new Browser(app).post("/api/auth/request-password-reset", {
      email,
      redirectTo: "http://localhost:5173/redefinir-senha",
    });
    expect(req.status).toBe(200);
    const mail = mailer.outbox.findLast((m) => m.to === email && m.subject.includes("Redefinir"))!;
    const token = mail.text.match(/reset-password\/([^?\s]+)/)![1];
    const reset = await new Browser(app).post("/api/auth/reset-password", {
      token,
      newPassword: "nova-senha-456",
    });
    expect(reset.status).toBe(200);
    expect((await b.get("/api/v1/me")).status).toBe(401); // sessão antiga revogada
    const login = await new Browser(app).post("/api/auth/sign-in/email", {
      email,
      password: "nova-senha-456",
    });
    expect(login.status).toBe(200);
  });

  test("login abre direto no workspace do usuário", async () => {
    const b = new Browser(app);
    const { email, password } = await signUp(b, "Gil");
    const ws = await createWorkspace(b, "Agência Gil");
    const fresh = new Browser(app);
    expect((await fresh.post("/api/auth/sign-in/email", { email, password })).status).toBe(200);
    const me = await fresh.get("/api/v1/me");
    expect(me.json.tenant?.id).toBe(ws.id);
    expect(me.json.tenant?.role).toBe("admin");
  });

  test("2FA TOTP: ativar, e o login passa a pedir o código", async () => {
    const b = new Browser(app);
    const { email, password } = await signUp(b, "Eva");
    const en = await b.post("/api/auth/two-factor/enable", { password });
    expect(en.status).toBe(200);
    const secret = new URL(en.json.totpURI).searchParams.get("secret")!;
    const ver = await b.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
    expect(ver.status).toBe(200);
    expect((await b.get("/api/v1/me")).json.user.twoFactorEnabled).toBe(true);

    const fresh = new Browser(app);
    const login = await fresh.post("/api/auth/sign-in/email", { email, password });
    expect(login.json.twoFactorRedirect).toBe(true);
    expect((await fresh.get("/api/v1/me")).status).toBe(401);
    const second = await fresh.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
    expect(second.status).toBe(200);
    expect((await fresh.get("/api/v1/me")).status).toBe(200);
  });
});

describe("infra", () => {
  test("health check", async () => {
    const r = await new Browser(app).get("/health");
    expect(r.json).toMatchObject({ ok: true, db: true });
  });
  test("OpenAPI é gerado", async () => {
    const r = await new Browser(app).get("/api/openapi.json");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.paths)).toEqual(
      expect.arrayContaining(["/api/v1/me", "/api/v1/workspaces", "/api/v1/members"]),
    );
  });
});
