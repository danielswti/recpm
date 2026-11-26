/**
 * Chaves de API públicas e trilhas de auditoria.
 */
import { index, inet, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { tenantId, tenants } from "./tenants";

/**
 * Formato exibido uma única vez: `pk_live_<prefix>_<secret>`.
 * Guardamos só o `prefix` (busca) e o hash do segredo (SHA-256 — o segredo tem 256 bits
 * aleatórios, então hash lento é desnecessário e deixaria cada request da API mais cara).
 * A chave herda as permissões de quem a criou (admin/gestor).
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text().notNull(),
    prefix: text().notNull(),
    hashedKey: text().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    lastUsedAt: tstz(),
    expiresAt: tstz(),
    revokedAt: tstz(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("api_keys_prefix_uq").on(t.prefix),
    index("api_keys_tenant_idx").on(t.tenantId),
  ],
);

export type AuditDetails = {
  from?: unknown;
  to?: unknown;
  fromLabel?: string;
  toLabel?: string;
  [k: string]: unknown;
};

/**
 * Auditoria do tenant (§6.15) — também serve como histórico da tarefa (entity = 'task').
 * Imutável para a aplicação: o papel recpm_app só tem SELECT/INSERT (sem UPDATE/DELETE).
 * Quando crescer, particionar por mês (`PARTITION BY RANGE (created_at)`).
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: pk(),
    tenantId: tenantId(),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    actorName: text(),
    actorRole: text(),
    /** Preenchido quando um super_admin está personificando alguém. */
    impersonatorId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** 'task' | 'project' | 'client' | 'installment' | … */
    entity: text().notNull(),
    entityId: uuid(),
    entityLabel: text(),
    /** 'create' | 'update' | 'delete' | 'status_change' | 'archive' | … */
    action: text().notNull(),
    details: jsonb().$type<AuditDetails>(),
    ip: inet(),
    userAgent: text(),
    requestId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    index("audit_logs_entity_idx").on(t.tenantId, t.entity, t.entityId, t.createdAt.desc()),
    index("audit_logs_actor_idx").on(t.tenantId, t.actorId, t.createdAt.desc()),
  ],
);

/** Ações do back office da plataforma (super_admin): suspender, trocar plano, personificar… */
export const platformAuditLogs = pgTable(
  "platform_audit_logs",
  {
    id: pk(),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    tenantId: uuid().references(() => tenants.id, { onDelete: "set null" }),
    action: text().notNull(),
    details: jsonb(),
    ip: inet(),
    createdAt: createdAt(),
  },
  (t) => [
    index("platform_audit_logs_created_idx").on(t.createdAt.desc()),
    index("platform_audit_logs_tenant_idx").on(t.tenantId, t.createdAt.desc()),
  ],
);

