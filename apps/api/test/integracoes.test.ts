/**
 * Fase 9 — API pública (chave pk_live_, limite, exemplos da documentação), webhooks de saída
 * (gatilhos no banco, assinatura HMAC, novas tentativas), exportação de dados e auditoria.
 */
import { createHmac } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { API_EXAMPLES } from "../src/lib/api-docs";
import type { Storage } from "../src/lib/storage";
import { createDataExporter, scheduleDue } from "../src/services/data-export";
import { createWebhookDispatcher } from "../src/services/webhook-dispatch";
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

type Sent = { url: string; headers: Record<string, string>; body: string };
const sent: Sent[] = [];
let reply = 200;
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  sent.push({
    url: String(url),
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: String(init?.body ?? ""),
  });
  return new Response("ok", { status: reply });
}) as typeof fetch;

const { app, mailer, urls, deps } = setupApp({ storage, fetch: fakeFetch });
const owner = new Pool({ connectionString: urls.owner });
afterAll(() => owner.end());
const webhooks = createWebhookDispatcher({ ...deps, fetch: fakeFetch });
const exporter = createDataExporter(deps, { storage });

const admin = new Browser(app);
const other = new Browser(app);
let tenantId: string;
let otherTenant: string;
let fabi: { browser: Browser; userId: string };
let key: string;
let keyId: string;
let projectId: string;
let installmentId: string;
let installment2: string;
let clientId: string;

/** Pedido "de fora": sem cookie e sem Origin, só a chave. */
const call = async (method: string, path: string, body?: unknown, k = key) => {
  const res = await app.request(`http://localhost:3000${path}`, {
    method,
    headers: {
      authorization: `Bearer ${k}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};
const setPlan = async (tid: string, slug: string) =>
  owner.query(
    "update tenant_subscriptions set plan_id = (select id from plans where slug = $2) where tenant_id = $1",
    [tid, slug],
  );

beforeAll(async () => {
  await signUp(admin, "Ana");
  tenantId = (await createWorkspace(admin, "Agência Integrações")).id;
  await signUp(other, "Outro");
  otherTenant = (await createWorkspace(other, "Outra")).id;
  fabi = await addMember(app, admin, mailer, tenantId, "Fabi", "funcionario");
  await setPlan(tenantId, "enterprise");

  clientId = (await admin.post("/api/v1/clients", { code: "ACME", name: "Acme" })).json.id;
  const p = await admin.post("/api/v1/projects", { name: "Acme | Site", clientId, modality: "avulso" });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  projectId = p.json.id;
  const ct = await admin.post(`/api/v1/projects/${projectId}/contracts`, {
    modality: "parcelado",
    totalValueCents: 300000,
    installmentsCount: 2,
    firstDueDate: "2030-01-10",
  });
  expect(ct.status, JSON.stringify(ct.json)).toBe(201);
  installmentId = ct.json.installments[0].id;
  installment2 = ct.json.installments[1].id;

  const k = await admin.post("/api/v1/settings/api-keys", { name: "Zapier" });
  expect(k.status).toBe(201);
  key = k.json.key;
  keyId = k.json.id;
});

describe("API pública com chave", () => {
  test("Bearer sem cookie e sem Origin funciona; chave errada, revogada ou de plano sem API não", async () => {
    const r = await call("GET", "/api/v1/projects");
    expect(r.status).toBe(200);
    expect(r.json.data.map((x: { id: string }) => x.id)).toContain(projectId);
    expect(r.headers.get("x-ratelimit-limit")).toBe("120");

    expect((await call("GET", "/api/v1/projects", undefined, `${key.slice(0, -2)}xx`)).status).toBe(401);
    expect((await call("GET", "/api/v1/projects", undefined, "pk_live_nada")).status).toBe(401);

    await setPlan(tenantId, "essencial");
    const no = await call("GET", "/api/v1/projects");
    expect(no.status).toBe(402);
    expect(no.json.error.code).toBe("FEATURE_NOT_IN_PLAN");
    await setPlan(tenantId, "enterprise");
  });

  test("os exemplos da documentação funcionam como estão escritos", async () => {
    const ids: Record<string, string> = { PROJECT_ID: projectId, INSTALLMENT_ID: installmentId };
    for (const e of API_EXAMPLES) {
      const path = e.path.replace(/\{(\w+)\}/g, (_, n: string) => ids[n]!);
      const body = e.body
        ? JSON.parse(JSON.stringify(e.body).replace(/\{(\w+)\}/g, (_, n: string) => ids[n]!))
        : undefined;
      const r = await call(e.method, path, body);
      expect(r.status, `${e.id}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
      if (e.id === "standalone-task") {
        expect(r.json.project).toBeNull();
        const { rows } = await owner.query("select source from tasks where id = $1", [r.json.id]);
        expect(rows[0].source).toBe("api");
      }
      if (e.id === "project-task") expect(r.json.project.id).toBe(projectId);
      if (e.id === "pending-installments")
        expect(r.json.data.map((x: { id: string }) => x.id)).toContain(installmentId);
      if (e.id === "pay-installment") expect(r.json.status).toBe("pago");
    }
    const doc = (await (await app.request("http://localhost:3000/api/openapi.json")).json()) as any;
    expect(doc.components.securitySchemes.apiKey.scheme).toBe("bearer");
    expect(doc.paths["/api/v1/installments"].get).toBeTruthy();
    for (const e of API_EXAMPLES) expect(doc.info.description).toContain(e.title);
  });

  test("a chave herda as permissões de quem criou e não abre a plataforma", async () => {
    expect((await call("GET", "/api/v1/platform/tenants")).status).toBe(403);
    // chave de outro workspace não enxerga este
    await setPlan(otherTenant, "enterprise");
    const ok = await other.post("/api/v1/settings/api-keys", { name: "Outra" });
    const r = await call("GET", `/api/v1/projects/${projectId}`, undefined, ok.json.key);
    expect(r.status).toBe(404);
  });

  test("limite de 120 pedidos por minuto por chave", async () => {
    const k = (await admin.post("/api/v1/settings/api-keys", { name: "Limite" })).json.key;
    let last = 0;
    let retry: string | null = null;
    for (let i = 0; i < 121; i++) {
      const r = await call("GET", "/api/v1/me", undefined, k);
      last = r.status;
      retry = r.headers.get("retry-after");
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });

  test("chave revogada para de funcionar", async () => {
    const k = await admin.post("/api/v1/settings/api-keys", { name: "Temporária" });
    expect((await call("GET", "/api/v1/projects", undefined, k.json.key)).status).toBe(200);
    expect((await admin.del(`/api/v1/settings/api-keys/${k.json.id}`)).status).toBe(204);
    expect((await call("GET", "/api/v1/projects", undefined, k.json.key)).status).toBe(401);
    expect(keyId).toBeTruthy();
  });
});

