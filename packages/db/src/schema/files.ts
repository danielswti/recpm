/**
 * Metadados de todo arquivo enviado (R2 em produção, MinIO em dev). O binário nunca fica no VPS.
 * Upload: a API emite URL pré-assinada → cliente envia direto ao bucket → API confirma e
 * enfileira o antivírus (ClamAV no worker). Só arquivos `clean` podem ser baixados.
 * Chave no bucket: `t/<tenantId>/<yyyy>/<mm>/<fileId>` (prefixo por tenant).
 * A soma de `sizeBytes` por tenant alimenta o limite `storageGb` do plano.
 */
import { bigint, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, softDelete, tenantUnique } from "./_columns";
import { users } from "./auth";
import { fileScanStatus } from "./enums";
import { tenantId } from "./tenants";

export const files = pgTable(
  "files",
  {
    id: pk(),
    tenantId: tenantId(),
    storageKey: text().notNull(),
    originalName: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    sha256: text(),
    scanStatus: fileScanStatus().notNull().default("pending"),
    uploadedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    ...softDelete,
  },
  (t) => [
    tenantUnique("files_tenant_id_uq", t),
    uniqueIndex("files_storage_key_uq").on(t.storageKey),
    index("files_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);
