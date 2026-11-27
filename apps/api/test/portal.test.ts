/**
 * Fase 9 — portal do cliente: isolamento entre clientes, valores internos fora da resposta,
 * comentários, aprovação e pedido de ajuste, tarefas criadas pelo cliente (cota), demandas com
 * briefing (fila da equipe: aceitar/recusar) e assinatura pelo próprio login.
 */
import { PDFDocument } from "pdf-lib";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Storage } from "../src/lib/storage";
import { addMember, Browser, createWorkspace, setupApp, signUp } from "./helpers";

const objects = new Map<string, Uint8Array>();
const storage: Storage = {
  presignUpload: async (key) => ({ url: `https://bucket.test/${key}?sig=1`, headers: {} }),
  presignDownload: async (key) => `https://bucket.test/${key}?download=1`,
  head: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)!.byteLength } : null),
  get: async (key) => objects.get(key) ?? null,
  put: async (key, body) => void objects.set(key, body),
  stream: async () => null,
  remove: async () => {},
};
const { app, mailer, urls } = setupApp({ storage });
const owner = new Pool({ connectionString: urls.owner });
afterAll(() => owner.end());

const admin = new Browser(app);
let tenantId: string;
let gestor: { browser: Browser; userId: string };
let paula: { browser: Browser; userId: string; email: string };
let outro: { browser: Browser; userId: string };
let projectId: string;
let otherProject: string;
let taskVisible: string;
let taskHidden: string;
const setPlan = (slug: string) =>
  owner.query(
    "update tenant_subscriptions set plan_id = (select id from plans where slug = $2) where tenant_id = $1",
    [tenantId, slug],
  );

beforeAll(async () => {
  await signUp(admin, "Ana");
  tenantId = (await createWorkspace(admin, "Agência Portal")).id;
  await setPlan("profissional");
  gestor = await addMember(app, admin, mailer, tenantId, "Gil", "gestor");
  const pao = (await admin.post("/api/v1/clients", { code: "PAO", name: "Padaria" })).json.id;
  const xyz = (await admin.post("/api/v1/clients", { code: "XYZ", name: "Outra Empresa" })).json.id;
  paula = await addMember(app, admin, mailer, tenantId, "Paula", "cliente", { clientId: pao });
  outro = await addMember(app, admin, mailer, tenantId, "Otto", "cliente", { clientId: xyz });
  const p = await admin.post("/api/v1/projects", {
    name: "Padaria | Site",
    clientId: pao,
    managerId: gestor.userId,
    valueCents: 990000,
    publicSummary: "Novo site da padaria com loja.",
  });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  projectId = p.json.id;
  otherProject = (await admin.post("/api/v1/projects", { name: "XYZ | Campanha", clientId: xyz })).json.id;
  taskVisible = (
    await admin.post("/api/v1/tasks", { title: "Layout da home", projectId, visibleToClient: true })
  ).json.id;
  taskHidden = (await admin.post("/api/v1/tasks", { title: "Orçamento interno", projectId })).json.id;
  await admin.post(`/api/v1/projects/${projectId}/milestones`, {
    title: "Entrega do layout",
    date: "2030-02-01",
    visibleToClient: true,
  });
  await admin.post(`/api/v1/projects/${projectId}/milestones`, {
    title: "Marco interno",
    date: "2030-01-15",
    visibleToClient: false,
  });
  await admin.post(`/api/v1/projects/${projectId}/comments`, {
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Olá, Paula!" }] }] },
    visibleToClient: true,
  });
  await admin.post(`/api/v1/projects/${projectId}/comments`, {
    body: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Nota interna" }] }],
    },
  });
});

