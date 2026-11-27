/**
 * Fase 4 — projetos, tarefas e o fluxo do Kanban pela API (Postgres real, RLS ligado).
 */
import { runRecurrence } from "@recpm/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Storage } from "../src/lib/storage";
import { addMember, Browser, createWorkspace, setupApp, signUp } from "./helpers";

const objects = new Map<string, number>();
const fakeStorage: Storage = {
  presignUpload: async (key) => ({ url: `https://bucket.test/${key}?sig=1`, headers: {} }),
  presignDownload: async (key) => `https://bucket.test/${key}?download=1`,
  head: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)! } : null),
};

const { app, mailer, urls, dbs } = setupApp({ storage: fakeStorage });
const owner = new Pool({ connectionString: urls.owner });
afterAll(() => owner.end());

const admin = new Browser(app);
const stranger = new Browser(app);
let tenantId: string;
let gestor: Browser;
let fabi: { browser: Browser; userId: string };
let caio: { browser: Browser; userId: string };
let adminId: string;
let clientId: string;
let typeId: string;
let reasonId: string;
let projectId: string;
let secretProjectId: string;

const used = async (tid: string) =>
  Number(
    (
      await owner.query(
        "select tasks_created from usage_counters where tenant_id = $1 order by period_start desc limit 1",
        [tid],
      )
    ).rows[0]?.tasks_created ?? 0,
  );

beforeAll(async () => {
  adminId = (await signUp(admin, "Ana")).userId;
  tenantId = (await createWorkspace(admin, "Agência Trabalho")).id;
  await signUp(stranger, "Estranho");
  await createWorkspace(stranger, "Outra");
  gestor = (await addMember(app, admin, mailer, tenantId, "Gil", "gestor")).browser;
  fabi = await addMember(app, admin, mailer, tenantId, "Fabi", "funcionario");
  caio = await addMember(app, admin, mailer, tenantId, "Caio", "funcionario");

  clientId = (await admin.post("/api/v1/clients", { code: "CAFE", name: "Café Aroma" })).json.id;
  const type = await admin.post("/api/v1/catalogs/task-types", {
    label: "Reels",
    defaultEstimatedHours: 2,
    checklist: ["Roteiro", "Edição", "Legenda"],
  });
  expect(type.status, JSON.stringify(type.json)).toBe(201);
  typeId = type.json.id;
  reasonId = (await admin.get("/api/v1/catalogs/adjustment-reasons")).json.data[0].id;
});

