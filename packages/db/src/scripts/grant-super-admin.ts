/**
 * Promove um usuário (já cadastrado) a super_admin da plataforma.
 *   pnpm --filter @recpm/db grant-super-admin pessoa@exemplo.com
 * Usa DATABASE_URL_OWNER. A pessoa precisa entrar de novo para o papel valer na sessão.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { users } from "../schema";

const email = process.argv[2]?.trim().toLowerCase();
const url = process.env.DATABASE_URL_OWNER;
if (!email || !url) {
  console.error("uso: grant-super-admin <email>   (com DATABASE_URL_OWNER definido)");
  process.exit(1);
}
const pool = new Pool({ connectionString: url });
const db = drizzle({ client: pool, casing: "snake_case" });
const rows = await db
  .update(users)
  .set({ role: "super_admin" })
  .where(eq(users.email, email))
  .returning({ id: users.id });
console.log(rows.length ? `ok: ${email} agora é super_admin` : `nenhum usuário com o e-mail ${email}`);
await pool.end();
process.exit(rows.length ? 0 : 1);
