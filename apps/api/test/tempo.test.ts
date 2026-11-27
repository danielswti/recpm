/**
 * Fase 5 — "Estou nessa", horas úteis, entregas, ajustes de tempo, Trabalhando agora,
 * SLA de cobrança e Configurações (Postgres real, RLS ligado).
 */
import { runClientChaseSla } from "@recpm/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addMember, Browser, createWorkspace, setupApp, signUp, WEB } from "./helpers";

const { app, mailer, urls, dbs } = setupApp();
const owner = new Pool({ connectionString: urls.owner });
afterAll(() => owner.end());

const H = 3_600_000;
const ALL_DAY = {
  days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ start: "00:00", end: "23:59" }]])),
};

const admin = new Browser(app);
const stranger = new Browser(app);
let tenantId: string;
let gestor: { browser: Browser; userId: string };
let fabi: { browser: Browser; userId: string };
let caio: { browser: Browser; userId: string };
let projectId: string;
let taskA: string;
let taskB: string;

const newTask = async (title: string, extra: Record<string, unknown> = {}) => {
  const r = await admin.post("/api/v1/tasks", { title, projectId, assigneeId: fabi.userId, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
};
const openEntries = async (userId: string) =>
  (await owner.query("select * from time_entries where user_id = $1 and ended_at is null", [userId])).rows;

beforeAll(async () => {
  await signUp(admin, "Ana");
  tenantId = (await createWorkspace(admin, "Agência Tempo")).id;
  await signUp(stranger, "Estranho");
  await createWorkspace(stranger, "Outra");
  gestor = await addMember(app, admin, mailer, tenantId, "Gil", "gestor");
  fabi = await addMember(app, admin, mailer, tenantId, "Fabi", "funcionario");
  caio = await addMember(app, admin, mailer, tenantId, "Caio", "funcionario");
  // expediente o dia todo: o teste não depende da hora em que roda
  await owner.query("update memberships set business_hours = $1 where tenant_id = $2", [ALL_DAY, tenantId]);
  const clientId = (await admin.post("/api/v1/clients", { code: "CAFE", name: "Café" })).json.id;
  projectId = (
    await admin.post("/api/v1/projects", {
      name: "Café | Mensal",
      clientId,
      managerId: gestor.userId,
      members: [{ userId: fabi.userId }],
    })
  ).json.id;
  taskA = await newTask("Reels 1", { pieceQuantity: 3 });
  taskB = await newTask("Reels 2");
});

describe("Estou nessa", () => {
  test("uma tarefa ativa por pessoa: iniciar outra fecha a anterior", async () => {
    const a = await fabi.browser.post("/api/v1/time/start", { taskId: taskA });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.task).toMatchObject({ id: taskA, title: "Reels 1", project: { clientCode: "CAFE" } });
    // de novo na mesma: idempotente
    expect((await fabi.browser.post("/api/v1/time/start", { taskId: taskA })).json.id).toBe(a.json.id);

    const b = await fabi.browser.post("/api/v1/time/start", { taskId: taskB });
    expect(b.json.task.id).toBe(taskB);
    const open = await openEntries(fabi.userId);
    expect(open).toHaveLength(1);
    expect(open[0].task_id).toBe(taskB);
    const closed = (await owner.query("select * from time_entries where id = $1", [a.json.id])).rows[0];
    expect(closed.ended_at).not.toBeNull();
    expect(Number(closed.business_ms)).toBeGreaterThanOrEqual(0);

    expect((await fabi.browser.get("/api/v1/time/current")).json.task.id).toBe(taskB);
  });

  test("conta horas úteis e mostra o tempo por pessoa", async () => {
    // a entrada aberta começou "há 2 horas"
    await owner.query(
      "update time_entries set started_at = now() - interval '2 hours' where user_id = $1 and ended_at is null",
      [fabi.userId],
    );
    const t = await fabi.browser.get(`/api/v1/tasks/${taskB}/time`);
    expect(t.status).toBe(200);
    expect(t.json.running).toBe(true);
    expect(t.json.totalMs).toBeGreaterThan(1.9 * H);
    expect(t.json.totalMs).toBeLessThan(2.1 * H);
    expect(t.json.people[0].user.id).toBe(fabi.userId);

    // fora do expediente não conta: só segunda 09–10 na agenda da Fabi
    await owner.query("update memberships set business_hours = $1 where user_id = $2 and tenant_id = $3", [
      { days: { 1: [{ start: "09:00", end: "10:00" }] } },
      fabi.userId,
      tenantId,
    ]);
    await owner.query(
      // de sábado 2026-12-05 08:00 a terça 2026-12-08 12:00 em SP → 1 hora útil (segunda 09–10)
      "insert into time_entries (id, tenant_id, user_id, task_id, started_at, ended_at, status_at_start) values (gen_random_uuid(), $1, $2, $3, '2026-12-05T08:00:00-03:00', '2026-12-08T12:00:00-03:00', 'a_fazer')",
      [tenantId, fabi.userId, taskA],
    );
    const ta = await fabi.browser.get(`/api/v1/tasks/${taskA}/time`);
    const old = ta.json.entries.find((e: { startedAt: string }) => e.startedAt.startsWith("2026-12-05"));
    expect(old.businessMs).toBe(H);
    await owner.query("update memberships set business_hours = $1 where user_id = $2 and tenant_id = $3", [
      ALL_DAY,
      fabi.userId,
      tenantId,
    ]);
  });

  test("quem não vê a tarefa não inicia timer nela", async () => {
    expect((await caio.browser.post("/api/v1/time/start", { taskId: taskA })).status).toBe(404);
    expect((await stranger.post("/api/v1/time/start", { taskId: taskA })).status).toBe(404);
  });

  test("concluir a tarefa para o timer; tarefa concluída não aceita timer", async () => {
    const mv = await fabi.browser.post(`/api/v1/tasks/${taskB}/move`, { statusKey: "concluido" });
    expect(mv.status, JSON.stringify(mv.json)).toBe(200);
    expect(await openEntries(fabi.userId)).toHaveLength(0);
    const r = await fabi.browser.post("/api/v1/time/start", { taskId: taskB });
    expect(r.json.error.code).toBe("TASK_COMPLETED");
  });

  test("arquivar a tarefa para o timer", async () => {
    const t = await newTask("Arte avulsa");
    await fabi.browser.post("/api/v1/time/start", { taskId: t });
    expect(await openEntries(fabi.userId)).toHaveLength(1);
    expect((await admin.post(`/api/v1/tasks/${t}/archive`, { archived: true })).status).toBe(204);
    expect(await openEntries(fabi.userId)).toHaveLength(0);
  });

  test("parar o timer", async () => {
    await fabi.browser.post("/api/v1/time/start", { taskId: taskA });
    expect((await fabi.browser.post("/api/v1/time/stop")).status).toBe(204);
    expect((await fabi.browser.get("/api/v1/time/current")).json).toBeNull();
  });
});

describe("ajustes de tempo", () => {
  test("acréscimo só conta depois de aprovado; quem pede não aprova", async () => {
    const before = (await fabi.browser.get(`/api/v1/tasks/${taskA}/time`)).json.totalMs;
    const req = await fabi.browser.post("/api/v1/time/adjustments", {
      taskId: taskA,
      deltaMinutes: 30,
      reason: "Esqueci de ligar o timer na reunião",
    });
    expect(req.status, JSON.stringify(req.json)).toBe(201);
    expect(req.json.status).toBe("pending");
    expect((await fabi.browser.get(`/api/v1/tasks/${taskA}/time`)).json.totalMs).toBe(before);

    // fila: gestor vê; funcionário vê só os seus e não decide
    const queue = await gestor.browser.get("/api/v1/time/adjustments");
    expect(queue.json.data.map((x: { id: string }) => x.id)).toContain(req.json.id);
    expect((await caio.browser.get("/api/v1/time/adjustments")).json.data).toHaveLength(0);
    expect(
      (await fabi.browser.post(`/api/v1/time/adjustments/${req.json.id}/review`, { approve: true })).status,
    ).toBe(403);
    const n = await owner.query(
      "select * from notifications where user_id = $1 and type = 'ajuste_tempo_pendente'",
      [gestor.userId],
    );
    expect(n.rows).toHaveLength(1);

    const ok = await gestor.browser.post(`/api/v1/time/adjustments/${req.json.id}/review`, {
      approve: true,
      note: "Ok",
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ status: "approved", reviewer: { id: gestor.userId } });
    expect((await fabi.browser.get(`/api/v1/tasks/${taskA}/time`)).json.totalMs).toBe(before + 30 * 60_000);
    expect(
      (await gestor.browser.post(`/api/v1/time/adjustments/${req.json.id}/review`, { approve: false })).json
        .error.code,
    ).toBe("ALREADY_REVIEWED");
  });

  test("corrigir o intervalo de um registro (aplicado na aprovação)", async () => {
    const e = (
      await owner.query(
        "select id from time_entries where user_id = $1 and ended_at is not null and task_id = $2 order by started_at desc limit 1",
        [fabi.userId, taskA],
      )
    ).rows[0];
    const req = await fabi.browser.post("/api/v1/time/adjustments", {
      timeEntryId: e.id,
      startedAt: "2026-11-02T10:00:00-03:00",
      endedAt: "2026-11-02T13:00:00-03:00",
      reason: "Horário correto da gravação",
    });
    expect(req.status, JSON.stringify(req.json)).toBe(201);
    expect(req.json.newBusinessMs).toBe(3 * H);
    // gestor recusa: o registro não muda
    await gestor.browser.post(`/api/v1/time/adjustments/${req.json.id}/review`, {
      approve: false,
      note: "Não",
    });
    const row = (await owner.query("select * from time_entries where id = $1", [e.id])).rows[0];
    expect(row.started_at.toISOString()).not.toBe("2026-11-02T13:00:00.000Z");

    const again = await fabi.browser.post("/api/v1/time/adjustments", {
      timeEntryId: e.id,
      startedAt: "2026-11-02T10:00:00-03:00",
      endedAt: "2026-11-02T13:00:00-03:00",
      reason: "Horário correto da gravação",
    });
    await gestor.browser.post(`/api/v1/time/adjustments/${again.json.id}/review`, { approve: true });
    const fixed = (await owner.query("select * from time_entries where id = $1", [e.id])).rows[0];
    expect(fixed.started_at.toISOString()).toBe("2026-11-02T13:00:00.000Z");
    expect(Number(fixed.business_ms)).toBe(3 * H);
  });

  test("só o dono pede ajuste do próprio registro", async () => {
    const e = (await owner.query("select id from time_entries where user_id = $1 limit 1", [fabi.userId]))
      .rows[0];
    const r = await caio.browser.post("/api/v1/time/adjustments", {
      timeEntryId: e.id,
      startedAt: "2026-11-02T10:00:00-03:00",
      endedAt: "2026-11-02T11:00:00-03:00",
      reason: "tentativa",
    });
    expect(r.status).toBe(404);
  });
});

describe("entregas", () => {
  test("registra peças; só quem registrou ou gestor desfaz", async () => {
    const d = await fabi.browser.post(`/api/v1/tasks/${taskA}/deliveries`, { quantity: 2, note: "2 de 3" });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const list = await fabi.browser.get(`/api/v1/tasks/${taskA}/deliveries`);
    expect(list.json.total).toBe(2);
    expect(list.json.data[0]).toMatchObject({ quantity: 2, canDelete: true, user: { id: fabi.userId } });
    expect((await caio.browser.post(`/api/v1/tasks/${taskA}/deliveries`, { quantity: 1 })).status).toBe(404);
    expect((await fabi.browser.post(`/api/v1/tasks/${taskA}/deliveries`, { quantity: 0 })).status).toBe(400);
    expect((await admin.del(`/api/v1/tasks/${taskA}/deliveries/${d.json.id}`)).status).toBe(204);
    expect((await fabi.browser.get(`/api/v1/tasks/${taskA}/deliveries`)).json.total).toBe(0);
  });
});

describe("Trabalhando agora", () => {
  test("admin vê quem está trabalhando; funcionário não acessa", async () => {
    await fabi.browser.post("/api/v1/time/start", { taskId: taskA });
    const w = await admin.get("/api/v1/time/working-now");
    expect(w.status).toBe(200);
    expect(w.json.working).toHaveLength(1);
    expect(w.json.working[0]).toMatchObject({
      user: { id: fabi.userId },
      task: { id: taskA },
      role: "funcionario",
    });
    expect(w.json.idle.map((x: { user: { id: string } }) => x.user.id)).toContain(caio.userId);
    expect((await fabi.browser.get("/api/v1/time/working-now")).status).toBe(403);
    expect((await stranger.get("/api/v1/time/working-now")).json.working).toHaveLength(0);
  });

  test("histórico por pessoa: gestor vê o de outros; funcionário só o próprio", async () => {
    const h = await gestor.browser.get(`/api/v1/time/entries?userId=${fabi.userId}`);
    expect(h.status).toBe(200);
    expect(h.json.data.length).toBeGreaterThan(2);
    expect((await caio.browser.get(`/api/v1/time/entries?userId=${fabi.userId}`)).status).toBe(403);
    expect((await caio.browser.get("/api/v1/time/entries")).json.data).toHaveLength(0);
  });

  test("SSE manda o painel ao conectar e de novo quando alguém inicia um timer", async () => {
    const cookie = (admin as unknown as { jar: Map<string, string> }).jar;
    const res = await app.request("http://localhost:3000/api/v1/time/working-now/stream", {
      headers: { origin: WEB, cookie: [...cookie].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const nextSnapshot = async () => {
      let buf = "";
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        const m = buf.match(/event: snapshot\ndata: (.*)\n/);
        if (m) return JSON.parse(m[1]!);
      }
      throw new Error("sem snapshot");
    };
    const first = await nextSnapshot();
    expect(first.working.map((x: { user: { id: string } }) => x.user.id)).toEqual([fabi.userId]);
    await new Promise((r) => setTimeout(r, 300)); // LISTEN conectado
    await gestor.browser.post("/api/v1/time/start", { taskId: taskA });
    const second = await nextSnapshot();
    expect(second.working.map((x: { user: { id: string } }) => x.user.id).sort()).toEqual(
      [fabi.userId, gestor.userId].sort(),
    );
    await reader.cancel();
  });
});

describe("SLA de cobrança do cliente", () => {
  test("avisa o atendimento uma vez quando passa do SLA; cobrar zera", async () => {
    const t = await newTask("Post aguardando");
    await admin.post(`/api/v1/tasks/${t}/move`, { statusKey: "aguardando_cliente" });
    await owner.query(
      "update tenant_settings set operation = jsonb_set(operation, '{defaultBusinessHours}', $1) where tenant_id = $2",
      [ALL_DAY, tenantId],
    );
    let r = await runClientChaseSla({ platformDb: dbs.platformDb, appDb: dbs.appDb });
    expect(r.notified).toBe(0); // acabou de entrar
    await owner.query("update tasks set status_since = now() - interval '3 days' where id = $1", [t]);
    r = await runClientChaseSla({ platformDb: dbs.platformDb, appDb: dbs.appDb });
    expect(r.notified).toBe(1);
    const n = await owner.query(
      "select * from notifications where type = 'cobranca_cliente_sla' and reference_id = $1",
      [t],
    );
    expect(n.rows.map((x) => x.user_id)).toEqual([gestor.userId]);
    r = await runClientChaseSla({ platformDb: dbs.platformDb, appDb: dbs.appDb });
    expect(r.notified).toBe(0); // não repete
    expect((await admin.post(`/api/v1/tasks/${t}/chase`)).status).toBe(204);
    r = await runClientChaseSla({ platformDb: dbs.platformDb, appDb: dbs.appDb });
    expect(r.notified).toBe(0); // a cobrança recomeça a contagem
  });
});

describe("Configurações", () => {
  test("só admin lê e altera", async () => {
    const s = await admin.get("/api/v1/settings");
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({
      timezone: "America/Sao_Paulo",
      ai: { enabled: false, keyConfigured: false },
    });
    expect(s.json.operation.clientChaseSlaBusinessHours).toBe(16);
    expect((await gestor.browser.get("/api/v1/settings")).status).toBe(403);
    expect(
      (await gestor.browser.put("/api/v1/settings/productivity", s.json.productivityWeights)).status,
    ).toBe(403);
  });

  test("operação: fuso, SLA e horário padrão", async () => {
    const bad = await admin.put("/api/v1/settings/operation", {
      timezone: "Lua/Base",
      clientChaseSlaBusinessHours: 8,
      idleCardHours: 48,
      defaultBusinessHours: ALL_DAY,
    });
    expect(bad.json.error.code).toBe("INVALID_TIMEZONE");
    const r = await admin.put("/api/v1/settings/operation", {
      timezone: "America/Recife",
      clientChaseSlaBusinessHours: 8,
      idleCardHours: 24,
      defaultBusinessHours: { days: { 1: [{ start: "08:00", end: "17:00" }] } },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({
      timezone: "America/Recife",
      operation: { clientChaseSlaBusinessHours: 8 },
    });
    const op = (await owner.query("select operation from tenant_settings where tenant_id = $1", [tenantId]))
      .rows[0];
    expect(op.operation.holidayImport).toBeDefined(); // campos não editados ficam
  });

  test("pesos de produtividade e marca", async () => {
    const s = (await admin.get("/api/v1/settings")).json;
    const w = { ...s.productivityWeights, production: { ...s.productivityWeights.production, perPiece: 12 } };
    expect(
      (await admin.put("/api/v1/settings/productivity", w)).json.productivityWeights.production.perPiece,
    ).toBe(12);
    expect((await admin.put("/api/v1/settings/branding", { primaryColor: "azul" })).status).toBe(400);
    const b = await admin.put("/api/v1/settings/branding", { primaryColor: "#0EA5E9" });
    expect(b.json.branding.primaryColor).toBe("#0EA5E9");
    expect((await admin.get("/api/v1/workspace")).json.branding.primaryColor).toBe("#0EA5E9");
    expect(
      (await admin.put("/api/v1/settings/branding", { primaryColor: null })).json.branding.primaryColor,
    ).toBeNull();
  });

  test("IA: a chave é criptografada e nunca volta", async () => {
    const r = await admin.put("/api/v1/settings/ai", {
      enabled: true,
      assistantName: "Recinha",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-test-1234567890",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.ai).toEqual({
      enabled: true,
      assistantName: "Recinha",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      keyConfigured: true,
    });
    expect(JSON.stringify(r.json)).not.toContain("sk-test");
    const sec = (
      await owner.query("select ai_api_key_enc from tenant_secrets where tenant_id = $1", [tenantId])
    ).rows[0];
    expect(sec.ai_api_key_enc).toMatch(/^v1:/);
    expect(sec.ai_api_key_enc).not.toContain("sk-test");
    // sem apiKey: mantém; null: apaga
    expect((await admin.put("/api/v1/settings/ai", { enabled: true })).json.ai.keyConfigured).toBe(true);
    expect(
      (await admin.put("/api/v1/settings/ai", { enabled: false, apiKey: null })).json.ai.keyConfigured,
    ).toBe(false);
  });

  test("chaves de API: segredo aparece uma vez, guardado só o hash; revogar", async () => {
    const k = await admin.post("/api/v1/settings/api-keys", { name: "Zapier" });
    expect(k.status, JSON.stringify(k.json)).toBe(201);
    expect(k.json.key).toMatch(/^pk_live_[0-9a-f]{12}_[\w-]{40,}$/);
    const list = await admin.get("/api/v1/settings/api-keys");
    expect(list.json.data).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain(k.json.key.split("_").pop());
    const row = (await owner.query("select hashed_key from api_keys where id = $1", [k.json.id])).rows[0];
    expect(row.hashed_key).toHaveLength(64);
    expect((await gestor.browser.post("/api/v1/settings/api-keys", { name: "X" })).status).toBe(403);
    expect((await admin.del(`/api/v1/settings/api-keys/${k.json.id}`)).status).toBe(204);
    expect((await admin.get("/api/v1/settings/api-keys")).json.data).toHaveLength(0);
  });
});