describe("projetos", () => {
  test("cria projeto com membros e itens de contrato; funcionário só vê os seus", async () => {
    const p = await admin.post("/api/v1/projects", {
      name: "Café | Mensal | Dez26",
      clientId,
      modality: "mensal",
      periodicity: "mensal",
      startDate: "2026-12-01",
      deliveryDeadline: "2026-12-31",
      managerId: adminId,
      members: [{ userId: fabi.userId }],
      contractItems: [{ taskTypeId: typeId, quantityPerPeriod: 11, formats: ["Vertical"] }],
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    projectId = p.json.id;
    expect(p.json.client).toMatchObject({ code: "CAFE" });
    expect(p.json.members.map((m: { id: string }) => m.id).sort()).toEqual([adminId, fabi.userId].sort());
    expect(p.json.contractItems[0]).toMatchObject({
      taskTypeLabel: "Reels",
      quantityPerPeriod: 11,
      delivered: 0,
    });
    expect(p.json.milestones.map((m: { kind: string }) => m.kind)).toEqual(["start", "final_delivery"]);

    secretProjectId = (await admin.post("/api/v1/projects", { name: "Interno", internal: true })).json.id;

    const mine = await fabi.browser.get("/api/v1/projects");
    expect(mine.json.data.map((x: { id: string }) => x.id)).toEqual([projectId]);
    expect((await fabi.browser.get(`/api/v1/projects/${secretProjectId}`)).status).toBe(404);
    expect((await gestor.get("/api/v1/projects")).json.total).toBe(2);
    expect((await fabi.browser.post("/api/v1/projects", { name: "X", internal: true })).status).toBe(403);
    expect((await stranger.get(`/api/v1/projects/${projectId}`)).status).toBe(404);
  });

  test("cliente é obrigatório em projeto não interno", async () => {
    const r = await admin.post("/api/v1/projects", { name: "Sem cliente" });
    expect(r.json.error.code).toBe("CLIENT_REQUIRED");
  });

  test("fases, marcos, comentários e colunas do projeto", async () => {
    const ph = await admin.post(`/api/v1/projects/${projectId}/phases`, { name: "Captação" });
    expect(ph.status).toBe(201);
    const ms = await admin.post(`/api/v1/projects/${projectId}/milestones`, {
      title: "Aprovação do roteiro",
      date: "2026-12-10",
    });
    expect(ms.status).toBe(201);
    const cm = await fabi.browser.post(`/api/v1/projects/${projectId}/comments`, {
      body: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Cliente pediu mais cor" }] }],
      },
      visibleToClient: true,
    });
    expect(cm.status).toBe(201);
    const list = await admin.get(`/api/v1/projects/${projectId}/comments`);
    expect(list.json.data[0]).toMatchObject({
      bodyText: "Cliente pediu mais cor",
      visibleToClient: true,
      mine: false,
    });
    // outro funcionário (não membro) não comenta
    expect(
      (
        await caio.browser.post(`/api/v1/projects/${projectId}/comments`, {
          body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "oi" }] }] },
        })
      ).status,
    ).toBe(404);
    // funcionário não mexe na estrutura
    expect((await fabi.browser.post(`/api/v1/projects/${projectId}/phases`, { name: "X" })).status).toBe(403);

    const cols = await admin.put(`/api/v1/projects/${projectId}/columns`, {
      columns: [
        { key: "veicular", visible: false },
        { key: "a_fazer", visible: true, labelOverride: "Backlog" },
      ],
    });
    expect(cols.status, JSON.stringify(cols.json)).toBe(200);
    expect(cols.json.data[0]).toMatchObject({ key: "veicular", visible: false });
    expect(cols.json.data[1]).toMatchObject({ key: "a_fazer", label: "Backlog" });

    const detail = await admin.get(`/api/v1/projects/${projectId}`);
    expect(detail.json.phases[0]).toMatchObject({ name: "Captação", total: 0 });
    expect(detail.json.milestones.find((m: { kind: string }) => m.kind === "custom").title).toBe(
      "Aprovação do roteiro",
    );
  });
});

