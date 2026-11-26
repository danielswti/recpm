/**
 * Migra o banco (como recpm_owner):
 *   1. migrações do drizzle-kit (schema)
 *   2. sql/rls.sql — idempotente; reaplicado SEMPRE, assim toda tabela nova com tenant_id
 *      ganha a política de isolamento e os GRANTs
 *   3. planos padrão (só insere os que ainda não existem)
 *
 * Uso: DATABASE_URL_OWNER=... pnpm db:migrate
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema";
import { seedPlans } from "./seed/plans";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export async function migrateDatabase(ownerUrl: string, opts: { log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const db = drizzle({ client: pool, schema, casing: "snake_case" });
    await migrate(db, { migrationsFolder: here("../migrations") });
    log("schema migrado");
    await db.execute(sql.raw(await readFile(here("../sql/rls.sql"), "utf8")));
    await db.execute(sql`SELECT app.assert_rls_coverage()`);
    log("RLS aplicado e verificado");
    const created = await seedPlans(db);
    log(`planos: ${created} novo(s)`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) {
    console.error("DATABASE_URL_OWNER não definida");
    process.exit(1);
  }
  migrateDatabase(url, { log: (m) => console.log(`[migrate] ${m}`) }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