describe("webhooks de saída", () => {
  let hookId: string;
  let secret: string;

  test("só admin; plano sem webhooks recusa; URL interna é bloqueada em produção", async () => {
    expect((await fabi.browser.get("/api/v1/settings/webhooks")).status).toBe(403);
    await setPlan(tenantId, "profissional");
    const no = await admin.post("/api/v1/settings/webhooks", {
      url: "https://hooks.example/x",
      events: ["task.created"],
    });
    expect(no.status).toBe(402);
    await setPlan(tenantId, "enterprise");
    const bad = await admin.post("/api/v1/settings/webhooks", { url: "ftp://x", events: ["task.created"] });
    expect(bad.status).toBe(400);
    const { checkWebhookUrl } = await import("../src/routes/integrations");
    expect(() => checkWebhookUrl("https://127.0.0.1/x", true)).toThrow();
    expect(() => checkWebhookUrl("http://hooks.example/x", true)).toThrow();
    expect(() => checkWebhookUrl("https://192.168.0.10/x", true)).toThrow();
    expect(checkWebhookUrl("https://hooks.example/x", true)).toBe("https://hooks.example/x");
  });

  test("eventos da tarefa e do projeto chegam assinados", async () => {
    const w = await admin.post("/api/v1/settings/webhooks", {
      url: "https://hooks.example/recpm",
      events: [
        "task.created",
        "task.status_changed",
        "task.completed",
        "project.created",
        "installment.paid",
      ],
    });
    expect(w.status, JSON.stringify(w.json)).toBe(201);
    hookId = w.json.id;
    secret = w.json.secret;
    expect(secret).toMatch(/^whsec_/);
    // o segredo não volta na listagem
    const list = await admin.get("/api/v1/settings/webhooks");
    expect(JSON.stringify(list.json)).not.toContain(secret);
    expect(list.json.available).toBe(true);

    const t = await admin.post("/api/v1/tasks", { title: "Banner", projectId });
    expect(t.status).toBe(201);
    await admin.post(`/api/v1/tasks/${t.json.id}/move`, { statusKey: "em_andamento" });
    expect((await admin.post("/api/v1/projects", { name: "Projeto novo", clientId })).status).toBe(201);

    sent.length = 0;
    reply = 200;
    const r = await webhooks.runOnce();
    expect(r.claimed).toBe(3);
    const events = sent.map((x) => x.headers["x-recpm-event"]).sort();
    expect(events).toEqual(["project.created", "task.created", "task.status_changed"]);
    for (const s of sent) {
      const [tPart, vPart] = s.headers["x-recpm-signature"]!.split(",");
      const ts = tPart!.slice(2);
      expect(vPart!.slice(3)).toBe(createHmac("sha256", secret).update(`${ts}.${s.body}`).digest("hex"));
      const body = JSON.parse(s.body);
      expect(body.tenantId).toBe(tenantId);
      expect(body.id).toBe(s.headers["x-recpm-delivery"]);
    }
    const moved = JSON.parse(sent.find((x) => x.headers["x-recpm-event"] === "task.status_changed")!.body);
    expect(moved.data.to).toBe("em_andamento");
    expect((await webhooks.runOnce()).claimed).toBe(0);
  });

  test("falha agenda nova tentativa; dá para repetir na mão; parcela paga também avisa", async () => {
    const pay = await admin.post(`/api/v1/installments/${installment2}/pay`, {
      paidAt: "2030-01-11",
      paidAmountCents: 150000,
      method: "boleto",
    });
    expect(pay.status, JSON.stringify(pay.json)).toBe(200);
    sent.length = 0;
    reply = 500;
    await webhooks.runOnce();
    expect(sent.map((x) => x.headers["x-recpm-event"])).toContain("installment.paid");
    const d = (await admin.get(`/api/v1/settings/webhooks/${hookId}/deliveries`)).json.data;
    const failed = d.find((x: { event: string }) => x.event === "installment.paid");
    expect(failed.status).toBe("failed");
    expect(failed.responseStatus).toBe(500);
    expect(new Date(failed.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 30_000);

    reply = 200;
    expect((await webhooks.runOnce()).claimed).toBe(0); // ainda não é hora
    const re = await admin.post(`/api/v1/settings/webhooks/${hookId}/deliveries/${failed.id}/retry`);
    expect(re.status).toBe(202);
    sent.length = 0;
    await webhooks.runOnce();
    expect(sent).toHaveLength(1);
    const after = (await admin.get(`/api/v1/settings/webhooks/${hookId}/deliveries`)).json.data;
    expect(after.find((x: { id: string }) => x.id === failed.id).status).toBe("succeeded");
  });

  test("teste manual, desligar e plano sem webhooks não enfileiram mais nada", async () => {
    expect((await admin.post(`/api/v1/settings/webhooks/${hookId}/test`)).status).toBe(202);
    sent.length = 0;
    await webhooks.runOnce();
    expect(sent[0]?.headers["x-recpm-event"]).toBe("webhook.test");

    await setPlan(tenantId, "profissional");
    await admin.post("/api/v1/tasks", { title: "Sem plano" });
    await setPlan(tenantId, "enterprise");
    await admin.patch(`/api/v1/settings/webhooks/${hookId}`, { active: false });
    await admin.post("/api/v1/tasks", { title: "Desligado" });
    const { rows } = await owner.query(
      "select count(*)::int n from webhook_deliveries where endpoint_id = $1 and status = 'pending'",
      [hookId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("exportação de dados", () => {
  test("exportar agora gera um zip sem segredos e só deste workspace", async () => {
    expect((await fabi.browser.post("/api/v1/exports", { format: "json" })).status).toBe(403);
    const e = await admin.post("/api/v1/exports", { format: "json" });
    expect(e.status).toBe(202);
    expect((await admin.post("/api/v1/exports", { format: "csv" })).status).toBe(409);
    expect(await exporter.runOnce()).toBe(1);
    const list = (await admin.get("/api/v1/exports")).json.data;
    expect(list[0].status).toBe("succeeded");
    expect(list[0].sizeBytes).toBeGreaterThan(100);
    const dl = await admin.get(`/api/v1/exports/${e.json.id}/download`);
    expect(dl.json.url).toContain("bucket.test");
    const key = new URL(dl.json.url).pathname.slice(1);
    const files = unzipSync(objects.get(key)!);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    expect(manifest.tenant.id).toBe(tenantId);
    const tasks = JSON.parse(strFromU8(files["tasks.json"]!));
    expect(tasks.length).toBeGreaterThan(2);
    expect(tasks.every((t: { tenant_id: string }) => t.tenant_id === tenantId)).toBe(true);
    const all = Object.values(files)
      .map((f) => strFromU8(f))
      .join("\n");
    expect(all).not.toContain("secret_enc");
    expect(all).not.toContain("hashed_key");
    expect(files["tenant_secrets.json"]).toBeUndefined();
    expect(JSON.parse(strFromU8(files["users.json"]!)).length).toBe(2);
  });

  test("CSV e agenda", async () => {
    const put = await admin.put("/api/v1/settings/backup", {
      enabled: true,
      everyNDays: 7,
      at: "00:00",
      format: "csv",
      webhookUrl: "https://backup.example/hook",
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    sent.length = 0;
    expect(await exporter.schedule()).toBeGreaterThanOrEqual(1);
    expect(await exporter.schedule()).toBe(0); // já tem uma na fila
    await exporter.runOnce();
    const list = (await admin.get("/api/v1/exports")).json.data;
    expect(list[0]).toMatchObject({ trigger: "schedule", format: "csv", status: "succeeded" });
    const ready = sent.find((x) => x.url === "https://backup.example/hook");
    expect(JSON.parse(ready!.body).event).toBe("export.ready");
    expect(await exporter.schedule()).toBe(0); // feita hoje: próxima só daqui a 7 dias
  });

  test("regra da agenda", () => {
    const tz = "America/Sao_Paulo";
    const at = (s: string) => new Date(s);
    expect(scheduleDue({ everyNDays: 1, at: "03:00" }, null, at("2030-01-10T05:00:00Z"), tz)).toBe(false); // 02:00 local
    expect(scheduleDue({ everyNDays: 1, at: "03:00" }, null, at("2030-01-10T06:30:00Z"), tz)).toBe(true);
    expect(
      scheduleDue({ everyNDays: 7, at: "03:00" }, at("2030-01-05T06:00:00Z"), at("2030-01-10T07:00:00Z"), tz),
    ).toBe(false);
    expect(
      scheduleDue({ everyNDays: 7, at: "03:00" }, at("2030-01-03T06:00:00Z"), at("2030-01-10T07:00:00Z"), tz),
    ).toBe(true);
  });
});

describe("auditoria", () => {
  test("admin lê com filtros e paginação; funcionário não", async () => {
    expect((await fabi.browser.get("/api/v1/audit")).status).toBe(403);
    const all = await admin.get("/api/v1/audit?limit=5");
    expect(all.status).toBe(200);
    expect(all.json.data).toHaveLength(5);
    expect(all.json.next).toBeTruthy();
    expect(all.json.facets.entities).toEqual(expect.arrayContaining(["webhook", "export", "api_key"]));
    const page2 = await admin.get(`/api/v1/audit?limit=5&before=${encodeURIComponent(all.json.next)}`);
    expect(page2.json.data[0].id).not.toBe(all.json.data[0].id);
    const hooks = await admin.get("/api/v1/audit?entity=webhook&action=create");
    expect(
      hooks.json.data.every(
        (x: { entity: string; action: string }) => x.entity === "webhook" && x.action === "create",
      ),
    ).toBe(true);
    expect(hooks.json.data.length).toBeGreaterThan(0);
    const other = await admin.get("/api/v1/audit?from=2000-01-01&to=2000-01-02");
    expect(other.json.data).toHaveLength(0);
  });
});
