/**
 * Upload de arquivos (§6.2 aba Arquivos, anexos de tarefa): URL pré-assinada → o navegador envia
 * direto ao bucket → `complete` confirma. Só arquivos `clean` podem ser baixados.
 *
 * Antivírus: com CLAMAV_HOST, o `complete` passa o objeto pelo ClamAV antes de liberar. Infectado →
 * apaga do bucket e marca `infected`; clamd fora do ar → `error` (o usuário pode tentar de novo).
 * Arquivos acima de 512 MB (vídeos brutos) e instalações sem ClamAV ficam `clean` sem varredura;
 * a lista de extensões bloqueadas vale sempre.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { schema } from "@recpm/db";
import { uploadRequestInput } from "@recpm/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Deps } from "../deps";
import { teamOnly } from "../lib/actor";
import { createClamdScanner, noScanner } from "../lib/antivirus";
import { AppError } from "../lib/errors";
import { router } from "../lib/router";
import { createStorage, type Storage } from "../lib/storage";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;
const tags = ["Arquivos"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const IdParam = z.object({ id: z.uuid() });

const FileInfo = z
  .object({
    id: z.uuid(),
    name: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    scanStatus: z.enum(["pending", "clean", "infected", "error"]),
  })
  .openapi("FileInfo");

/** Tipos que nunca aceitamos (executáveis e scripts). */
export const BLOCKED_FILE =
  /\.(exe|bat|cmd|com|msi|msp|scr|pif|cpl|hta|ps1|psm1|vbs|vbe|wsf|wsh|js|jse|jar|sh|dll|apk|lnk|reg)$/i;
const BLOCKED_MIME =
  /^application\/(x-msdownload|x-msdos-program|x-sh|java-archive|vnd\.android\.package-archive)$/i;

