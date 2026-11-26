/**
 * Clientes da agência. Usuários do portal do cliente são `memberships` com role = 'cliente'
 * e `clientId` apontando para cá.
 *
 * Campos calculados da spec (horas contratadas/investidas/restantes, nº de projetos) NÃO são
 * colunas: vêm de consultas sobre project_contract_items, time_entries e projects.
 */
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, softDelete, tenantUnique, timestamps } from "./_columns";
import { tenantId } from "./tenants";

export const clients = pgTable(
  "clients",
  {
    id: pk(),
    tenantId: tenantId(),
    /** Código curto do cliente (ex.: "ACME"), único no tenant. */
    code: text().notNull(),
    name: text().notNull(),
    email: text(),
    phone: text(),
    /** CPF ou CNPJ, só dígitos. */
    document: text(),
    notes: text(),
    assetsLink: text(),
    active: boolean().notNull().default(true),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    tenantUnique("clients_tenant_id_uq", t),
    uniqueIndex("clients_tenant_code_uq")
      .on(t.tenantId, sql`upper(${t.code})`)
      .where(sql`${t.deletedAt} IS NULL`),
    index("clients_tenant_name_idx").on(t.tenantId, t.name),
  ],
);