describe("tarefas e fluxo do Kanban", () => {
  let taskId: string;

  test("criar consome cota e traz o checklist do tipo", async () => {
    const before = await used(tenantId);
    const t = await admin.post("/api/v1/tasks", {
      title: "Reels de lançamento",
      projectId,
      taskTypeId: typeId,
      assigneeId: fabi.userId,
      approverId: adminId,
      deadline: "2026-12-05T18:00:00-03:00",
      deadlineHasTime: true,
    });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    taskId = t.json.id;
    expect(t.json.statusKey).toBe("a_fazer");
    expect(t.json.items.map((i: { text: string }) => i.text)).toEqual(["Roteiro", "Edição", "Legenda"]);
    expect(t.json.estimatedHours).toBe(2);
    expect(t.json.assignees.map((a: { id: string }) => a.id)).toEqual([fabi.userId]);
    expect(await used(tenantId)).toBe(before + 1);
    const n = await owner.query("select type from notifications where user_id = $1", [fabi.userId]);
    expect(n.rows.map((r) => r.type)).toContain("tarefa_atribuida");
  });

  test("quem não participa não altera; quem participa move", async () => {
    // Caio não é do projeto: nem vê
    expect((await caio.browser.get(`/api/v1/tasks/${taskId}`)).status).toBe(404);
    const mv = await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "em_andamento" });
    expect(mv.status, JSON.stringify(mv.json)).toBe(200);
    expect(mv.json).toEqual({ from: "a_fazer", to: "em_andamento" });
  });

  test("ajustes exigem motivo; sair de ajustes resolve", async () => {
    const no = await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "ajustes" });
    expect(no.json.error.code).toBe("ADJUSTMENT_REASON_REQUIRED");
    const yes = await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, {
      statusKey: "ajustes",
      adjustment: { reasonId, kind: "internal", description: "Cor errada" },
    });
    expect(yes.status).toBe(200);
    let d = (await admin.get(`/api/v1/tasks/${taskId}`)).json;
    expect(d.openAdjustments).toBe(1);
    await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "em_andamento" });
    d = (await admin.get(`/api/v1/tasks/${taskId}`)).json;
    expect(d.openAdjustments).toBe(0);
    expect(d.adjustments[0]).toMatchObject({ kind: "internal", description: "Cor errada" });
    expect(d.adjustments[0].resolvedAt).not.toBeNull();
  });

  test("aprovação: avisa o aprovador; só ele tira da coluna; aprovar vai para a próxima", async () => {
    await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "aguardando_aprovacao" });
    const n = await owner.query(
      "select type from notifications where user_id = $1 and type = 'tarefa_aprovacao_pendente'",
      [adminId],
    );
    expect(n.rowCount).toBe(1);
    const blocked = await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "concluido" });
    expect(blocked.json.error.code).toBe("APPROVAL_REQUIRED");
    expect((await fabi.browser.post(`/api/v1/tasks/${taskId}/approve`)).json.error.code).toBe(
      "APPROVAL_REQUIRED",
    );
    const ok = await admin.post(`/api/v1/tasks/${taskId}/approve`);
    expect(ok.json).toEqual({ from: "aguardando_aprovacao", to: "enviar_cliente" });
  });

  test("reprovar volta para ajustes; vindo do cliente o ajuste é do cliente", async () => {
    await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "aguardando_cliente" });
    expect((await fabi.browser.post(`/api/v1/tasks/${taskId}/chase`)).status).toBe(204);
    await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, {
      statusKey: "ajustes",
      adjustment: { reasonId, kind: "internal" },
    });
    const d = (await admin.get(`/api/v1/tasks/${taskId}`)).json;
    expect(d.adjustments[0].kind).toBe("client");
    expect(d.lastClientChaseAt).not.toBeNull();

    await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "aguardando_aprovacao" });
    const rj = await admin.post(`/api/v1/tasks/${taskId}/reject`, { reasonId, kind: "internal" });
    expect(rj.json).toEqual({ from: "aguardando_aprovacao", to: "ajustes" });
  });

  test("coluna final marca concluída; sair limpa; histórico registra tudo", async () => {
    await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "em_andamento" });
    await fabi.browser.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "concluido" });
    let d = (await admin.get(`/api/v1/tasks/${taskId}`)).json;
    expect(d.completedAt).not.toBeNull();
    await gestor.post(`/api/v1/tasks/${taskId}/move`, { statusKey: "veicular" });
    d = (await admin.get(`/api/v1/tasks/${taskId}`)).json;
    expect(d.completedAt).toBeNull();
    const h = (await fabi.browser.get(`/api/v1/tasks/${taskId}/history`)).json.data;
    expect(h.filter((e: { action: string }) => e.action === "status_change").length).toBeGreaterThanOrEqual(
      10,
    );
    expect(h.some((e: { action: string }) => e.action === "client_chase")).toBe(true);
    expect(h.at(-1).action).toBe("create");
  });

  test("ordem dentro da coluna (rank) respeita os vizinhos", async () => {
    const mk = async (title: string) =>
      (await admin.post("/api/v1/tasks", { title, projectId })).json.id as string;
    const a = await mk("A");
    const b = await mk("B");
    const c = await mk("C");
    // C entre A e B
    await admin.post(`/api/v1/tasks/${c}/move`, { statusKey: "a_fazer", afterId: a, beforeId: b });
    const board = (await admin.get(`/api/v1/tasks?projectId=${projectId}&status=a_fazer&sort=board`)).json
      .data;
    expect(board.map((t: { title: string }) => t.title)).toEqual(["A", "C", "B"]);
  });

  test("checklist, feedback e edição", async () => {
    const d = (await fabi.browser.get(`/api/v1/tasks/${taskId}`)).json;
    const item = d.items[0];
    expect(
      (await fabi.browser.patch(`/api/v1/tasks/${taskId}/checklist/${item.id}`, { done: true })).status,
    ).toBe(204);
    const fb = await admin.post(`/api/v1/tasks/${taskId}/feedback`, {
      body: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Ficou ótimo" }] }],
      },
    });
    expect(fb.status).toBe(201);
    const up = await fabi.browser.patch(`/api/v1/tasks/${taskId}`, {
      title: "Reels de lançamento v2",
      priority: "alta",
      deadline: "2026-12-06T18:00:00-03:00",
    });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(up.json).toMatchObject({
      title: "Reels de lançamento v2",
      priority: "alta",
      checklist: { total: 3, done: 1 },
    });
    expect(up.json.originalDeadline).toBe(new Date("2026-12-05T21:00:00Z").toISOString());
    // Caio (sem vínculo) não edita a tarefa mesmo sendo membro depois
    await admin.patch(`/api/v1/projects/${projectId}`, {
      members: [{ userId: fabi.userId }, { userId: caio.userId }],
    });
    const no = await caio.browser.patch(`/api/v1/tasks/${taskId}`, { title: "hack" });
    expect(no.status).toBe(403);
  });

  test("filtros da lista: escopo, atrasadas, busca", async () => {
    const mine = (await fabi.browser.get("/api/v1/tasks?scope=mine")).json;
    expect(mine.data.map((t: { id: string }) => t.id)).toEqual([taskId]);
    const q = (await admin.get("/api/v1/tasks?q=lan%C3%A7amento")).json;
    expect(q.total).toBe(1);
    const overdue = (await admin.get("/api/v1/tasks?overdue=true")).json;
    expect(overdue.total).toBe(0);
    const none = (await admin.get("/api/v1/tasks?overdue=false")).json;
    expect(none.total).toBeGreaterThan(1);
  });

  test("arquivamento: funcionário pede, gestor aprova", async () => {
    expect((await fabi.browser.post(`/api/v1/tasks/${taskId}/archive`, { archived: true })).status).toBe(403);
    const rq = await fabi.browser.post(`/api/v1/tasks/${taskId}/archive-request`, {
      reason: "Cliente cancelou",
    });
    expect(rq.status).toBe(204);
    expect((await gestor.get("/api/v1/tasks/summary")).json.archiveRequests).toBe(1);
    const pending = (await gestor.get("/api/v1/tasks?archiveRequested=true")).json.data;
    expect(pending.map((t: { id: string }) => t.id)).toEqual([taskId]);
    expect((await gestor.post(`/api/v1/tasks/${taskId}/archive-decision`, { approve: true })).status).toBe(
      204,
    );
    expect(
      (await admin.get("/api/v1/tasks?archived=true")).json.data.map((t: { id: string }) => t.id),
    ).toContain(taskId);
    const n = await owner.query(
      "select type from notifications where user_id = $1 and type = 'tarefa_arquivada'",
      [fabi.userId],
    );
    expect(n.rowCount).toBe(1);
    await gestor.post(`/api/v1/tasks/${taskId}/archive`, { archived: false });
  });

  test("ações em massa", async () => {
    const ids = (await admin.get(`/api/v1/tasks?projectId=${projectId}&status=a_fazer`)).json.data.map(
      (t: { id: string }) => t.id,
    );
    const r = await admin.post("/api/v1/tasks/bulk", { ids, action: "priority", priority: "baixa" });
    expect(r.json).toEqual({ updated: ids.length, failed: [] });
    const mv = await admin.post("/api/v1/tasks/bulk", { ids, action: "move", statusKey: "em_andamento" });
    expect(mv.json.updated).toBe(ids.length);
    const aj = await admin.post("/api/v1/tasks/bulk", { ids, action: "move", statusKey: "ajustes" });
    expect(aj.json.error.code).toBe("ADJUSTMENT_REASON_REQUIRED");
  });

  test("duplicar projeto com tarefas desloca as datas", async () => {
    const before = await used(tenantId);
    const r = await admin.post(`/api/v1/projects/${projectId}/duplicate`, {
      name: "Café | Mensal | Jan27",
      includeTasks: true,
      shiftDays: 31,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const n = (await admin.get(`/api/v1/tasks?projectId=${projectId}`)).json.total;
    expect(r.json.tasksCopied).toBe(n);
    expect(await used(tenantId)).toBe(before + n);
    const copy = (await admin.get(`/api/v1/projects/${r.json.id}`)).json;
    expect(copy).toMatchObject({
      startDate: "2027-01-01",
      deliveryDeadline: "2027-01-31",
      duplicatedFromId: projectId,
    });
    expect(copy.phases[0].name).toBe("Captação");
    const t = (await admin.get(`/api/v1/tasks?projectId=${r.json.id}&q=v2`)).json.data[0];
    expect(t.deadline).toBe(new Date("2027-01-06T21:00:00Z").toISOString());
    expect(t.statusKey).toBe("a_fazer");
  });
});

