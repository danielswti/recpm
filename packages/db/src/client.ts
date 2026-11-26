/**
 * Três pools, três papéis do Postgres (ver infra/postgres/init/01-roles.sql):
 *   appDb      → recpm_app      (RLS ligado; tudo passa por withTenant)
 *   authDb     → recpm_auth     (só o adapter do Better Auth)
 *   platformDb → recpm_platform (só rotas /platform/* do super_admin e webhooks de cobrança)
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const make = (url: string | undefined, name: string, max: number) => {
  if (!url) throw new Error(`${name} não configurada`);
  return drizzle({ client: new Pool({ connectionString: url, max }), schema, casing: "snake_case" });
};

export const createDbs = (env: NodeJS.ProcessEnv = process.env) => ({
  appDb: make(env.DATABASE_URL_APP, "DATABASE_URL_APP", 20),
  authDb: make(env.DATABASE_URL_AUTH, "DATABASE_URL_AUTH", 5),
  platformDb: make(env.DATABASE_URL_PLATFORM, "DATABASE_URL_PLATFORM", 3),
});

export { schema };
