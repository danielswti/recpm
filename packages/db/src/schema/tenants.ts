/**
 * Tabela raiz da multi-tenancy (organization do Better Auth) e a coluna `tenant_id` padrão.
 * Fica isolada num arquivo sem dependências para evitar import circular.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pk, softDelete, timestamps } from "./_columns";
import { tenantStatus } from "./enums";

export const tenants = pgTable(
  "tenants",
  {
    id: pk(),
    name: text().notNull(),
    slug: text().notNull(),
    /** Campo exigido pelo Better Auth; a identidade visual completa fica em tenant_settings.branding. */
    logo: text(),
    metadata: text(),
    status: tenantStatus().notNull().default("active"),
    /** Subdomínio próprio (planos superiores). */
    customDomain: text(),
    locale: text().notNull().default("pt-BR"),
    currency: text().notNull().default("BRL"),
    timezone: text().notNull().default("America/Sao_Paulo"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex("tenants_slug_uq").on(t.slug),
    uniqueIndex("tenants_custom_domain_uq").on(sql`lower(${t.customDomain})`),
  ],
);

/** Coluna `tenant_id` padrão: obrigatória e apagada em cascata com o tenant. */
export const tenantId = () =>
  uuid()
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
