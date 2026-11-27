/** Fase 10: antivírus nos uploads, tipos bloqueados, bloqueio de conta por força bruta e health. */
import { createServer } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createClamdScanner, type Scanner } from "../src/lib/antivirus";
import { LOCKOUT_MAX_FAILURES } from "../src/lib/lockout";
import type { Storage } from "../src/lib/storage";
import { addMember, Browser, createWorkspace, setupApp, signUp } from "./helpers";

const objects = new Map<string, Uint8Array>();
const removed: string[] = [];
const storage: Storage = {
  presignUpload: async (key) => ({ url: `https://bucket.test/${key}?sig=1`, headers: {} }),
  presignDownload: async (key) => `https://bucket.test/${key}?download=1`,
  head: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)!.byteLength } : null),
  get: async (key) => objects.get(key) ?? null,
  put: async (key, body) => void objects.set(key, body),
  stream: async (key) => {
    const b = objects.get(key);
    return b
      ? (async function* () {
          yield b.subarray(0, 3);
          yield b.subarray(3);
        })()
      : null;
  },
  remove: async (key) => {
    removed.push(key);
    objects.delete(key);
  },
};

let clamdDown = false;
const scanner: Scanner = {
  maxBytes: 1024,
  async scan(body) {
    if (clamdDown) throw new Error("clamd fora do ar");
    let text = "";
    for await (const part of body) text += new TextDecoder().decode(part);
    return text.includes("EICAR")
      ? { status: "infected", signature: "Eicar-Test-Signature" }
      : { status: "clean" };
  },
};

const { app, mailer, urls } = setupApp({ storage, scanner });
const owner = new Pool({ connectionString: urls.owner });
const ana = new Browser(app);
let email: string;

beforeAll(async () => {
  email = (await signUp(ana, "Ana Segura")).email;
  await createWorkspace(ana, "Agência Segura");
});
afterAll(async () => {
  objects.clear();
  await owner.end();
});

async function upload(name: string, content: string, mimeType = "application/pdf", declared?: number) {
  const bytes = new TextEncoder().encode(content);
  const up = await ana.post("/api/v1/files/uploads", {
    name,
    mimeType,
    sizeBytes: declared ?? bytes.byteLength,
  });
  expect(up.status, JSON.stringify(up.json)).toBe(201);
  const key = new URL(up.json.uploadUrl).pathname.slice(1);
  objects.set(key, bytes);
  return { id: up.json.fileId as string, key };
}

describe("antivírus nos uploads", () => {
  test("arquivo limpo é liberado; infectado é apagado e não baixa", async () => {
    const ok = await upload("briefing.pdf", "conteúdo normal");
    const done = await ana.post(`/api/v1/files/${ok.id}/complete`);
    expect(done.json).toMatchObject({ scanStatus: "clean" });

    const bad = await upload(
      "fatura.pdf",
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    );
    const r = await ana.post(`/api/v1/files/${bad.id}/complete`);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("FILE_INFECTED");
    expect(removed).toContain(bad.key);
    expect((await ana.get(`/api/v1/files/${bad.id}/download`)).status).not.toBe(302);
  });

  test("clamd fora do ar: fica bloqueado e dá para tentar de novo", async () => {
    const f = await upload("roteiro.pdf", "texto");
    clamdDown = true;
    const r = await ana.post(`/api/v1/files/${f.id}/complete`);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("SCAN_UNAVAILABLE");
    expect((await ana.get(`/api/v1/files/${f.id}/download`)).status).not.toBe(302);
    clamdDown = false;
    expect((await ana.post(`/api/v1/files/${f.id}/complete`)).json.scanStatus).toBe("clean");
  });

  test("arquivo maior que o declarado é recusado", async () => {
    const f = await upload("grande.pdf", "0123456789", "application/pdf", 4);
    const r = await ana.post(`/api/v1/files/${f.id}/complete`);
    expect(r.json.error.code).toBe("UPLOAD_SIZE_MISMATCH");
  });

  test("executáveis são bloqueados pelo nome e pelo tipo", async () => {
    for (const [name, mimeType] of [
      ["setup.msi", "application/octet-stream"],
      ["atalho.lnk", "application/octet-stream"],
      ["app.bin", "application/x-msdownload"],
    ]) {
      const r = await ana.post("/api/v1/files/uploads", { name, mimeType, sizeBytes: 10 });
      expect(r.json.error?.code, name).toBe("FILE_TYPE_BLOCKED");
    }
  });
});

