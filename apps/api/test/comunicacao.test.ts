/**
 * Fase 6 — notificações (sino, preferências, e-mail e push), lembretes de prazo, agenda e
 * feriados, chat (diretas, grupos, projeto, menções, não lidas) e o assistente de IA.
 */
import { runDeadlineReminders } from "@recpm/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PushSender } from "../src/lib/push";
import { createNotificationDispatcher } from "../src/services/notification-dispatch";
import { addMember, Browser, createWorkspace, setupApp, signUp, WEB } from "./helpers";

// ── falsos: web push, BrasilAPI e provedor de IA ──────────────────────────────
const pushed: { endpoint: string; title: string; url?: string }[] = [];
const fakePush: PushSender = {
  publicKey: "BPUBLICKEY",
  async send(target, payload) {
    if (target.endpoint.includes("gone")) return { gone: true };
    pushed.push({ endpoint: target.endpoint, title: payload.title, url: payload.url });
    return { gone: false };
  },
};
let holidayCalls = 0;
const aiRequests: { messages: { role: string; content: string | null }[] }[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("brasilapi.com.br")) {
    holidayCalls++;
    const year = url.split("/").pop();
    return Response.json([
      { date: `${year}-01-01`, name: "Confraternização mundial", type: "national" },
      { date: `${year}-04-21`, name: "Tiradentes", type: "national" },
    ]);
  }
  if (url.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init?.body));
    aiRequests.push(body);
    const hasToolResult = body.messages.some((m: { role: string }) => m.role === "tool");
    if (!hasToolResult)
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "search_tasks", arguments: JSON.stringify({ query: "Reels" }) },
                },
              ],
            },
          },
        ],
      });
    const tool = body.messages.find((m: { role: string }) => m.role === "tool");
    return Response.json({ choices: [{ message: { content: `Achei: ${tool.content}` } }] });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const { app, mailer, urls, dbs, deps } = setupApp({ push: fakePush, fetch: fakeFetch });
const owner = new Pool({ connectionString: urls.owner });
afterAll(async () => {
  await owner.end();
  await app.live.close();
});

const admin = new Browser(app);
const stranger = new Browser(app);
let tenantId: string;
let adminId: string;
let strangerId: string;
let gestor: { browser: Browser; userId: string };
let fabi: { browser: Browser; userId: string };
let caio: { browser: Browser; userId: string };
let projectId: string;
let taskA: string;

const year = new Date().getFullYear();
const dayISO = (d: Date) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  adminId = (await signUp(admin, "Ana")).userId;
  tenantId = (await createWorkspace(admin, "Agência Avisos")).id;
  strangerId = (await signUp(stranger, "Estranho")).userId;
  await createWorkspace(stranger, "Outra");
  gestor = await addMember(app, admin, mailer, tenantId, "Gil", "gestor");
  fabi = await addMember(app, admin, mailer, tenantId, "Fabi Souza", "funcionario");
  caio = await addMember(app, admin, mailer, tenantId, "Caio", "funcionario");
  const clientId = (await admin.post("/api/v1/clients", { code: "PAO", name: "Padaria" })).json.id;
  projectId = (
    await admin.post("/api/v1/projects", {
      name: "Padaria | Mensal",
      clientId,
      managerId: gestor.userId,
      members: [{ userId: fabi.userId }],
    })
  ).json.id;
  const t = await admin.post("/api/v1/tasks", {
    title: "Reels da padaria",
    projectId,
    assigneeId: fabi.userId,
  });
  expect(t.status, JSON.stringify(t.json)).toBe(201);
  taskA = t.json.id;
  // o teste do despachante só olha o que nasce daqui para frente
  await owner.query("update notifications set dispatched_at = now() where dispatched_at is null");
});

