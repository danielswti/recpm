/**
 * Fase 3 — cadastros, clientes e usuários pela API (Postgres real, RLS ligado).
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addMember, Browser, createWorkspace, setupApp, signUp } from "./helpers";

const { app, mailer, urls } = setupApp();
const ownerPool = new Pool({ connectionString: urls.owner });
afterAll(() => ownerPool.end());

const admin = new Browser(app);
const other = new Browser(app);
let tenantId: string;
let gestor: Browser;
let funcionario: { browser: Browser; email: string };

beforeAll(async () => {
  await signUp(admin, "Duda");
  tenantId = (await createWorkspace(admin, "Agência Cadastros")).id;
  await signUp(other, "Outro");
  await createWorkspace(other, "Outra Agência");
  gestor = (await addMember(app, admin, mailer, tenantId, "Gil", "gestor")).browser;
  funcionario = await addMember(app, admin, mailer, tenantId, "Fabi", "funcionario");
});

describe("catálogos simples", () => {
  test("workspace novo já vem com os padrões em ordem", async () => {
    const r = await admin.get("/api/v1/catalogs/project-types");
    expect(r.status).toBe(200);
    expect(r.json.data.length).toBeGreaterThan(0);
    const positions = r.json.data.map((i: { position: number }) => i.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const cols = await admin.get("/api/v1/catalogs/kanban-columns");
    expect(cols.json.data.map((c: { key: string }) => c.key)).toEqual([
      "demandas",
      "a_fazer",
      "executar_primeiro",
      "em_andamento",
      "ajustes",
      "aguardando_aprovacao",
      "enviar_cliente",
      "aguardando_cliente",
      "veicular",
      "concluido",
    ]);
  });

  test("cria, edita, reordena, desativa e apaga", async () => {
    const a = await admin.post("/api/v1/catalogs/sectors", { label: "Motion design", color: "#ff0000" });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    const b = await admin.post("/api/v1/catalogs/sectors", { label: "Social" });
    expect((await admin.post("/api/v1/catalogs/sectors", { label: "social" })).json.error.code).toBe(
      "DUPLICATE",
    );

    const up = await admin.patch(`/api/v1/catalogs/sectors/${a.json.id}`, { label: "Vídeo", active: false });
    expect(up.json).toMatchObject({ label: "Vídeo", active: false });

    const all = (await admin.get("/api/v1/catalogs/sectors")).json.data.map((i: { id: string }) => i.id);
    const reversed = [...all].reverse();
    expect((await admin.put("/api/v1/catalogs/sectors/order", { ids: reversed })).status).toBe(204);
    const after = (await admin.get("/api/v1/catalogs/sectors")).json.data.map((i: { id: string }) => i.id);
    expect(after).toEqual(reversed);

    expect((await admin.del(`/api/v1/catalogs/sectors/${b.json.id}`)).status).toBe(204);
  });

  test("slug é gerado e não repete", async () => {
    const a = await admin.post("/api/v1/catalogs/project-tags", { label: "Lançamento Verão" });
    const b = await admin.post("/api/v1/catalogs/project-tags", { label: "Lançamento  verão!" });
    expect(a.json.slug).toBe("lancamento-verao");
    expect(b.json.slug).toBe("lancamento-verao-2");
  });

  test("item em uso não é apagado: 409 e sugestão de desativar", async () => {
    const sector = await admin.post("/api/v1/catalogs/sectors", { label: "Design" });
    const members = (await admin.get("/api/v1/members?kind=team")).json.data;
    const fabi = members.find((m: { email: string }) => m.email === funcionario.email);
    expect((await admin.patch(`/api/v1/members/${fabi.id}`, { sectorId: sector.json.id })).status).toBe(200);
    const del = await admin.del(`/api/v1/catalogs/sectors/${sector.json.id}`);
    expect(del.status).toBe(409);
    expect(del.json.error.code).toBe("CATALOG_IN_USE");
  });

  test("só admin altera; gestor e funcionário leem", async () => {
    expect((await gestor.get("/api/v1/catalogs/tags")).status).toBe(200);
    expect((await funcionario.browser.get("/api/v1/catalogs/task-types")).status).toBe(200);
    expect((await gestor.post("/api/v1/catalogs/tags", { label: "x" })).status).toBe(403);
    expect((await funcionario.browser.post("/api/v1/catalogs/task-roles", { label: "x" })).status).toBe(403);
  });

  test("isolamento: um tenant não vê nem altera itens do outro", async () => {
    const mine = await admin.post("/api/v1/catalogs/tags", { label: "Privada" });
    const theirs = (await other.get("/api/v1/catalogs/tags")).json.data;
    expect(theirs.find((t: { id: string }) => t.id === mine.json.id)).toBeUndefined();
    expect((await other.patch(`/api/v1/catalogs/tags/${mine.json.id}`, { label: "hack" })).status).toBe(404);
    expect((await other.del(`/api/v1/catalogs/tags/${mine.json.id}`)).status).toBe(404);
  });
});

describe("tipos de tarefa", () => {
  test("cria com checklist e categoria; edita substituindo o checklist", async () => {
    const cats = (await admin.get("/api/v1/catalogs/report-categories")).json.data;
    const r = await admin.post("/api/v1/catalogs/task-types", {
      label: "Carrossel",
      defaultEstimatedHours: 3.5,
      reportCategoryId: cats[0].id,
      checklist: ["Roteiro", "Layout", "Revisão"],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({
      slug: "carrossel",
      defaultEstimatedHours: 3.5,
      checklist: ["Roteiro", "Layout", "Revisão"],
    });
    const up = await admin.patch(`/api/v1/catalogs/task-types/${r.json.id}`, {
      checklist: ["Layout"],
      sellable: false,
    });
    expect(up.json).toMatchObject({ checklist: ["Layout"], sellable: false });
  });

  test("categoria de outro tenant é recusada", async () => {
    const theirCat = (await other.get("/api/v1/catalogs/report-categories")).json.data[0];
    const r = await admin.post("/api/v1/catalogs/task-types", {
      label: "Intruso",
      reportCategoryId: theirCat.id,
    });
    expect(r.status).toBe(400);
  });
});

describe("colunas do Kanban", () => {
  test("nova coluna ganha chave estável; só uma final; colunas do fluxo são protegidas", async () => {
    const r = await admin.post("/api/v1/catalogs/kanban-columns", {
      label: "Revisão do cliente",
      emoji: "🧐",
    });
    expect(r.json.key).toBe("revisao_do_cliente");
    const renamed = await admin.patch(`/api/v1/catalogs/kanban-columns/${r.json.id}`, {
      label: "Revisão externa",
    });
    expect(renamed.json.key).toBe("revisao_do_cliente");

    const cols = (await admin.get("/api/v1/catalogs/kanban-columns")).json.data;
    const ajustes = cols.find((c: { key: string }) => c.key === "ajustes");
    const final = cols.find((c: { isFinal: boolean }) => c.isFinal);
    expect((await admin.del(`/api/v1/catalogs/kanban-columns/${ajustes.id}`)).json.error.code).toBe(
      "COLUMN_REQUIRED",
    );
    expect((await admin.patch(`/api/v1/catalogs/kanban-columns/${final.id}`, { active: false })).status).toBe(
      409,
    );

    await admin.patch(`/api/v1/catalogs/kanban-columns/${r.json.id}`, { isFinal: true });
    const after = (await admin.get("/api/v1/catalogs/kanban-columns")).json.data;
    expect(after.filter((c: { isFinal: boolean }) => c.isFinal).map((c: { id: string }) => c.id)).toEqual([
      r.json.id,
    ]);
    await admin.patch(`/api/v1/catalogs/kanban-columns/${final.id}`, { isFinal: true });

    expect((await admin.del(`/api/v1/catalogs/kanban-columns/${r.json.id}`)).status).toBe(204);
  });
});

describe("formulários de briefing", () => {
  test("cria, valida opções, duplica e apaga", async () => {
    const bad = await admin.post("/api/v1/briefing-forms", {
      name: "Ruim",
      fields: [{ label: "Formato", type: "escolha_unica", options: ["só uma"] }],
    });
    expect(bad.status).toBe(400);
    const f = await admin.post("/api/v1/briefing-forms", {
      name: "Briefing de vídeo",
      fields: [
        { label: "Objetivo", type: "paragrafo", required: true },
        { label: "Formato", type: "caixas", options: ["Vertical", "Horizontal"], allowOther: true },
      ],
    });
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    expect(f.json.fields.map((x: { label: string }) => x.label)).toEqual(["Objetivo", "Formato"]);
    const dup = await admin.post(`/api/v1/briefing-forms/${f.json.id}/duplicate`);
    expect(dup.json).toMatchObject({ name: "Briefing de vídeo (cópia)", active: false, fieldCount: 2 });
    expect((await admin.del(`/api/v1/briefing-forms/${dup.json.id}`)).status).toBe(204);
    const list = (await admin.get("/api/v1/briefing-forms")).json.data;
    expect(list.map((x: { id: string }) => x.id)).toEqual([f.json.id]);
    expect((await gestor.post("/api/v1/briefing-forms", { name: "x", fields: [] })).status).toBe(403);
  });
});

describe("clientes", () => {
  test("CRUD com código único, documento validado e busca", async () => {
    const r = await admin.post("/api/v1/clients", {
      code: "acme",
      name: "Acme Ltda",
      document: "11.222.333/0001-81",
      email: "",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ code: "ACME", document: "11222333000181", email: null, projectCount: 0 });
    expect(r.json.hours).toEqual({ contracted: 0, invested: 0, remaining: 0 });
    expect((await admin.post("/api/v1/clients", { code: "ACME", name: "Outra" })).json.error.code).toBe(
      "CLIENT_CODE_TAKEN",
    );
    expect((await admin.post("/api/v1/clients", { code: "BAD", name: "X", document: "123" })).status).toBe(
      400,
    );

    expect((await admin.get("/api/v1/clients?q=acm")).json.total).toBe(1);
    expect((await admin.get("/api/v1/clients?q=11222333")).json.total).toBe(1);

    const off = await admin.patch(`/api/v1/clients/${r.json.id}`, { active: false });
    expect(off.json.active).toBe(false);
    expect((await admin.get("/api/v1/clients")).json.total).toBe(0);
    expect((await admin.get("/api/v1/clients?status=inactive")).json.total).toBe(1);

    expect((await gestor.get("/api/v1/clients?status=all")).status).toBe(200);
    expect((await funcionario.browser.post("/api/v1/clients", { code: "NOPE", name: "x" })).status).toBe(403);
    expect((await other.get(`/api/v1/clients/${r.json.id}`)).status).toBe(404);
  });

  test("usuário do portal: convite aparece e, depois de aceito, conta no cliente; cliente em uso não é apagado", async () => {
    const c = await admin.post("/api/v1/clients", { code: "PORT", name: "Portal SA" });
    const portal = await addMember(app, admin, mailer, tenantId, "Paula", "cliente", { clientId: c.json.id });
    const users = (await admin.get(`/api/v1/clients/${c.json.id}/portal-users`)).json.data;
    expect(users).toEqual([expect.objectContaining({ kind: "member", email: portal.email, active: true })]);
    expect((await admin.get(`/api/v1/clients/${c.json.id}`)).json.portalUserCount).toBe(1);
    const del = await admin.del(`/api/v1/clients/${c.json.id}`);
    expect(del.json.error.code).toBe("CLIENT_IN_USE");
    // portal do cliente não lista clientes
    expect((await portal.browser.get("/api/v1/clients")).status).toBe(403);
  });
});

describe("usuários", () => {
  const find = async (email: string) =>
    (await admin.get("/api/v1/members?kind=all")).json.data.find((m: { email: string }) => m.email === email);

  test("edita perfil de trabalho e papel, com auditoria", async () => {
    const fabi = await find(funcionario.email);
    const r = await admin.patch(`/api/v1/members/${fabi.id}`, {
      jobTitle: "Designer",
      level: "pleno",
      employmentType: "pj",
      hourlyCostCents: 8000,
      birthday: "1995-03-10",
      businessHours: { days: { "1": [{ start: "09:00", end: "18:00" }] } },
      role: "gestor",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({
      jobTitle: "Designer",
      level: "pleno",
      role: "gestor",
      birthday: "1995-03-10",
    });
    await admin.patch(`/api/v1/members/${fabi.id}`, { role: "funcionario" });
    const bad = await admin.patch(`/api/v1/members/${fabi.id}`, {
      businessHours: { days: { "1": [{ start: "18:00", end: "09:00" }] } },
    });
    expect(bad.status).toBe(400);
  });

  test("lista separa equipe e portal", async () => {
    const team = (await admin.get("/api/v1/members?kind=team")).json.data;
    const clients = (await admin.get("/api/v1/members?kind=clients")).json.data;
    expect(team.every((m: { role: string }) => m.role !== "cliente")).toBe(true);
    expect(
      clients.every((m: { role: string; clientName: string }) => m.role === "cliente" && m.clientName),
    ).toBe(true);
  });

  test("regras: não muda o próprio papel, não fica sem admin, gestor não gerencia", async () => {
    const me = (await admin.get("/api/v1/me")).json;
    const self = (await admin.get("/api/v1/members")).json.data.find(
      (m: { userId: string }) => m.userId === me.user.id,
    );
    expect((await admin.patch(`/api/v1/members/${self.id}`, { role: "gestor" })).json.error.code).toBe(
      "OWN_ROLE",
    );
    expect((await admin.post(`/api/v1/members/${self.id}/deactivate`)).json.error.code).toBe("OWN_ACCOUNT");
    const fabi = await find(funcionario.email);
    expect((await gestor.patch(`/api/v1/members/${fabi.id}`, { jobTitle: "x" })).status).toBe(403);
  });

  test("desativar corta o acesso; reativar devolve; reset de senha envia e-mail", async () => {
    const fabi = await find(funcionario.email);
    expect((await admin.post(`/api/v1/members/${fabi.id}/deactivate`)).json.active).toBe(false);
    expect((await funcionario.browser.get("/api/v1/catalogs/tags")).status).toBe(403);
    expect((await admin.post(`/api/v1/members/${fabi.id}/reset-password`)).status).toBe(409);
    expect((await admin.post(`/api/v1/members/${fabi.id}/reactivate`)).json.active).toBe(true);
    expect((await funcionario.browser.get("/api/v1/catalogs/tags")).status).toBe(200);
    const before = mailer.outbox.length;
    expect((await admin.post(`/api/v1/members/${fabi.id}/reset-password`)).status).toBe(204);
    expect(mailer.outbox.slice(before).some((m) => m.to === funcionario.email)).toBe(true);
  });
});

test("OpenAPI documenta as rotas novas", async () => {
  const r = await app.request("http://localhost:3000/api/openapi.json");
  expect(r.status).toBe(200);
  const doc = (await r.json()) as { paths: Record<string, unknown> };
  expect(Object.keys(doc.paths)).toEqual(
    expect.arrayContaining([
      "/api/v1/catalogs/{kind}",
      "/api/v1/clients",
      "/api/v1/briefing-forms",
      "/api/v1/members/{id}",
    ]),
  );
});

test("limite de usuários vale no aceite: convite feito antes da troca para um plano menor não entra", async () => {
  const late = new Browser(app);
  const { email } = await signUp(late, "Tardio");
  const verify = mailer.outbox.findLast((m) => m.to === email && m.subject.includes("Confirme"))!;
  const url = new URL(verify.text.match(/https?:\/\/\S+/)![0]);
  await late.get(url.pathname + url.search);
  const inv = await admin.post("/api/auth/organization/invite-member", {
    email,
    role: "funcionario",
    organizationId: tenantId,
  });
  expect(inv.status).toBe(200);
  // o workspace cai para o Básico (3 usuários) e já tem 3 pessoas na equipe
  await ownerPool.query(
    "update tenant_subscriptions set plan_id = (select id from plans where slug = 'basico') where tenant_id = $1",
    [tenantId],
  );
  const acc = await late.post("/api/auth/organization/accept-invitation", { invitationId: inv.json.id });
  expect(acc.status).toBe(402);
  expect(acc.json.code).toBe("PLAN_USER_LIMIT_REACHED");
});
