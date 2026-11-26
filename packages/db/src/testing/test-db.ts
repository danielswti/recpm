/**
 * Cria um banco de teste descartável, com os mesmos papéis e RLS da produção.
 * Usado pelos testes de @recpm/db e @recpm/api (globalSetup do Vitest).
 *
 * Requer TEST_PG_ADMIN_URL = superusuário de um Postgres de teste (CI: service container;
 * local: o do docker-compose). Os papéis são do cluster, então são criados uma vez, com senhas
 * fixas de teste — NUNCA aponte TEST_PG_ADMIN_URL para um servidor de produção.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { migrateDatabase } from "../migrate";

export type TestDbUrls = {
  name: string;
  owner: string;
  app: string;
  auth: string;
  platform: string;
};

const ROLES = {
  recpm_owner: "LOGIN",
  recpm_app: "LOGIN NOBYPASSRLS",
  recpm_auth: "LOGIN BYPASSRLS",
  recpm_platform: "LOGIN BYPASSRLS",
} as const;
const TEST_PASSWORD = "recpm_test";

const withDb = (adminUrl: string, db: string) => {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
};
const asRole = (adminUrl: string, db: string, role: string) => {
  const u = new URL(withDb(adminUrl, db));
  u.username = role;
  u.password = TEST_PASSWORD;
  return u.toString();
};

export async function createTestDatabase(adminUrl: string): Promise<TestDbUrls> {
  const name = `recpm_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const [role, attrs] of Object.entries(ROLES)) {
      const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (exists.rowCount === 0)
        await admin.query(`CREATE ROLE ${role} ${attrs} PASSWORD '${TEST_PASSWORD}'`);
    }
    await admin.query(`CREATE DATABASE ${name} OWNER recpm_owner`);
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO recpm_app, recpm_auth, recpm_platform`);
  } finally {
    await admin.end();
  }
  const inDb = new Client({ connectionString: withDb(adminUrl, name) });
  await inDb.connect();
  try {
    await inDb.query("ALTER SCHEMA public OWNER TO recpm_owner");
    await inDb.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await inDb.query("GRANT USAGE ON SCHEMA public TO recpm_app, recpm_auth, recpm_platform");
  } finally {
    await inDb.end();
  }
  const urls: TestDbUrls = {
    name,
    owner: asRole(adminUrl, name, "recpm_owner"),
    app: asRole(adminUrl, name, "recpm_app"),
    auth: asRole(adminUrl, name, "recpm_auth"),
    platform: asRole(adminUrl, name, "recpm_platform"),
  };
  await migrateDatabase(urls.owner);
  return urls;
}

export async function dropTestDatabase(adminUrl: string, name: string) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