describe("cota do plano (402)", () => {
  test("criar, duplicar e recorrência param no limite", async () => {
    const b = new Browser(app);
    await signUp(b, "Limite");
    const tid = (await createWorkspace(b, "Agência Limite")).id;
    await owner.query(
      "update tenant_subscriptions set plan_id = (select id from plans where slug = 'basico'), status = 'active', trial_ends_at = null where tenant_id = $1",
      [tid],
    );
    const t = await b.post("/api/v1/tasks", {
      title: "Post diário",
      recurrence: "diaria",
      recurrenceRule: { interval: 1, at: "08:00" },
    });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    expect(t.json.nextGenerationAt).not.toBeNull();
    await owner.query("update usage_counters set tasks_created = 50 where tenant_id = $1", [tid]);

    const create = await b.post("/api/v1/tasks", { title: "Mais uma" });
    expect(create.status).toBe(402);
    expect(create.json.error.code).toBe("PLAN_TASK_LIMIT_REACHED");
    expect((await b.post(`/api/v1/tasks/${t.json.id}/duplicate`)).status).toBe(402);
    const p = (await b.post("/api/v1/projects", { name: "Interno", internal: true })).json.id;
    await owner.query("update tasks set project_id = $1 where id = $2", [p, t.json.id]);
    const dup = await b.post(`/api/v1/projects/${p}/duplicate`, { name: "Cópia", includeTasks: true });
    expect(dup.status).toBe(402);
    expect((await b.get("/api/v1/projects")).json.total).toBe(1); // a cópia foi desfeita

    // Recorrência vencida: sem cota, não gera e a série não avança
    await owner.query("update tasks set next_generation_at = now() - interval '1 minute' where id = $1", [
      t.json.id,
    ]);
    const blocked = await runRecurrence({ platformDb: dbs.platformDb, appDb: dbs.appDb });
    expect(blocked.blocked).toBeGreaterThanOrEqual(1);
    const still = await owner.query("select next_generation_at < now() as due from tasks where id = $1", [
      t.json.id,
    ]);
    expect(still.rows[0].due).toBe(true);

    // Com cota: gera a instância (filha da série) e agenda a próxima
    await owner.query("update usage_counters set tasks_created = 10 where tenant_id = $1", [tid]);
    const okRun = await runRecurrence({ platformDb: dbs.platformDb, appDb: dbs.appDb });
    expect(okRun.created).toBeGreaterThanOrEqual(1);
    const kids = await owner.query("select source from tasks where recurrence_parent_id = $1", [t.json.id]);
    expect(kids.rows).toEqual([{ source: "recurrence" }]);
    const next = await owner.query("select next_generation_at > now() as future from tasks where id = $1", [
      t.json.id,
    ]);
    expect(next.rows[0].future).toBe(true);
    expect(await used(tid)).toBe(11);
  });
});