describe("Notificações", () => {
  test("o sino lista, conta e marca como lida", async () => {
    const t = await admin.post("/api/v1/tasks", { title: "Post do pão", projectId, assigneeId: fabi.userId });
    expect(t.status).toBe(201);
    const list = await fabi.browser.get("/api/v1/notifications");
    expect(list.status).toBe(200);
    const n = list.json.data.find((x: { referenceId: string }) => x.referenceId === t.json.id);
    expect(n).toMatchObject({ type: "tarefa_atribuida", read: false, referenceType: "task" });
    const before = (await fabi.browser.get("/api/v1/notifications/unread-count")).json.unread;
    expect(before).toBeGreaterThanOrEqual(1);

    expect((await fabi.browser.post(`/api/v1/notifications/${n.id}/read`, { read: true })).status).toBe(204);
    expect((await fabi.browser.get("/api/v1/notifications/unread-count")).json.unread).toBe(before - 1);
    // ninguém mexe nas notificações dos outros
    expect((await caio.browser.post(`/api/v1/notifications/${n.id}/read`, { read: false })).status).toBe(404);
    expect((await stranger.post(`/api/v1/notifications/${n.id}/read`, { read: false })).status).toBe(404);

    expect((await fabi.browser.post("/api/v1/notifications/read-all")).status).toBe(204);
    expect((await fabi.browser.get("/api/v1/notifications/unread-count")).json.unread).toBe(0);
    expect((await fabi.browser.get("/api/v1/notifications?unread=true")).json.data).toHaveLength(0);
  });

  test("preferências: desligar o aviso no app tira o tipo do sino", async () => {
    const prefs = await fabi.browser.get("/api/v1/notifications/preferences");
    expect(prefs.status).toBe(200);
    expect(prefs.json.data.find((p: { type: string }) => p.type === "prazo_vencido")).toMatchObject({
      inApp: true,
      email: true,
      push: true,
    });
    const put = await fabi.browser.put("/api/v1/notifications/preferences", {
      preferences: [{ type: "tarefa_atribuida", inApp: false, email: true, push: false }],
    });
    expect(put.status, JSON.stringify(put.json)).toBe(204);
    await admin.post("/api/v1/tasks", { title: "Stories", projectId, assigneeId: fabi.userId });
    expect((await fabi.browser.get("/api/v1/notifications/unread-count")).json.unread).toBe(0);
    // volta ao padrão
    await fabi.browser.put("/api/v1/notifications/preferences", {
      preferences: [{ type: "tarefa_atribuida", inApp: true, email: false, push: true }],
    });
  });

  test("despachante manda e-mail e push conforme as preferências e limpa inscrições mortas", async () => {
    expect((await fabi.browser.get("/api/v1/push/public-key")).json.key).toBe("BPUBLICKEY");
    const keys = { p256dh: "p256dh-key-0123456789", auth: "auth-key-123" };
    expect(
      (await fabi.browser.post("/api/v1/push/subscriptions", { endpoint: "https://push.test/fabi", keys }))
        .status,
    ).toBe(204);
    expect(
      (await fabi.browser.post("/api/v1/push/subscriptions", { endpoint: "https://push.test/gone", keys }))
        .status,
    ).toBe(204);
    await fabi.browser.put("/api/v1/notifications/preferences", {
      preferences: [{ type: "tarefa_atribuida", inApp: true, email: true, push: true }],
    });

    const dispatcher = createNotificationDispatcher({ ...deps, live: app.live }, fakePush);
    await dispatcher.runOnce(); // esvazia o que sobrou dos testes anteriores
    pushed.length = 0;
    mailer.outbox.length = 0;

    await admin.post("/api/v1/tasks", { title: "Carrossel", projectId, assigneeId: fabi.userId });
    const r = await dispatcher.runOnce();
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(pushed).toEqual([
      expect.objectContaining({
        endpoint: "https://push.test/fabi",
        url: expect.stringContaining(`${WEB}/tarefas?task=`),
      }),
    ]);
    const mail = mailer.outbox.find((m) => m.subject.includes("Carrossel"));
    expect(mail?.subject).toContain("Agência Avisos");
    const subs = await owner.query("select endpoint from push_subscriptions where user_id = $1", [
      fabi.userId,
    ]);
    expect(subs.rows.map((x) => x.endpoint)).toEqual(["https://push.test/fabi"]);
    // nada é enviado duas vezes
    expect((await dispatcher.runOnce()).sent).toBe(0);

    expect(
      (await fabi.browser.post("/api/v1/push/unsubscribe", { endpoint: "https://push.test/fabi" })).status,
    ).toBe(204);
    await fabi.browser.put("/api/v1/notifications/preferences", {
      preferences: [{ type: "tarefa_atribuida", inApp: true, email: false, push: true }],
    });
  });

  test("lembretes de prazo: 24 h antes e vencido, uma vez por prazo", async () => {
    await owner.query("update tasks set deadline = now() + interval '3 hours' where id = $1", [taskA]);
    const first = await runDeadlineReminders(dbs);
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const q = (type: string) =>
      owner.query("select user_id from notifications where reference_id = $1 and type = $2", [taskA, type]);
    expect((await q("prazo_proximo")).rows.map((r) => r.user_id)).toEqual([fabi.userId]);
    await runDeadlineReminders(dbs);
    expect((await q("prazo_proximo")).rows).toHaveLength(1);

    await owner.query("update tasks set deadline = now() - interval '1 hour' where id = $1", [taskA]);
    await runDeadlineReminders(dbs);
    const overdue = (await q("prazo_vencido")).rows.map((r) => r.user_id).sort();
    expect(overdue).toEqual([fabi.userId, gestor.userId].sort());
    await runDeadlineReminders(dbs);
    expect((await q("prazo_vencido")).rows).toHaveLength(2);

    // mudar o prazo pela API rearma os lembretes
    const d = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect((await admin.patch(`/api/v1/tasks/${taskA}`, { deadline: d, deadlineHasTime: true })).status).toBe(
      200,
    );
    const row = (
      await owner.query("select deadline_reminder_at, overdue_notified_at from tasks where id = $1", [taskA])
    ).rows[0];
    expect(row).toEqual({ deadline_reminder_at: null, overdue_notified_at: null });
  });

  test("SSE do usuário avisa a contagem nova quando chega notificação", async () => {
    const cookie = (fabi.browser as unknown as { jar: Map<string, string> }).jar;
    const ctrl = new AbortController();
    const res = await app.request("http://localhost:3000/api/v1/stream", {
      headers: { origin: WEB, cookie: [...cookie].map(([k, v]) => `${k}=${v}`).join("; ") },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const waitFor = async (re: RegExp) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const m = buf.match(re);
        if (m) {
          buf = buf.slice(m.index! + m[0].length);
          return m;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      throw new Error(`sem ${re}`);
    };
    const first = await waitFor(/event: notification\ndata: (.*)\n/);
    const unread = JSON.parse(first[1]!).unread;
    await new Promise((r) => setTimeout(r, 300)); // LISTEN conectado
    await admin.post("/api/v1/tasks", { title: "Vídeo", projectId, assigneeId: fabi.userId });
    const next = await waitFor(/event: notification\ndata: (.*)\n/);
    expect(JSON.parse(next[1]!).unread).toBe(unread + 1);
    ctrl.abort();
    await reader.cancel().catch(() => {});
  });
});

describe("Agenda", () => {
  test("eventos: criar, listar no período, anuais projetados e permissões", async () => {
    const date = `${year}-06-10`;
    const ev = await gestor.browser.post("/api/v1/calendar/events", {
      title: "Reunião de pauta",
      date,
      time: "10:00",
      type: "reuniao",
      projectId,
    });
    expect(ev.status, JSON.stringify(ev.json)).toBe(201);
    const bday = await admin.post("/api/v1/calendar/events", {
      title: "Aniversário da agência",
      date: `${year - 3}-06-12`,
      type: "aniversario",
      yearlyRecurring: true,
    });
    expect(bday.status).toBe(201);
    // funcionário vê, mas não cria
    expect((await caio.browser.post("/api/v1/calendar/events", { title: "x", date })).status).toBe(403);

    const list = await caio.browser.get(`/api/v1/calendar?from=${year}-06-01&to=${year}-06-30`);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    const titles = list.json.data.map((i: { title: string; date: string }) => `${i.date} ${i.title}`);
    expect(titles).toContain(`${date} Reunião de pauta`);
    expect(titles).toContain(`${year}-06-12 Aniversário da agência`);
    const meeting = list.json.data.find((i: { title: string }) => i.title === "Reunião de pauta");
    expect(meeting).toMatchObject({
      kind: "event",
      type: "reuniao",
      time: "10:00",
      project: { clientCode: "PAO" },
    });

    // filtro por tipo
    const only = await caio.browser.get(
      `/api/v1/calendar?from=${year}-06-01&to=${year}-06-30&types=aniversario`,
    );
    expect(only.json.data.every((i: { type: string }) => i.type === "aniversario")).toBe(true);

    expect(
      (await gestor.browser.patch(`/api/v1/calendar/events/${ev.json.id}`, { title: "Pauta de julho", date }))
        .status,
    ).toBe(204);
    expect((await gestor.browser.del(`/api/v1/calendar/events/${ev.json.id}`)).status).toBe(204);
    // de outro workspace não se vê nada
    const other = await stranger.get(`/api/v1/calendar?from=${year}-06-01&to=${year}-06-30`);
    expect(other.json.data).toHaveLength(0);
  });

  test("aba de entregas mostra os prazos das tarefas visíveis", async () => {
    const day = new Date(Date.now() + 5 * 86_400_000);
    await owner.query("update tasks set deadline = $2 where id = $1", [taskA, day]);
    const q = `/api/v1/calendar?from=${dayISO(new Date(Date.now() - 86_400_000))}&to=${dayISO(new Date(Date.now() + 10 * 86_400_000))}&tab=deliveries`;
    const fabiView = await fabi.browser.get(q);
    expect(fabiView.status).toBe(200);
    expect(
      fabiView.json.data.find((i: { task: { id: string } | null }) => i.task?.id === taskA),
    ).toMatchObject({
      kind: "task",
      type: "entrega",
    });
    // Caio não participa do projeto: não vê a tarefa
    const caioView = await caio.browser.get(q);
    expect(
      caioView.json.data.find((i: { task: { id: string } | null }) => i.task?.id === taskA),
    ).toBeUndefined();
  });

  test("feriados nacionais: importa da BrasilAPI (com cache) e remove ao desligar", async () => {
    const on = await admin.put("/api/v1/calendar/holidays", { year, national: true });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    expect(on.json.added).toBe(2);
    expect((await admin.put("/api/v1/calendar/holidays", { year, national: true })).json.added).toBe(0);
    expect(holidayCalls).toBe(1); // segunda vez veio do cache
    expect((await admin.get("/api/v1/calendar/holidays")).json).toEqual({ national: true, imported: 2 });
    const list = await caio.browser.get(`/api/v1/calendar?from=${year}-04-01&to=${year}-04-30`);
    expect(list.json.data.find((i: { title: string }) => i.title === "Tiradentes")).toMatchObject({
      type: "feriado",
      isDayOff: true,
    });
    expect((await caio.browser.put("/api/v1/calendar/holidays", { year, national: false })).status).toBe(403);
    expect((await admin.put("/api/v1/calendar/holidays", { year, national: false })).json.national).toBe(
      false,
    );
    expect((await admin.get("/api/v1/calendar/holidays")).json).toEqual({ national: false, imported: 0 });
  });
});

describe("Chat", () => {
  let dm: string;
  let group: string;

  test("conversa direta é única entre duas pessoas e só da equipe", async () => {
    const a = await fabi.browser.post("/api/v1/chat/conversations", { type: "dm", userId: caio.userId });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json).toMatchObject({ type: "dm", name: "Caio" });
    const b = await caio.browser.post("/api/v1/chat/conversations", { type: "dm", userId: fabi.userId });
    expect(b.status).toBe(200);
    expect(b.json.id).toBe(a.json.id);
    dm = a.json.id;
    // fora do workspace não dá
    expect(
      (await fabi.browser.post("/api/v1/chat/conversations", { type: "dm", userId: strangerId })).status,
    ).toBe(400);
    expect(
      (await fabi.browser.post("/api/v1/chat/conversations", { type: "dm", userId: fabi.userId })).status,
    ).toBe(400);
  });

  test("mensagens, não lidas, marcar como não lida e fixar", async () => {
    const m = await fabi.browser.post(`/api/v1/chat/conversations/${dm}/messages`, { body: "Oi Caio!" });
    expect(m.status, JSON.stringify(m.json)).toBe(201);
    expect(m.json.data[0]).toMatchObject({
      body: "Oi Caio!",
      authorType: "user",
      author: { id: fabi.userId },
    });
    expect((await fabi.browser.post(`/api/v1/chat/conversations/${dm}/messages`, { body: "" })).status).toBe(
      400,
    );

    let caioList = await caio.browser.get("/api/v1/chat/conversations");
    expect(caioList.json.data.find((c: { id: string }) => c.id === dm)).toMatchObject({
      unread: 1,
      lastMessage: { body: "Oi Caio!", authorName: "Fabi Souza" },
    });
    expect(caioList.json.unread).toBe(1);
    // quem mandou não tem não lida
    expect((await fabi.browser.get("/api/v1/chat/conversations")).json.data[0].unread).toBe(0);

    const msgs = await caio.browser.get(`/api/v1/chat/conversations/${dm}/messages`);
    expect(msgs.json.data.map((x: { body: string }) => x.body)).toEqual(["Oi Caio!"]);
    await caio.browser.post(`/api/v1/chat/conversations/${dm}/state`, { read: true });
    caioList = await caio.browser.get("/api/v1/chat/conversations");
    expect(caioList.json.unread).toBe(0);
    await caio.browser.post(`/api/v1/chat/conversations/${dm}/state`, { read: false, pinned: true });
    caioList = await caio.browser.get("/api/v1/chat/conversations");
    expect(caioList.json.data[0]).toMatchObject({ id: dm, markedUnread: true, pinned: true });
    expect(caioList.json.unread).toBe(1);

    // a mensagem só gera push (lida no sino), não aparece no sino
    const n = await owner.query(
      "select read, type from notifications where user_id = $1 and reference_id = $2",
      [caio.userId, dm],
    );
    expect(n.rows).toEqual([{ read: true, type: "chat_mensagem" }]);

    // editar e apagar só a própria
    const id = m.json.data[0].id;
    expect((await caio.browser.patch(`/api/v1/chat/messages/${id}`, { body: "hack" })).status).toBe(404);
    expect(
      (await fabi.browser.patch(`/api/v1/chat/messages/${id}`, { body: "Oi, Caio!" })).json,
    ).toMatchObject({
      body: "Oi, Caio!",
      editedAt: expect.any(String),
    });
    expect((await fabi.browser.del(`/api/v1/chat/messages/${id}`)).status).toBe(204);
    const after = await caio.browser.get(`/api/v1/chat/conversations/${dm}/messages`);
    expect(after.json.data[0]).toMatchObject({ deleted: true, body: "" });
  });

  test("grupos: admin gerencia participantes; menção vira notificação; quem está fora não vê", async () => {
    const g = await admin.post("/api/v1/chat/conversations", {
      type: "grupo",
      name: "Criação",
      userIds: [fabi.userId],
    });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    group = g.json.id;
    expect(g.json).toMatchObject({ type: "grupo", name: "Criação", isAdmin: true });
    // Caio está fora
    expect((await caio.browser.get(`/api/v1/chat/conversations/${group}/messages`)).status).toBe(404);
    expect(
      (await caio.browser.post(`/api/v1/chat/conversations/${group}/messages`, { body: "oi" })).status,
    ).toBe(404);
    // Fabi não é admin
    expect(
      (
        await fabi.browser.post(`/api/v1/chat/conversations/${group}/participants`, {
          userIds: [caio.userId],
        })
      ).status,
    ).toBe(403);
    expect((await fabi.browser.patch(`/api/v1/chat/conversations/${group}`, { name: "x" })).status).toBe(403);
    const add = await admin.post(`/api/v1/chat/conversations/${group}/participants`, {
      userIds: [caio.userId],
    });
    expect(add.status).toBe(200);
    expect(add.json.participants).toHaveLength(3);
    expect(
      (await admin.patch(`/api/v1/chat/conversations/${group}`, { name: "Time de criação" })).json.name,
    ).toBe("Time de criação");

    await admin.post(`/api/v1/chat/conversations/${group}/messages`, { body: "@Fabi pode revisar?" });
    const mention = await fabi.browser.get("/api/v1/notifications?unread=true");
    expect(mention.json.data[0]).toMatchObject({
      type: "mencao",
      referenceType: "conversation",
      referenceId: group,
      title: "Ana mencionou você em Time de criação",
    });

    // sair do grupo
    expect(
      (await caio.browser.del(`/api/v1/chat/conversations/${group}/participants/${caio.userId}`)).status,
    ).toBe(204);
    expect((await caio.browser.get(`/api/v1/chat/conversations/${group}/messages`)).status).toBe(404);
    // e o outro workspace não enxerga nada
    expect((await stranger.get(`/api/v1/chat/conversations/${group}/messages`)).status).toBe(404);
    expect((await stranger.get("/api/v1/chat/conversations")).json.data).toHaveLength(0);
  });

  test("conversa do projeto: entra quem vê o projeto", async () => {
    const a = await fabi.browser.post(`/api/v1/chat/projects/${projectId}`);
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json).toMatchObject({ type: "projeto", name: "Padaria | Mensal", project: { id: projectId } });
    const b = await gestor.browser.post(`/api/v1/chat/projects/${projectId}`);
    expect(b.json.id).toBe(a.json.id);
    expect(b.json.participants).toHaveLength(2);
    // Caio não está no projeto
    expect([403, 404]).toContain((await caio.browser.post(`/api/v1/chat/projects/${projectId}`)).status);
  });

  test("digitando: chega pelo SSE de quem está na conversa", async () => {
    const cookie = (fabi.browser as unknown as { jar: Map<string, string> }).jar;
    const ctrl = new AbortController();
    const res = await app.request("http://localhost:3000/api/v1/stream", {
      headers: { origin: WEB, cookie: [...cookie].map(([k, v]) => `${k}=${v}`).join("; ") },
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    await reader.read();
    await new Promise((r) => setTimeout(r, 300));
    expect((await admin.post(`/api/v1/chat/conversations/${group}/typing`)).status).toBe(204);
    expect((await caio.browser.post(`/api/v1/chat/conversations/${group}/typing`)).status).toBe(404);
    const deadline = Date.now() + 8000;
    while (!/event: typing/.test(buf) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    const m = buf.match(/event: typing\ndata: (.*)\n/);
    expect(JSON.parse(m![1]!)).toEqual({ conversationId: group, userId: adminId, name: "Ana" });
    ctrl.abort();
    await reader.cancel().catch(() => {});
  });

  test("assistente de IA usa ferramentas que respeitam as permissões", async () => {
    const conv = await caio.browser.post("/api/v1/chat/ai");
    expect(conv.status).toBe(200);
    expect(conv.json.type).toBe("ia");
    expect((await caio.browser.post("/api/v1/chat/ai")).json.id).toBe(conv.json.id);

    // desligado: responde com aviso do sistema
    const off = await caio.browser.post(`/api/v1/chat/conversations/${conv.json.id}/messages`, {
      body: "Oi",
    });
    expect(off.status).toBe(201);
    expect(off.json.data[1]).toMatchObject({
      authorType: "system",
      body: expect.stringContaining("desligado"),
    });

    const cfg = await admin.put("/api/v1/settings/ai", {
      enabled: true,
      assistantName: "Rita",
      apiKey: "sk-test-12345678",
      baseUrl: "https://ai.test/v1",
    });
    expect(cfg.status, JSON.stringify(cfg.json)).toBe(200);

    // Caio não vê as tarefas do projeto da padaria; Fabi vê
    const r1 = await caio.browser.post(`/api/v1/chat/conversations/${conv.json.id}/messages`, {
      body: "Quais Reels estão abertos?",
    });
    expect(r1.status, JSON.stringify(r1.json)).toBe(201);
    expect(r1.json.data[1]).toMatchObject({ authorType: "assistant", toolCalls: [{ name: "search_tasks" }] });
    expect(r1.json.data[1].body).not.toContain("Reels da padaria");

    const fconv = (await fabi.browser.post("/api/v1/chat/ai")).json.id;
    const r2 = await fabi.browser.post(`/api/v1/chat/conversations/${fconv}/messages`, {
      body: "E os meus Reels?",
    });
    expect(r2.json.data[1].body).toContain("Reels da padaria");
    expect(
      aiRequests.at(-1)!.messages.some((m) => m.role === "user" && m.content === "E os meus Reels?"),
    ).toBe(true);
    expect(
      (await fabi.browser.get("/api/v1/chat/conversations")).json.data.find(
        (c: { id: string }) => c.id === fconv,
      ).name,
    ).toBe("Rita");
  });
});
