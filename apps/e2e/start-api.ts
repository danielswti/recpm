/**
 * Sobe a API para os testes E2E: cria um banco descartável (mesmos papéis e RLS da produção),
 * aplica as migrações e inicia o servidor na porta E2E_API_PORT. Apaga o banco ao sair.
 */
import { createTestDatabase, dropTestDatabase } from "@recpm/db/testing";

const adminUrl = process.env.TEST_PG_ADMIN_URL;
if (!adminUrl) throw new Error("Defina TEST_PG_ADMIN_URL (superusuário do Postgres de teste)");
const db = await createTestDatabase(adminUrl);
const web = process.env.E2E_WEB_URL ?? "http://localhost:5180";
Object.assign(process.env, {
  // "test" desliga o limite por IP do login (vários cadastros seguidos do mesmo IP);
  // o bloqueio por conta e o limite têm testes próprios na API
  NODE_ENV: "test",
  PORT: process.env.E2E_API_PORT ?? "3100",
  API_URL: web,
  WEB_URL: web,
  DATABASE_URL_APP: db.app,
  DATABASE_URL_AUTH: db.auth,
  DATABASE_URL_PLATFORM: db.platform,
  BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-123",
  SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  LOG_LEVEL: "warn",
});
const cleanup = async () => {
  await dropTestDatabase(adminUrl, db.name).catch(() => {});
  process.exit(0);
};
process.once("SIGTERM", cleanup);
process.once("SIGINT", cleanup);
await import("../api/src/index");