describe("arquivos", () => {
  test("upload pré-assinado, confirmação, anexo e download", async () => {
    const up = await fabi.browser.post("/api/v1/files/uploads", {
      name: "roteiro.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
    });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const key = new URL(up.json.uploadUrl).pathname.slice(1);
    expect(key.startsWith(`t/${tenantId}/`)).toBe(true);
    expect((await fabi.browser.post(`/api/v1/files/${up.json.fileId}/complete`)).json.error.code).toBe(
      "UPLOAD_NOT_FOUND",
    );
    objects.set(key, 1200);
    const done = await fabi.browser.post(`/api/v1/files/${up.json.fileId}/complete`);
    expect(done.json).toMatchObject({ scanStatus: "clean", sizeBytes: 1200 });
    const att = await fabi.browser.post(`/api/v1/projects/${projectId}/attachments`, {
      fileId: up.json.fileId,
    });
    expect(att.status).toBe(201);
    const link = await fabi.browser.post(`/api/v1/projects/${projectId}/attachments`, {
      url: "https://drive.example/x",
      name: "Drive",
    });
    expect(link.status).toBe(201);
    const files = (await admin.get(`/api/v1/projects/${projectId}/files`)).json.attachments;
    expect(files.map((f: { name: string }) => f.name).sort()).toEqual(["Drive", "roteiro.pdf"]);
    const dl = await app.request(`http://localhost:3000/api/v1/files/${up.json.fileId}/download`, {
      headers: { cookie: cookieOf(fabi.browser) },
    });
    expect(dl.status).toBe(302);
    expect(dl.headers.get("location")).toContain("download=1");
    expect((await stranger.get(`/api/v1/files/${up.json.fileId}/download`)).status).toBe(404);
    expect(
      (
        await fabi.browser.post("/api/v1/files/uploads", {
          name: "x.exe",
          mimeType: "application/x-msdownload",
          sizeBytes: 1,
        })
      ).json.error.code,
    ).toBe("FILE_TYPE_BLOCKED");
  });
});

function cookieOf(b: Browser) {
  return [...(b as unknown as { jar: Map<string, string> }).jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
