/**
 * Tenants (workspaces) e vínculos de usuários.
 *
 * Better Auth organization plugin mapeado:
 *   organization → tenants, member → memberships (organizationId → tenantId),
 *   invitation → invitations. Campos extras entram via `additionalFields`.
 *
 * Os campos de perfil da §3 (cargo, nível, vínculo, setor, custo/hora…) ficam em
 * `memberships`, não em `users`: a mesma pessoa pode ter cargo e custo diferentes em
 * cada tenant, e o admin de um tenant não deve editar dados vistos por outro.
 *
 * Nomes da spec → nomes no código:
 *   cargo → jobTitle · nivel → level · vinculo → employmentType · setor → sectorId
 *   funcaoPadrao → defaultTaskRoleId · ehAtendente → isAccountManager · custoHora → hourlyCostCents
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cents, pk, tenantUnique, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { employmentType, seniorityLevel, tenantRole } from "./enums";
import { tenantId, tenants } from "./tenants";
import { clients } from "./clients";
import { sectors, taskRoles } from "./catalogs";
import { files } from "./files";

/** Horário comercial: usado no cálculo de horas úteis (timer, SLA de cobrança). */
export type BusinessHours = {
  /** 0 = domingo … 6 = sábado; intervalos "HH:mm" no fuso do membro/tenant. */
  days: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, { start: string; end: string }[]>>;
};

export const memberships = pgTable(
  "memberships",
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: tenantRole().notNull(),
    /** Só para role = 'cliente': de qual cliente este usuário do portal é. */
    clientId: uuid(),
    active: boolean().notNull().default(true),
    deactivatedAt: tstz(),

    // Perfil de trabalho (§3)
    jobTitle: text(),
    level: seniorityLevel(),
    employmentType: employmentType(),
    sectorId: uuid(),
    defaultTaskRoleId: uuid(),
    isAccountManager: boolean().notNull().default(false),
    hourlyCostCents: cents(),
    phone: text(),
    whatsapp: text(),
    birthday: date(),
    hireDate: date(),
    avatarFileId: uuid(),
    /** NULL = herda o fuso/horário do tenant. */
    timezone: text(),
    businessHours: jsonb().$type<BusinessHours>(),
    /** Peso opcional p/ produtividade, preenchido no Fase 8 se necessário. */
    productivityWeight: real(),
    ...timestamps,
  },
  (t) => [
    tenantUnique("memberships_tenant_id_uq", t),
    uniqueIndex("memberships_tenant_user_uq").on(t.tenantId, t.userId),
    index("memberships_user_idx").on(t.userId),
    tfk("memberships_client_fk", t, t.clientId, clients),
    tfk("memberships_sector_fk", t, t.sectorId, sectors),
    tfk("memberships_task_role_fk", t, t.defaultTaskRoleId, taskRoles),
    tfk("memberships_avatar_fk", t, t.avatarFileId, files),
    check(
      "memberships_cliente_has_client",
      sql`(${t.role} = 'cliente') = (${t.clientId} IS NOT NULL)`,
    ),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: pk(),
    tenantId: tenantId(),
    email: text().notNull(),
    role: tenantRole().notNull(),
    clientId: uuid(),
    /** pending | accepted | rejected | canceled (texto livre, controlado pelo Better Auth). */
    status: text().notNull().default("pending"),
    expiresAt: tstz().notNull(),
    inviterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    index("invitations_tenant_idx").on(t.tenantId, t.status),
    index("invitations_email_idx").on(sql`lower(${t.email})`),
    tfk("invitations_client_fk", t, t.clientId, clients),
  ],
);

// ── Configurações do tenant ──────────────────────────────────────────────────

export type TenantBranding = {
  logoFileId?: string;
  logoScale?: number;
  faviconFileId?: string;
  primaryColor?: string;
  secondaryColor?: string;
  chatColor?: string;
};
export type TenantAiConfig = {
  enabled: boolean;
  assistantName?: string;
  avatarFileId?: string;
  /** Provedor compatível com OpenAI; NULL = padrão da plataforma. */
  baseUrl?: string;
  model?: string;
};
export type TenantOperationSettings = {
  /** SLA de cobrança do cliente (coluna aguardando_cliente), em horas úteis. */
  clientChaseSlaBusinessHours: number;
  /** "Card parado" para a penalidade de atendimento (padrão 48h). */
  idleCardHours: number;
  /** Feriados nacionais/estaduais a importar da BrasilAPI. */
  holidayImport: { national: boolean; states: string[] };
  defaultBusinessHours: BusinessHours;
};
export type BackupSchedule = {
  enabled: boolean;
  everyNDays: number;
  /** "HH:mm" no fuso do tenant. */
  at: string;
  format: "json" | "csv";
  /** Entrega opcional (os segredos ficam em tenant_secrets). */
  destination?: { kind: "webhook" | "s3"; url?: string; bucket?: string; prefix?: string };
};
export type ProductivityWeights = {
  production: {
    perPiece: number;
    perBusinessHour: number;
    onTimeBonus: number;
    reworkPenalty: number;
  };
  accountManagement: {
    perClientChase: number;
    perShootBooked: number;
    perPiece: number;
    perIdleCard: number;
    idleCardPenaltyCap: number;
  };
};

/** 1 linha por tenant. Nada aqui é segredo — segredos ficam em tenant_secrets. */
export const tenantSettings = pgTable("tenant_settings", {
  tenantId: uuid()
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  branding: jsonb().$type<TenantBranding>().notNull().default({}),
  ai: jsonb().$type<TenantAiConfig>().notNull().default({ enabled: false }),
  operation: jsonb().$type<TenantOperationSettings>().notNull(),
  backupSchedule: jsonb().$type<BackupSchedule>().notNull().default({
    enabled: false,
    everyNDays: 7,
    at: "03:00",
    format: "json",
  }),
  productivityWeights: jsonb().$type<ProductivityWeights>().notNull(),
  updatedAt: tstz()
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

/**
 * Segredos do tenant, separados das configurações para que nenhuma consulta de
 * "settings" (nem o portal do cliente) possa trazê-los por engano.
 * Criptografados na aplicação com AES-256-GCM (formato `v1:iv:tag:ciphertext`, base64);
 * a chave vem do ambiente. A API só devolve `keyConfigured: true/false`.
 */
export const tenantSecrets = pgTable("tenant_secrets", {
  tenantId: uuid()
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  aiApiKeyEnc: text(),
  backupDestinationSecretEnc: text(),
  updatedAt: tstz()
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
