/**
 * Tabelas de identidade usadas pelo Better Auth (núcleo + plugins twoFactor e admin).
 * São GLOBAIS (sem tenant_id): um usuário pode pertencer a vários tenants.
 *
 * Na Fase 1 os nomes de campos serão conferidos com `npx @better-auth/cli generate`;
 * os modelos são mapeados no config do Better Auth:
 *   user → users, session → sessions, account → accounts, verification → verifications,
 *   twoFactor → two_factors. (organization/member/invitation ficam em tenancy.ts.)
 *
 * O Better Auth acessa estas tabelas com o papel `recpm_auth` (ver sql/rls/01_roles.sql).
 * O papel da aplicação (`recpm_app`) só pode LER `users` (nome/avatar de colegas do mesmo tenant).
 */
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./_columns";

export const users = pgTable(
  "users",
  {
    id: pk(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    /** Plugin admin do Better Auth: 'user' | 'super_admin'. Papel de PLATAFORMA, não de tenant. */
    role: text().notNull().default("user"),
    banned: boolean().notNull().default(false),
    banReason: text(),
    banExpires: tstz(),
    twoFactorEnabled: boolean().notNull().default(false),
    /** Preferências pessoais (o tenant tem os próprios padrões; isto sobrescreve). */
    locale: text().notNull().default("pt-BR"),
    timezone: text().notNull().default("America/Sao_Paulo"),
    /** LGPD: aceite de termos e política no cadastro. */
    termsAcceptedAt: tstz(),
    privacyAcceptedAt: tstz(),
    /** Exclusão de conta = anonimização (os registros de trabalho continuam íntegros). */
    anonymizedAt: tstz(),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: tstz().notNull(),
    ipAddress: text(),
    userAgent: text(),
    /** Plugin organization: tenant ativo da sessão (`activeOrganizationId` mapeado). */
    activeTenantId: uuid(),
    /** Plugin admin: quem está personificando (auditado em platform_audit_logs). */
    impersonatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: tstz(),
    refreshTokenExpiresAt: tstz(),
    scope: text(),
    /** Hash argon2id (via @node-rs/argon2). Nunca texto puro. */
    password: text(),
    ...timestamps,
  },
  (t) => [
    index("accounts_user_idx").on(t.userId),
    uniqueIndex("accounts_provider_uq").on(t.providerId, t.accountId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: pk(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: tstz().notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const twoFactors = pgTable(
  "two_factors",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Criptografados pelo próprio Better Auth. */
    secret: text().notNull(),
    backupCodes: text().notNull(),
  },
  (t) => [uniqueIndex("two_factors_user_uq").on(t.userId)],
);
