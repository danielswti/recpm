import { createHmac } from "node:crypto";
import { createDbs } from "@recpm/db";
import { inject } from "vitest";
import { createApp } from "../src/app";
import { parseEnv } from "../src/env";
import { createLogger } from "../src/lib/logger";
import { memoryMailer } from "../src/lib/mailer";

export const WEB = "http://localhost:5173";

export function setupApp() {
  const db = inject("db");
  const env = parseEnv({
    NODE_ENV: "test",
    API_URL: "http://localhost:3000",
    WEB_URL: WEB,
    DATABASE_URL_APP: db.app,
    DATABASE_URL_AUTH: db.auth,
    DATABASE_URL_PLATFORM: db.platform,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
    LOG_LEVEL: "silent",
  });
  const dbs = createDbs({
    DATABASE_URL_APP: db.app,
    DATABASE_URL_AUTH: db.auth,
    DATABASE_URL_PLATFORM: db.platform,
  });
  const mailer = memoryMailer();
  const app = createApp({ env, dbs, mailer, logger: createLogger("silent") });
  return { app, dbs, mailer, urls: db };
}

type App = ReturnType<typeof setupApp>["app"];

/** Cliente HTTP de teste com "pote de cookies", simulando um navegador no front. */
export class Browser {
  private jar = new Map<string, string>();
  constructor(private app: App) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.request(`http://localhost:3000${path}`, {
      method,
      headers: {
        origin: WEB,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair!.indexOf("=");
      const k = pair!.slice(0, i);
      const v = pair!.slice(i + 1);
      if (v === "" || /max-age=0/i.test(sc)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown = {}, h?: Record<string, string>) => this.req("POST", p, b, h);
  clearCookies() {
    this.jar.clear();
  }
}

let seq = 0;
export const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export async function signUp(b: Browser, name: string, password = "senha-forte-123") {
  const email = `${uniq(name.toLowerCase())}@example.test`;
  const r = await b.post("/api/auth/sign-up/email", { name, email, password, acceptTerms: true });
  if (r.status !== 200) throw new Error(`sign-up falhou: ${r.status} ${JSON.stringify(r.json)}`);
  return { email, password, userId: r.json.user.id as string };
}

export async function createWorkspace(b: Browser, name: string) {
  const slug = uniq("ws").toLowerCase();
  const r = await b.post("/api/v1/workspaces", { name, slug });
  if (r.status !== 201) throw new Error(`workspace falhou: ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.id as string, slug };
}

/** TOTP (RFC 6238, SHA-1, 30 s, 6 dígitos) — para testar o 2FA sem app autenticador. */
export function totp(secretBase32: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretBase32.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}