export const fileRoutes = (deps: Deps) => {
  const r = router();
  r.use("/files/*", requireTenant(deps.dbs), teamOnly, requirePermission("tasks.read"));
  let storage: Storage | null | undefined = deps.storage;
  const store = () => {
    if (storage === undefined) storage = createStorage(deps.env);
    if (!storage)
      throw new AppError(503, "STORAGE_DISABLED", "Upload de arquivos não configurado. Use um link externo.");
    return storage;
  };

  const scanner =
    deps.scanner ??
    (deps.env.CLAMAV_HOST ? createClamdScanner(deps.env.CLAMAV_HOST, deps.env.CLAMAV_PORT) : noScanner);

  return r
    .openapi(
      createRoute({
        method: "post",
        path: "/files/uploads",
        tags,
        summary: "Pedir URL de upload (confere o limite de armazenamento do plano)",
        request: {
          body: {
            content: { "application/json": { schema: z.object(uploadRequestInput.shape) } },
            required: true,
          },
        },
        responses: {
          201: ok(
            z.object({ fileId: z.uuid(), uploadUrl: z.string(), headers: z.record(z.string(), z.string()) }),
            "Criado",
          ),
        },
      }),
      async (c) => {
        const b = c.req.valid("json");
        if (BLOCKED_FILE.test(b.name) || BLOCKED_MIME.test(b.mimeType))
          throw new AppError(400, "FILE_TYPE_BLOCKED", "Este tipo de arquivo não é aceito.");
        const st = store();
        const { tenantId, userId } = c.var.tenant;
        const res = await c.var.tenant.tx(async (tx) => {
          const [plan] = await tx
            .select({ limits: s.plans.limits })
            .from(s.tenantSubscriptions)
            .innerJoin(s.plans, eq(s.plans.id, s.tenantSubscriptions.planId));
          const [{ used } = { used: 0 }] = await tx
            .select({ used: sql<number>`coalesce(sum(${s.files.sizeBytes}), 0)` })
            .from(s.files)
            .where(isNull(s.files.deletedAt));
          const limitBytes = (plan?.limits.storageGb ?? 0) * 1024 ** 3;
          if (Number(used) + b.sizeBytes > limitBytes)
            throw new AppError(
              402,
              "PLAN_STORAGE_LIMIT_REACHED",
              "Limite de armazenamento do plano atingido.",
            );
          const id = uuidv7();
          const now = new Date();
          const key = `t/${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
          await tx.insert(s.files).values({
            id,
            tenantId,
            storageKey: key,
            originalName: b.name,
            mimeType: b.mimeType,
            sizeBytes: b.sizeBytes,
            uploadedBy: userId,
          });
          return { id, key };
        });
        const up = await st.presignUpload(res.key, b.mimeType, b.sizeBytes);
        return c.json({ fileId: res.id, uploadUrl: up.url, headers: up.headers }, 201);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/files/{id}/complete",
        tags,
        summary: "Confirmar upload concluído",
        request: { params: IdParam },
        responses: { 200: ok(FileInfo) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const st = store();
        const file = await c.var.tenant.tx(async (tx) => {
          const [f] = await tx
            .select()
            .from(s.files)
            .where(and(eq(s.files.id, id), isNull(s.files.deletedAt)));
          if (!f || f.uploadedBy !== c.var.tenant.userId)
            throw new AppError(404, "NOT_FOUND", "Arquivo não encontrado.");
          return f;
        });
        const head = await st.head(file.storageKey);
        if (!head) throw new AppError(409, "UPLOAD_NOT_FOUND", "O envio do arquivo não terminou.");
        if (head.sizeBytes > file.sizeBytes)
          throw new AppError(409, "UPLOAD_SIZE_MISMATCH", "O arquivo enviado é maior que o informado.");
        let scanStatus: "clean" | "infected" | "error" = "clean";
        if (file.scanStatus !== "clean" && head.sizeBytes <= scanner.maxBytes) {
          try {
            const body = await st.stream(file.storageKey);
            const r = body ? await scanner.scan(body) : { status: "skipped" as const, reason: "vazio" };
            if (r.status === "infected") {
              scanStatus = "infected";
              deps.logger.warn({ fileId: id, signature: r.signature }, "upload infectado removido");
              await st.remove(file.storageKey);
            }
          } catch (err) {
            deps.logger.error({ err, fileId: id }, "antivírus indisponível");
            scanStatus = "error";
          }
        }
        const [f] = await c.var.tenant.tx((tx) =>
          tx
            .update(s.files)
            .set({ sizeBytes: head.sizeBytes, scanStatus })
            .where(eq(s.files.id, id))
            .returning(),
        );
        if (scanStatus === "infected")
          throw new AppError(
            422,
            "FILE_INFECTED",
            "O antivírus encontrou uma ameaça neste arquivo. Ele foi descartado.",
          );
        if (scanStatus === "error")
          throw new AppError(
            503,
            "SCAN_UNAVAILABLE",
            "Não foi possível verificar o arquivo agora. Tente de novo em instantes.",
          );
        return c.json(
          {
            id: f!.id,
            name: f!.originalName,
            mimeType: f!.mimeType,
            sizeBytes: f!.sizeBytes,
            scanStatus: f!.scanStatus,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/files/{id}/download",
        tags,
        summary: "Baixar (redireciona para URL temporária)",
        request: { params: IdParam },
        responses: { 302: { description: "Redireciona para o arquivo" } },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const st = store();
        const [f] = await c.var.tenant.tx((tx) =>
          tx
            .select()
            .from(s.files)
            .where(and(eq(s.files.id, id), isNull(s.files.deletedAt))),
        );
        if (!f) throw new AppError(404, "NOT_FOUND", "Arquivo não encontrado.");
        if (f.scanStatus !== "clean")
          throw new AppError(409, "FILE_NOT_AVAILABLE", "Arquivo ainda em verificação ou bloqueado.");
        return c.redirect(await st.presignDownload(f.storageKey, f.originalName), 302);
      },
    );
};