describe("portal do cliente", () => {
  test("só o papel cliente entra; a equipe recebe 403", async () => {
    expect((await admin.get("/api/v1/portal/home")).status).toBe(403);
    expect((await paula.browser.get("/api/v1/demands")).status).toBe(403);
  });

  test("início: marca, projetos do próprio cliente, sem valores internos", async () => {
    const r = await paula.browser.get("/api/v1/portal/home");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.workspace.name).toBe("Agência Portal");
    expect(r.json.client.code).toBe("PAO");
    expect(r.json.projects.map((p: { id: string }) => p.id)).toEqual([projectId]);
    expect(r.json.projects[0]).toMatchObject({
      publicSummary: "Novo site da padaria com loja.",
      progress: { total: 1, done: 0 },
      nextMilestone: { title: "Entrega do layout" },
    });
    expect(JSON.stringify(r.json)).not.toContain("990000");
    const o = await outro.browser.get("/api/v1/portal/home");
    expect(o.json.projects.map((p: { id: string }) => p.id)).toEqual([otherProject]);
  });

  test("projeto: só tarefas, marcos e comentários visíveis; outro cliente recebe 404", async () => {
    const r = await paula.browser.get(`/api/v1/portal/projects/${projectId}`);
    expect(r.status).toBe(200);
    expect(r.json.tasks.map((t: { id: string }) => t.id)).toEqual([taskVisible]);
    expect(r.json.milestones.map((m: { title: string }) => m.title)).toEqual(["Entrega do layout"]);
    expect(r.json.comments.map((m: { body: string }) => m.body)).toEqual(["Olá, Paula!"]);
    expect((await outro.browser.get(`/api/v1/portal/projects/${projectId}`)).status).toBe(404);
    expect((await paula.browser.get(`/api/v1/portal/tasks/${taskHidden}`)).status).toBe(404);
    expect((await outro.browser.get(`/api/v1/portal/tasks/${taskVisible}`)).status).toBe(404);
  });

  test("cliente comenta no projeto e na tarefa; a equipe vê e é avisada", async () => {
    const c = await paula.browser.post(`/api/v1/portal/projects/${projectId}/comments`, { body: "Adorei!" });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const t = await paula.browser.post(`/api/v1/portal/tasks/${taskVisible}/comments`, {
      body: "Pode usar azul?",
    });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    const team = await admin.get(`/api/v1/projects/${projectId}/comments`);
    expect(JSON.stringify(team.json)).toContain("Adorei!");
    const n = await gestor.browser.get("/api/v1/notifications");
    expect(n.json.data.some((x: { type: string }) => x.type === "comentario_cliente")).toBe(true);
    expect(
      (await outro.browser.post(`/api/v1/portal/tasks/${taskVisible}/comments`, { body: "x" })).status,
    ).toBe(404);
  });

  test("aprovação: avisa o cliente, aprova e pede ajuste", async () => {
    const m = await admin.post(`/api/v1/tasks/${taskVisible}/move`, { statusKey: "aguardando_cliente" });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    const notes = await paula.browser.get("/api/v1/notifications");
    expect(notes.json.data.some((x: { type: string }) => x.type === "aprovacao_cliente")).toBe(true);
    const home = await paula.browser.get("/api/v1/portal/home");
    expect(home.json.awaiting.map((t: { id: string }) => t.id)).toEqual([taskVisible]);

    const detail = await paula.browser.get(`/api/v1/portal/tasks/${taskVisible}`);
    expect(detail.json.reasons.length).toBeGreaterThan(0);
    const ch = await paula.browser.post(`/api/v1/portal/tasks/${taskVisible}/request-changes`, {
      description: "Trocar a foto do topo",
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    const team = await admin.get(`/api/v1/tasks/${taskVisible}`);
    expect(team.json.statusKey).toBe("ajustes");
    expect((await paula.browser.post(`/api/v1/portal/tasks/${taskVisible}/approve`)).json.error.code).toBe(
      "NOT_AWAITING_CLIENT",
    );

    await admin.post(`/api/v1/tasks/${taskVisible}/move`, { statusKey: "aguardando_cliente" });
    const ap = await paula.browser.post(`/api/v1/portal/tasks/${taskVisible}/approve`);
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect(ap.json.statusKey).not.toBe("aguardando_cliente");
    expect((await admin.get(`/api/v1/tasks/${taskVisible}`)).json.statusKey).toBe(ap.json.statusKey);
    const log = await admin.get(`/api/v1/audit?entity=task`);
    expect(log.json.data.some((x: { action: string }) => x.action === "client_approved")).toBe(true);
  });

  test("cliente cria tarefa no projeto (conta na cota) e só apaga a própria", async () => {
    const before = await owner.query("select count(*)::int n from tasks where tenant_id = $1", [tenantId]);
    const r = await paula.browser.post(`/api/v1/portal/projects/${projectId}/tasks`, {
      title: "Banner de Natal",
      description: "Tamanho 1080x1080",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const t = await admin.get(`/api/v1/tasks/${r.json.id}`);
    expect(t.json).toMatchObject({ statusKey: "demandas", visibleToClient: true });
    const after = await owner.query("select count(*)::int n from tasks where tenant_id = $1", [tenantId]);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    expect(
      (await outro.browser.post(`/api/v1/portal/projects/${projectId}/tasks`, { title: "x" })).status,
    ).toBe(404);
    expect((await paula.browser.del(`/api/v1/portal/tasks/${taskVisible}`)).json.error.code).toBe(
      "NOT_YOUR_TASK",
    );
    expect((await paula.browser.del(`/api/v1/portal/tasks/${r.json.id}`)).status).toBe(204);
    expect((await admin.get(`/api/v1/tasks/${r.json.id}`)).status).toBe(404);
  });

  test("demanda com briefing: a equipe aceita (vira tarefa) ou recusa com motivo", async () => {
    const f = await admin.post("/api/v1/briefing-forms", {
      name: "Briefing de post",
      fields: [
        { label: "Objetivo", type: "paragrafo", required: true },
        { label: "Formato", type: "escolha_unica", options: ["Feed", "Story"] },
      ],
    });
    const forms = (await paula.browser.get("/api/v1/portal/demands")).json.forms;
    const form = forms.find((x: { id: string }) => x.id === f.json.id);
    expect(form.fields).toHaveLength(2);
    const [obj, fmt] = form.fields;
    const missing = await paula.browser.post("/api/v1/portal/demands", {
      title: "Post de inauguração",
      briefing: { formId: form.id, answers: { [fmt.id]: "Feed" } },
    });
    expect(missing.json.error.code).toBe("BRIEFING_REQUIRED");
    const d = await paula.browser.post("/api/v1/portal/demands", {
      title: "Post de inauguração",
      projectId,
      desiredDate: "2030-03-10",
      briefing: { formId: form.id, answers: { [obj.id]: "Divulgar a loja nova", [fmt.id]: "Feed" } },
    });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const d2 = await paula.browser.post("/api/v1/portal/demands", { title: "Cartão de visita" });
    expect((await outro.browser.get("/api/v1/portal/demands")).json.data).toHaveLength(0);

    const q = await gestor.browser.get("/api/v1/demands");
    expect(q.status).toBe(200);
    expect(q.json.pending).toBe(2);
    const item = q.json.data.find((x: { id: string }) => x.id === d.json.id);
    expect(item.briefing.answers).toEqual([
      { label: "Objetivo", value: "Divulgar a loja nova" },
      { label: "Formato", value: "Feed" },
    ]);
    const acc = await gestor.browser.post(`/api/v1/demands/${d.json.id}/accept`, {});
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    const task = await admin.get(`/api/v1/tasks/${acc.json.taskId}`);
    expect(task.json).toMatchObject({
      statusKey: "demandas",
      visibleToClient: true,
      clientDeliveryDate: "2030-03-10",
    });
    expect(JSON.stringify(task.json.description)).toContain("Objetivo: Divulgar a loja nova");
    expect((await gestor.browser.post(`/api/v1/demands/${d.json.id}/accept`, {})).status).toBe(409);
    const rej = await gestor.browser.post(`/api/v1/demands/${d2.json.id}/reject`, {
      reason: "Fora do escopo",
    });
    expect(rej.status).toBe(204);
    const mine = (await paula.browser.get("/api/v1/portal/demands")).json.data;
    expect(mine.find((x: { id: string }) => x.id === d2.json.id)).toMatchObject({
      status: "rejected",
      rejectionReason: "Fora do escopo",
    });
    expect(mine.find((x: { id: string }) => x.id === d.json.id).taskId).toBe(acc.json.taskId);
    const n = await paula.browser.get("/api/v1/notifications");
    expect(n.json.data.filter((x: { type: string }) => x.type === "demanda_respondida")).toHaveLength(2);
  });

  test("documentos: o cliente assina pelo portal; outro cliente não vê", async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText("Contrato");
    const bytes = await doc.save();
    const up = await admin.post("/api/v1/files/uploads", {
      name: "contrato.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
    });
    objects.set(new URL(up.json.uploadUrl).pathname.slice(1), bytes);
    await admin.post(`/api/v1/files/${up.json.fileId}/complete`);
    const req = await admin.post("/api/v1/signatures", {
      projectId,
      title: "Contrato do site",
      documentFileId: up.json.fileId,
      signers: [{ name: "Paula", email: paula.email }],
    });
    expect(req.status, JSON.stringify(req.json)).toBe(201);
    expect((await admin.post(`/api/v1/signatures/${req.json.id}/send`)).status).toBe(200);

    const list = await paula.browser.get("/api/v1/portal/documents");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.data).toHaveLength(1);
    const mineDoc = list.json.data[0];
    expect(mineDoc).toMatchObject({ title: "Contrato do site", myStatus: "pendente", status: "enviado" });
    expect((await outro.browser.get("/api/v1/portal/documents")).json.data).toHaveLength(0);
    expect(
      (
        await outro.browser.post(`/api/v1/portal/documents/${mineDoc.id}/sign`, {
          typedName: "Paula",
          agree: true,
        })
      ).status,
    ).toBe(404);
    const bad = await paula.browser.post(`/api/v1/portal/documents/${mineDoc.id}/sign`, {
      typedName: "Outra",
      agree: true,
    });
    expect(bad.json.error.code).toBe("NAME_MISMATCH");
    const ok = await paula.browser.post(`/api/v1/portal/documents/${mineDoc.id}/sign`, {
      typedName: "paula",
      agree: true,
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(204);
    const after = (await paula.browser.get("/api/v1/portal/documents")).json.data[0];
    expect(after).toMatchObject({ myStatus: "assinou", status: "assinado", hasSignedCopy: true });
    const dl = await paula.browser.raw(`/api/v1/portal/documents/${mineDoc.id}/download`);
    expect(dl.status).toBe(302);
    expect(dl.headers.get("location")).toContain("bucket.test");
  });

  test("plano sem portal: 402", async () => {
    await setPlan("basico");
    expect((await paula.browser.get("/api/v1/portal/home")).status).toBe(402);
    await setPlan("profissional");
  });
});
