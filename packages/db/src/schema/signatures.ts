/**
 * Assinatura eletrônica (§5 "E-signature").
 * Rotas públicas `/assinar/:token` e `/verificar/:code` não têm sessão nem tenant: elas
 * resolvem o tenant via funções SECURITY DEFINER (`app.resolve_signer`,
 * `app.resolve_signature_code`) e só então abrem a transação com o contexto do tenant.
 */
import { sql } from "drizzle-orm";
import { check, index, inet, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pk, tenantUnique, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { signatureStatus } from "./enums";
import { files } from "./files";
import { projects } from "./projects";
import { tenantId } from "./tenants";

export const signatureRequests = pgTable(
  "signature_requests",
  {
    id: pk(),
    tenantId: tenantId(),
    projectId: uuid(),
    title: text().notNull(),
    documentFileId: uuid().notNull(),
    /** PDF final (documento + página de certificado), gerado pelo Gotenberg. */
    signedFileId: uuid(),
    documentSha256: text().notNull(),
    signedSha256: text(),
    status: signatureStatus().notNull().default("rascunho"),
    /** Código público de verificação de autenticidade. Único na plataforma. */
    verificationCode: text().notNull(),
    message: text(),
    sentAt: tstz(),
    completedAt: tstz(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    tenantUnique("signature_requests_tenant_id_uq", t),
    tfk("signature_requests_project_fk", t, t.projectId, projects),
    tfk("signature_requests_document_fk", t, t.documentFileId, files),
    tfk("signature_requests_signed_fk", t, t.signedFileId, files),
    uniqueIndex("signature_requests_code_uq").on(t.verificationCode),
    index("signature_requests_project_idx").on(t.tenantId, t.projectId),
  ],
);

export const signers = pgTable(
  "signers",
  {
    id: pk(),
    tenantId: tenantId(),
    requestId: uuid().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    /** Se o signatário for um usuário do portal. */
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Guardamos só o SHA-256 do token do link (o token em si só existe no e-mail). */
    tokenHash: text().notNull(),
    signingOrder: integer().notNull().default(0),
    viewedAt: tstz(),
    signedAt: tstz(),
    refusedAt: tstz(),
    refuseReason: text(),
    ip: inet(),
    userAgent: text(),
    ...timestamps,
  },
  (t) => [
    tfk("signers_request_fk", t, t.requestId, signatureRequests).onDelete("cascade"),
    uniqueIndex("signers_token_hash_uq").on(t.tokenHash),
    index("signers_request_idx").on(t.tenantId, t.requestId),
    check("signers_not_both", sql`${t.signedAt} IS NULL OR ${t.refusedAt} IS NULL`),
  ],
);