describe("bloqueio de conta", () => {
  test(`${LOCKOUT_MAX_FAILURES} senhas erradas bloqueiam até a senha certa`, async () => {
    const b = new Browser(app);
    for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) {
      const r = await b.post("/api/auth/sign-in/email", { email, password: "errada-123456" });
      expect(r.status).toBe(401);
    }
    const locked = await b.post("/api/auth/sign-in/email", { email, password: "senha-forte-123" });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe("ACCOUNT_LOCKED");
    // outra conta segue entrando normalmente
    const other = new Browser(app);
    const o = await signUp(other, "Bia");
    expect(
      (
        await new Browser(app).post("/api/auth/sign-in/email", {
          email: o.email,
          password: "senha-forte-123",
        })
      ).status,
    ).toBe(200);
  });
});

test("health público em /api/v1/health, sem cache", async () => {
  const r = await app.request("http://localhost:3000/api/v1/health");
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await r.json()).toMatchObject({ ok: true, db: true });
});

test("cliente do clamd fala o protocolo INSTREAM", async () => {
  // clamd falso: lê "zINSTREAM\0" e os blocos [tamanho de 4 bytes][dados] até o bloco vazio
  const srv = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.subarray(0, 10).equals(Buffer.from("zINSTREAM\0"))) return;
      let off = 10;
      const parts: Buffer[] = [];
      while (off + 4 <= buf.length) {
        const n = buf.readUInt32BE(off);
        if (n === 0) {
          const text = Buffer.concat(parts).toString();
          sock.end(text.includes("EICAR") ? "stream: Eicar-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (off + 4 + n > buf.length) return;
        parts.push(buf.subarray(off + 4, off + 4 + n));
        off += 4 + n;
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const clamd = createClamdScanner("127.0.0.1", port);
  const big = new Uint8Array(200_000).fill(65);
  expect(
    await clamd.scan(
      (async function* () {
        yield big;
      })(),
    ),
  ).toEqual({ status: "clean" });
  expect(
    await clamd.scan(
      (async function* () {
        yield new TextEncoder().encode("xx EICAR yy");
      })(),
    ),
  ).toEqual({ status: "infected", signature: "Eicar-Signature" });
  srv.close();
  await expect(createClamdScanner("127.0.0.1", port).scan((async function* () {})())).rejects.toThrow();
});

describe("exclusão do workspace (LGPD)", () => {
  test("só o admin, com confirmação; apaga dados e arquivos; assinatura paga bloqueia", async () => {
    const bia = new Browser(app);
    await signUp(bia, "Bia Exclui");
    const ws = await createWorkspace(bia, "Agência Some");
    const func = await addMember(app, bia, mailer, ws.id, "Caio", "funcionario");
    const up = await bia.post("/api/v1/files/uploads", {
      name: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    });
    const key = new URL(up.json.uploadUrl).pathname.slice(1);
    objects.set(key, new Uint8Array([1, 2, 3]));
    await bia.post(`/api/v1/files/${up.json.fileId}/complete`);
    await bia.post("/api/v1/clients", { code: "XYZ", name: "Cliente XYZ" });

    expect((await func.browser.req("DELETE", "/api/v1/workspace", { confirmSlug: ws.slug })).status).toBe(
      403,
    );
    expect((await bia.req("DELETE", "/api/v1/workspace", { confirmSlug: "outro" })).json.error.code).toBe(
      "CONFIRMATION_MISMATCH",
    );

    await owner.query(
      "update tenant_subscriptions set provider = 'stripe', provider_subscription_id = 'sub_x', status = 'active' where tenant_id = $1",
      [ws.id],
    );
    expect((await bia.req("DELETE", "/api/v1/workspace", { confirmSlug: ws.slug })).json.error.code).toBe(
      "SUBSCRIPTION_ACTIVE",
    );
    await owner.query("update tenant_subscriptions set status = 'canceled' where tenant_id = $1", [ws.id]);
    // modo somente leitura não impede a exclusão
    await owner.query("update tenants set status = 'read_only' where id = $1", [ws.id]);

    const del = await bia.req("DELETE", "/api/v1/workspace", { confirmSlug: ws.slug.toUpperCase() });
    expect(del.status, JSON.stringify(del.json)).toBe(204);
    const left = await owner.query(
      `select (select count(*) from tenants where id = $1) t, (select count(*) from clients where tenant_id = $1) c,
              (select count(*) from files where tenant_id = $1) f, (select count(*) from memberships where tenant_id = $1) m`,
      [ws.id],
    );
    expect(left.rows[0]).toEqual({ t: "0", c: "0", f: "0", m: "0" });
    expect(removed).toContain(key);
    const log = await owner.query(
      "select details from platform_audit_logs where action = 'tenant.delete' and details->>'tenantId' = $1",
      [ws.id],
    );
    expect(log.rows[0].details).toMatchObject({ slug: ws.slug, files: 1 });
    // a conta da pessoa continua existindo e o workspace sumiu da sessão
    expect((await bia.get("/api/v1/workspace")).status).not.toBe(200);
  });
});
