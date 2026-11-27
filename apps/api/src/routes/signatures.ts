/**
 * Assinatura eletrônica (§5 "E-signature", aba Assinaturas do projeto).
 *
 * Equipe: cria o pedido (PDF + signatários), envia, reenvia o link, cancela.
 * Público (sem sessão): /public/sign/{token} para ver, assinar ou recusar, e
 * /public/verify/{code} para conferir a autenticidade. O token do link só existe no e-mail;
 * guardamos o SHA-256 dele. O tenant é descoberto por funções SECURITY DEFINER e só então
 * a transação abre com o contexto do tenant (RLS ligado).
 * Quando o último signatário assina, geramos o PDF final com a página de certificado.
 */
import { createHash } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createRoute, z } from "@hono/zod-openapi";
import {
  assertFeature,
  assertProjectAccess,
  audit,
  loadEntitlements,
  notify,
  systemActor,
} from "@recpm/core";
import { type AppTx, schema, withTenant } from "@recpm/db";
import { refuseInput, signatureRequestInput, signInput } from "@recpm/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { uuidv7 } from "uuidv7";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError } from "../lib/errors";
import { router } from "../lib/router";
import { createStorage, type Storage } from "../lib/storage";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";
import { buildSignedPdf, newSignerToken, newVerificationCode, sha256Hex } from "../services/signature-pdf";

const s = schema;
const tags = ["Assinaturas"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const IdParam = z.object({ id: z.uuid() });
const noContent = { 204: { description: "OK" } };
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const STATUSES = ["rascunho", "enviado", "assinado", "recusado", "cancelado"] as const;

const SignerOut = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  status: z.enum(["pendente", "visualizou", "assinou", "recusou"]),
  viewedAt: z.string().nullable(),
  signedAt: z.string().nullable(),
  refusedAt: z.string().nullable(),
  refuseReason: z.string().nullable(),
});
const RequestOut = z
  .object({
    id: z.uuid(),
    projectId: z.uuid().nullable(),
    title: z.string(),
    message: z.string().nullable(),
    status: z.enum(STATUSES),
    verificationCode: z.string(),
    documentFileId: z.uuid(),
    documentName: z.string(),
    documentSha256: z.string(),
    signedFileId: z.uuid().nullable(),
    signedSha256: z.string().nullable(),
    sentAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
    signers: z.array(SignerOut),
  })
  .openapi("SignatureRequest");

const signerStatus = (x: typeof s.signers.$inferSelect) =>
  x.signedAt ? "assinou" : x.refusedAt ? "recusou" : x.viewedAt ? "visualizou" : "pendente";
const signerOut = (x: typeof s.signers.$inferSelect) => ({
  id: x.id,
  name: x.name,
  email: x.email,
  status: signerStatus(x) as "pendente" | "visualizou" | "assinou" | "recusou",
  viewedAt: x.viewedAt?.toISOString() ?? null,
  signedAt: x.signedAt?.toISOString() ?? null,
  refusedAt: x.refusedAt?.toISOString() ?? null,
  refuseReason: x.refuseReason,
});

async function requestsOut(tx: AppTx, rows: (typeof s.signatureRequests.$inferSelect)[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const sg = await tx
    .select()
    .from(s.signers)
    .where(inArray(s.signers.requestId, ids))
    .orderBy(asc(s.signers.signingOrder), asc(s.signers.createdAt));
  const docs = await tx
    .select({ id: s.files.id, name: s.files.originalName })
    .from(s.files)
    .where(
      inArray(
        s.files.id,
        rows.map((r) => r.documentFileId),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    message: r.message,
    status: r.status,
    verificationCode: r.verificationCode,
    documentFileId: r.documentFileId,
    documentName: docs.find((d) => d.id === r.documentFileId)?.name ?? "documento.pdf",
    documentSha256: r.documentSha256,
    signedFileId: r.signedFileId,
    signedSha256: r.signedSha256,
    sentAt: r.sentAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    signers: sg.filter((x) => x.requestId === r.id).map(signerOut),
  }));
}

const normName = (n: string) =>
  n.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
/** IP do signatário: cabeçalho do proxy (Cloudflare/LB) ou, sem proxy, o endereço da conexão. */
const clientIp = (c: Context) => {
  const h = (k: string) => c.req.header(k);
  let raw = (h("cf-connecting-ip") ?? h("x-forwarded-for")?.split(",")[0] ?? h("x-real-ip") ?? "").trim();
  if (!raw)
    try {
      raw = (getConnInfo(c).remote.address ?? "").replace(/^::ffff:/, "");
    } catch {
      // sem socket (testes com app.request)
    }
  return /^[\d.]+$|^[\da-f:]+$/i.test(raw) && raw ? raw : null;
};

export const signatureRoutes = (deps: Deps) => {
  const r = router();
  const team = [requireTenant(deps.dbs), teamOnly, requirePermission("projects.read")] as const;
  r.use("/signatures", ...team);
  r.use("/signatures/*", ...team);
  r.use("/projects/:id/signatures", ...team);
  r.on(["POST", "PATCH", "DELETE"], ["/signatures", "/signatures/*"], requirePermission("projects.manage"));

  let storage: Storage | null | undefined = deps.storage;
  const store = () => {
    if (storage === undefined) storage = createStorage(deps.env);
    if (!storage)
      throw new AppError(503, "STORAGE_NOT_CONFIGURED", "Armazenamento de arquivos não configurado.");
    return storage;
  };
  const web = deps.env.WEB_URL.replace(/\/$/, "");

  const load = async (tx: AppTx, id: string) => {
    const [row] = await tx
      .select()
      .from(s.signatureRequests)
      .where(eq(s.signatureRequests.id, id))
      .for("update");
    if (!row) throw new AppError(404, "SIGNATURE_NOT_FOUND", "Pedido de assinatura não encontrado.");
    return row;
  };
  const one = async (tx: AppTx, id: string) => {
    const [row] = await tx.select().from(s.signatureRequests).where(eq(s.signatureRequests.id, id));
    return (await requestsOut(tx, [row!]))[0]!;
  };

  const sendLink = async (
    signer: { name: string; email: string },
    token: string,
    req: { title: string; message: string | null },
    workspace: string,
    from: string,
  ) => {
    const url = `${web}/assinar/${token}`;
    const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    await deps.mailer.send({
      to: signer.email,
      subject: `${workspace} pediu sua assinatura: ${req.title}`,
      text: `Olá, ${signer.name}.\n\n${from} (${workspace}) enviou "${req.title}" para você assinar.${req.message ? `\n\n${req.message}` : ""}\n\nAbrir e assinar: ${url}\n\nEste link é pessoal. Não encaminhe.`,
      html: `<p>Olá, ${esc(signer.name)}.</p><p>${esc(from)} (${esc(workspace)}) enviou <strong>${esc(req.title)}</strong> para você assinar.</p>${req.message ? `<p>${esc(req.message)}</p>` : ""}<p><a href="${esc(url)}">Abrir e assinar</a></p><p style="color:#64748b;font-size:12px">Este link é pessoal. Não encaminhe.</p>`,
    });
  };

  /** Resolve o link público (token → tenant, signatário, pedido). */
  const resolveToken = async (token: string) => {
    const res = await deps.dbs.appDb.execute<{ tenant_id: string; signer_id: string; request_id: string }>(
      sql`SELECT * FROM app.resolve_signer(${hashToken(token)})`,
    );
    const row = res.rows[0];
    if (!row)
      throw new AppError(
        404,
        "SIGNATURE_LINK_INVALID",
        "Link de assinatura inválido ou substituído por um mais novo.",
      );
    return row;
  };

  /** Monta o PDF final e fecha o pedido (chamado quando o último assina). */
  const complete = async (tenantId: string, requestId: string) => {
    const st = store();
    const info = await withTenant(deps.dbs.appDb, { tenantId, actor: "system" }, async (tx) => {
      const [req] = await tx.select().from(s.signatureRequests).where(eq(s.signatureRequests.id, requestId));
      const [doc] = await tx.select().from(s.files).where(eq(s.files.id, req!.documentFileId));
      const [ten] = await tx.select({ name: s.tenants.name }).from(s.tenants);
      const sg = await tx
        .select()
        .from(s.signers)
        .where(eq(s.signers.requestId, requestId))
        .orderBy(asc(s.signers.signedAt));
      return { req: req!, doc: doc!, workspace: ten?.name ?? "Rec PM", signers: sg };
    });
    const original = await st.get(info.doc.storageKey);
    if (!original)
      throw new AppError(
        409,
        "DOCUMENT_MISSING",
        "O documento original não foi encontrado no armazenamento.",
      );
    const completedAt = new Date();
    const pdf = await buildSignedPdf(original, {
      title: info.req.title,
      workspace: info.workspace,
      requestId,
      verificationCode: info.req.verificationCode,
      verifyUrl: `${web}/verificar/${info.req.verificationCode}`,
      documentSha256: info.req.documentSha256,
      completedAt,
      signers: info.signers.map((x) => ({
        name: x.name,
        email: x.email,
        signedAt: x.signedAt!,
        ip: x.ip,
        userAgent: x.userAgent,
      })),
    });
    const fileId = uuidv7();
    const now = new Date();
    const key = `t/${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${fileId}`;
    await st.put(key, pdf, "application/pdf");
    const signedSha256 = sha256Hex(pdf);
    const base = info.doc.originalName.replace(/\.pdf$/i, "");
    await withTenant(deps.dbs.appDb, { tenantId, actor: "system" }, async (tx) => {
      await tx.insert(s.files).values({
        id: fileId,
        tenantId,
        storageKey: key,
        originalName: `${base} (assinado).pdf`,
        mimeType: "application/pdf",
        sizeBytes: pdf.byteLength,
        sha256: signedSha256,
        scanStatus: "clean",
      });
      await tx
        .update(s.signatureRequests)
        .set({ status: "assinado", signedFileId: fileId, signedSha256, completedAt, updatedAt: now })
        .where(eq(s.signatureRequests.id, requestId));
      if (info.req.createdBy)
        await notify(tx, tenantId, [info.req.createdBy], {
          type: "assinatura_concluida",
          title: `Assinado por todos: ${info.req.title}`,
          message: `${info.signers.length} assinatura(s). Código ${info.req.verificationCode}.`,
          referenceType: info.req.projectId ? "signature" : undefined,
          referenceId: info.req.projectId ?? undefined,
        });
      await audit(tx, systemActor(tenantId), {
        entity: "signature_request",
        entityId: requestId,
        entityLabel: info.req.title,
        action: "signature.completed",
        details: { signedSha256 },
      });
    });
    for (const x of info.signers)
      await deps.mailer
        .send({
          to: x.email,
          subject: `Documento assinado por todos: ${info.req.title}`,
          text: `Todas as assinaturas de "${info.req.title}" foram concluídas.\n\nBaixe a via assinada pelo seu link pessoal, que continua valendo. Código de verificação: ${info.req.verificationCode}\nConferir: ${web}/verificar/${info.req.verificationCode}`,
          html: `<p>Todas as assinaturas de <strong>${info.req.title.replace(/[&<>"']/g, "")}</strong> foram concluídas.</p><p>Baixe a via assinada pelo seu link pessoal, que continua valendo.</p><p>Código de verificação: <strong>${info.req.verificationCode}</strong><br><a href="${web}/verificar/${info.req.verificationCode}">Conferir a autenticidade</a></p>`,
        })
        .catch((err) => deps.logger.warn({ err }, "falha ao avisar signatário"));
  };

  const PublicView = z.object({
    workspace: z.string(),
    title: z.string(),
    message: z.string().nullable(),
    status: z.enum(STATUSES),
    verificationCode: z.string(),
    documentName: z.string(),
    documentSha256: z.string(),
    signedSha256: z.string().nullable(),
    me: SignerOut.omit({ email: true }).extend({ email: z.string() }),
    signers: z.array(
      z.object({ name: z.string(), status: z.enum(["pendente", "visualizou", "assinou", "recusou"]) }),
    ),
  });
  const TokenParam = z.object({ token: z.string().min(20).max(100) });

  const publicView = async (token: string, markViewed: boolean) => {
    const ref = await resolveToken(token);
    return withTenant(deps.dbs.appDb, { tenantId: ref.tenant_id, actor: "system" }, async (tx) => {
      const [req] = await tx
        .select()
        .from(s.signatureRequests)
        .where(eq(s.signatureRequests.id, ref.request_id));
      if (!req || req.status === "rascunho")
        throw new AppError(404, "SIGNATURE_LINK_INVALID", "Link de assinatura inválido.");
      let [me] = await tx.select().from(s.signers).where(eq(s.signers.id, ref.signer_id));
      if (markViewed && !me!.viewedAt && req.status === "enviado")
        [me] = await tx
          .update(s.signers)
          .set({ viewedAt: new Date(), updatedAt: new Date() })
          .where(eq(s.signers.id, me!.id))
          .returning();
      const all = await tx
        .select()
        .from(s.signers)
        .where(eq(s.signers.requestId, req.id))
        .orderBy(asc(s.signers.signingOrder), asc(s.signers.createdAt));
      const [doc] = await tx.select().from(s.files).where(eq(s.files.id, req.documentFileId));
      const [signed] = req.signedFileId
        ? await tx.select().from(s.files).where(eq(s.files.id, req.signedFileId))
        : [];
      const [ten] = await tx.select({ name: s.tenants.name }).from(s.tenants);
      return {
        tenantId: ref.tenant_id,
        req,
        me: me!,
        doc: doc!,
        signed: signed ?? null,
        view: {
          workspace: ten?.name ?? "Rec PM",
          title: req.title,
          message: req.message,
          status: req.status,
          verificationCode: req.verificationCode,
          documentName: doc?.originalName ?? "documento.pdf",
          documentSha256: req.documentSha256,
          signedSha256: req.signedSha256,
          me: signerOut(me!),
          signers: all.map((x) => ({ name: x.name, status: signerStatus(x) as "pendente" })),
        },
      };
    });
  };

  return (
    r
      // ── equipe ──────────────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/projects/{id}/signatures",
          tags,
          summary: "Pedidos de assinatura do projeto",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ data: z.array(RequestOut) })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const data = await c.var.tenant.tx(async (tx) => {
            await assertProjectAccess(tx, actorOf(c), id);
            const rows = await tx
              .select()
              .from(s.signatureRequests)
              .where(eq(s.signatureRequests.projectId, id))
              .orderBy(desc(s.signatureRequests.createdAt));
            return requestsOut(tx, rows);
          });
          return c.json({ data }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/signatures",
          tags,
          summary: "Criar pedido de assinatura (rascunho) com um PDF e os signatários",
          request: body(signatureRequestInput),
          responses: { 201: ok(RequestOut, "Criado") },
        }),
        async (c) => {
          const b = c.req.valid("json");
          const t = c.var.tenant;
          const doc = await t.tx(async (tx) => {
            assertFeature(await loadEntitlements(tx), "eSignature");
            if (b.projectId) await assertProjectAccess(tx, actorOf(c), b.projectId);
            const [f] = await tx
              .select()
              .from(s.files)
              .where(and(eq(s.files.id, b.documentFileId), isNull(s.files.deletedAt)));
            if (!f) throw new AppError(400, "INVALID_REFERENCE", "Documento não encontrado.");
            if (f.mimeType !== "application/pdf")
              throw new AppError(400, "DOCUMENT_NOT_PDF", "Envie o documento em PDF.");
            if (f.scanStatus !== "clean")
              throw new AppError(409, "UPLOAD_NOT_FOUND", "O envio do documento não terminou.");
            return f;
          });
          const bytes = await store().get(doc.storageKey);
          if (!bytes) throw new AppError(409, "UPLOAD_NOT_FOUND", "O envio do documento não terminou.");
          if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
            throw new AppError(400, "DOCUMENT_NOT_PDF", "Envie o documento em PDF.");
          const out = await t.tx(async (tx) => {
            const [row] = await tx
              .insert(s.signatureRequests)
              .values({
                tenantId: t.tenantId,
                projectId: b.projectId ?? null,
                title: b.title,
                documentFileId: doc.id,
                documentSha256: sha256Hex(bytes),
                verificationCode: newVerificationCode(),
                message: b.message ?? null,
                createdBy: t.userId,
              })
              .returning();
            const emails = new Set<string>();
            await tx.insert(s.signers).values(
              b.signers
                .filter((x) => {
                  const k = x.email.toLowerCase();
                  if (emails.has(k)) return false;
                  emails.add(k);
                  return true;
                })
                .map((x, i) => ({
                  tenantId: t.tenantId,
                  requestId: row!.id,
                  name: x.name,
                  email: x.email.toLowerCase(),
                  // o link real nasce no envio; até lá, um hash que ninguém conhece
                  tokenHash: hashToken(newSignerToken()),
                  signingOrder: i,
                })),
            );
            await audit(tx, actorOf(c), {
              entity: "signature_request",
              entityId: row!.id,
              entityLabel: b.title,
              action: "signature.created",
              details: { signers: b.signers.length },
            });
            return one(tx, row!.id);
          });
          return c.json(out, 201);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/signatures/{id}/send",
          tags,
          summary: "Enviar para assinatura (um link pessoal por e-mail para cada signatário)",
          request: { params: IdParam },
          responses: { 200: ok(RequestOut) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const t = c.var.tenant;
          const sender = c.var.session?.user.name ?? "Alguém";
          const { out, links, workspace } = await t.tx(async (tx) => {
            assertFeature(await loadEntitlements(tx), "eSignature");
            const req = await load(tx, id);
            if (req.status !== "rascunho")
              throw new AppError(409, "SIGNATURE_ALREADY_SENT", "Este pedido já foi enviado.");
            const sg = await tx.select().from(s.signers).where(eq(s.signers.requestId, id));
            const links: { signer: (typeof sg)[number]; token: string }[] = [];
            for (const x of sg) {
              const token = newSignerToken();
              await tx
                .update(s.signers)
                .set({ tokenHash: hashToken(token) })
                .where(eq(s.signers.id, x.id));
              links.push({ signer: x, token });
            }
            await tx
              .update(s.signatureRequests)
              .set({ status: "enviado", sentAt: new Date(), updatedAt: new Date() })
              .where(eq(s.signatureRequests.id, id));
            await audit(tx, actorOf(c), {
              entity: "signature_request",
              entityId: id,
              entityLabel: req.title,
              action: "signature.sent",
            });
            const [ten] = await tx.select({ name: s.tenants.name }).from(s.tenants);
            return { out: await one(tx, id), links, workspace: ten?.name ?? "Rec PM" };
          });
          for (const l of links) await sendLink(l.signer, l.token, out, workspace, sender);
          return c.json(out, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/signatures/{id}/signers/{signerId}/resend",
          tags,
          summary: "Reenviar o link (o anterior deixa de valer)",
          request: { params: z.object({ id: z.uuid(), signerId: z.uuid() }) },
          responses: noContent,
        }),
        async (c) => {
          const { id, signerId } = c.req.valid("param");
          const t = c.var.tenant;
          const token = newSignerToken();
          const { signer, req, workspace } = await t.tx(async (tx) => {
            const req = await load(tx, id);
            if (req.status !== "enviado")
              throw new AppError(409, "SIGNATURE_NOT_OPEN", "Só dá para reenviar pedidos em andamento.");
            const [signer] = await tx
              .update(s.signers)
              .set({ tokenHash: hashToken(token), updatedAt: new Date() })
              .where(and(eq(s.signers.id, signerId), eq(s.signers.requestId, id), isNull(s.signers.signedAt)))
              .returning();
            if (!signer)
              throw new AppError(404, "SIGNER_NOT_FOUND", "Signatário não encontrado ou já assinou.");
            const [ten] = await tx.select({ name: s.tenants.name }).from(s.tenants);
            return { signer, req, workspace: ten?.name ?? "Rec PM" };
          });
          await sendLink(signer, token, req, workspace, c.var.session?.user.name ?? "Alguém");
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/signatures/{id}/cancel",
          tags,
          summary: "Cancelar o pedido (os links deixam de valer)",
          request: { params: IdParam },
          responses: { 200: ok(RequestOut) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const out = await c.var.tenant.tx(async (tx) => {
            const req = await load(tx, id);
            if (req.status === "assinado" || req.status === "cancelado")
              throw new AppError(409, "SIGNATURE_CLOSED", "Este pedido já foi encerrado.");
            await tx
              .update(s.signatureRequests)
              .set({ status: "cancelado", updatedAt: new Date() })
              .where(eq(s.signatureRequests.id, id));
            await audit(tx, actorOf(c), {
              entity: "signature_request",
              entityId: id,
              entityLabel: req.title,
              action: "signature.canceled",
            });
            return one(tx, id);
          });
          return c.json(out, 200);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/signatures/{id}",
          tags,
          summary: "Apagar rascunho",
          request: { params: IdParam },
          responses: noContent,
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          await c.var.tenant.tx(async (tx) => {
            const req = await load(tx, id);
            if (req.status !== "rascunho")
              throw new AppError(
                409,
                "SIGNATURE_ALREADY_SENT",
                "Pedido enviado não pode ser apagado. Cancele-o.",
              );
            await tx.delete(s.signatureRequests).where(eq(s.signatureRequests.id, id));
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/signatures/{id}/download",
          tags,
          summary: "Baixar o PDF (assinado, quando houver; senão o original)",
          request: { params: IdParam, query: z.object({ original: z.stringbool().optional() }) },
          responses: { 302: { description: "Redireciona para o arquivo" } },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const q = c.req.valid("query");
          const f = await c.var.tenant.tx(async (tx) => {
            const [req] = await tx.select().from(s.signatureRequests).where(eq(s.signatureRequests.id, id));
            if (!req) throw new AppError(404, "SIGNATURE_NOT_FOUND", "Pedido de assinatura não encontrado.");
            if (req.projectId) await assertProjectAccess(tx, actorOf(c), req.projectId);
            const fileId = !q.original && req.signedFileId ? req.signedFileId : req.documentFileId;
            const [f] = await tx.select().from(s.files).where(eq(s.files.id, fileId));
            return f!;
          });
          return c.redirect(await store().presignDownload(f.storageKey, f.originalName), 302);
        },
      )
      // ── público ─────────────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/public/sign/{token}",
          tags,
          summary: "Página do signatário (marca como visualizado)",
          request: { params: TokenParam },
          responses: { 200: ok(PublicView) },
        }),
        async (c) => {
          const { token } = c.req.valid("param");
          const v = await publicView(token, true);
          return c.json(v.view, 200);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/public/sign/{token}/document",
          tags,
          summary: "Baixar o documento (a via assinada, depois que todos assinarem)",
          request: { params: TokenParam },
          responses: { 302: { description: "Redireciona para o arquivo" } },
        }),
        async (c) => {
          const { token } = c.req.valid("param");
          const v = await publicView(token, false);
          if (v.req.status === "cancelado")
            throw new AppError(410, "SIGNATURE_CLOSED", "Este pedido foi cancelado.");
          const f = v.signed ?? v.doc;
          return c.redirect(await store().presignDownload(f.storageKey, f.originalName), 302);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/public/sign/{token}/sign",
          tags,
          summary: "Assinar (digitando o próprio nome)",
          request: { params: TokenParam, ...body(signInput) },
          responses: { 200: ok(PublicView) },
        }),
        async (c) => {
          const { token } = c.req.valid("param");
          const b = c.req.valid("json");
          const ref = await resolveToken(token);
          const ip = clientIp(c);
          const ua = c.req.header("user-agent")?.slice(0, 400) ?? null;
          const allSigned = await withTenant(
            deps.dbs.appDb,
            { tenantId: ref.tenant_id, actor: "system" },
            async (tx) => {
              const req = await load(tx, ref.request_id);
              if (req.status !== "enviado")
                throw new AppError(
                  409,
                  "SIGNATURE_CLOSED",
                  "Este pedido não está mais aberto para assinatura.",
                );
              const [me] = await tx
                .select()
                .from(s.signers)
                .where(eq(s.signers.id, ref.signer_id))
                .for("update");
              if (me!.signedAt || me!.refusedAt)
                throw new AppError(409, "ALREADY_ANSWERED", "Você já respondeu a este pedido.");
              if (normName(b.typedName) !== normName(me!.name))
                throw new AppError(
                  400,
                  "NAME_MISMATCH",
                  "Digite seu nome exatamente como aparece no pedido.",
                );
              const now = new Date();
              await tx
                .update(s.signers)
                .set({ signedAt: now, viewedAt: me!.viewedAt ?? now, ip, userAgent: ua, updatedAt: now })
                .where(eq(s.signers.id, me!.id));
              await audit(
                tx,
                { ...systemActor(ref.tenant_id), name: me!.name, ip },
                {
                  entity: "signature_request",
                  entityId: req.id,
                  entityLabel: req.title,
                  action: "signature.signed",
                  details: { signer: me!.email },
                },
              );
              const [left] = await tx
                .select({ n: sql<number>`count(*)::int` })
                .from(s.signers)
                .where(and(eq(s.signers.requestId, req.id), isNull(s.signers.signedAt)));
              return !left?.n;
            },
          );
          if (allSigned) await complete(ref.tenant_id, ref.request_id);
          return c.json((await publicView(token, false)).view, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/public/sign/{token}/refuse",
          tags,
          summary: "Recusar (encerra o pedido)",
          request: { params: TokenParam, ...body(refuseInput) },
          responses: { 200: ok(PublicView) },
        }),
        async (c) => {
          const { token } = c.req.valid("param");
          const b = c.req.valid("json");
          const ref = await resolveToken(token);
          const ip = clientIp(c);
          await withTenant(deps.dbs.appDb, { tenantId: ref.tenant_id, actor: "system" }, async (tx) => {
            const req = await load(tx, ref.request_id);
            if (req.status !== "enviado")
              throw new AppError(
                409,
                "SIGNATURE_CLOSED",
                "Este pedido não está mais aberto para assinatura.",
              );
            const [me] = await tx
              .select()
              .from(s.signers)
              .where(eq(s.signers.id, ref.signer_id))
              .for("update");
            if (me!.signedAt || me!.refusedAt)
              throw new AppError(409, "ALREADY_ANSWERED", "Você já respondeu a este pedido.");
            const now = new Date();
            await tx
              .update(s.signers)
              .set({
                refusedAt: now,
                refuseReason: b.reason,
                viewedAt: me!.viewedAt ?? now,
                ip,
                userAgent: c.req.header("user-agent")?.slice(0, 400) ?? null,
                updatedAt: now,
              })
              .where(eq(s.signers.id, me!.id));
            await tx
              .update(s.signatureRequests)
              .set({ status: "recusado", completedAt: now, updatedAt: now })
              .where(eq(s.signatureRequests.id, req.id));
            if (req.createdBy)
              await notify(tx, ref.tenant_id, [req.createdBy], {
                type: "assinatura_recusada",
                title: `${me!.name} recusou: ${req.title}`,
                message: b.reason,
                referenceType: req.projectId ? "signature" : undefined,
                referenceId: req.projectId ?? undefined,
              });
            await audit(
              tx,
              { ...systemActor(ref.tenant_id), name: me!.name, ip },
              {
                entity: "signature_request",
                entityId: req.id,
                entityLabel: req.title,
                action: "signature.refused",
                details: { signer: me!.email, reason: b.reason },
              },
            );
          });
          return c.json((await publicView(token, false)).view, 200);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/public/verify/{code}",
          tags,
          summary: "Conferir a autenticidade de um documento pelo código",
          request: { params: z.object({ code: z.string().min(6).max(20) }) },
          responses: {
            200: ok(
              z.object({
                workspace: z.string(),
                title: z.string(),
                status: z.enum(STATUSES),
                documentSha256: z.string(),
                signedSha256: z.string().nullable(),
                sentAt: z.string().nullable(),
                completedAt: z.string().nullable(),
                signers: z.array(
                  z.object({
                    name: z.string(),
                    email: z.string(),
                    status: z.enum(["pendente", "visualizou", "assinou", "recusou"]),
                    signedAt: z.string().nullable(),
                  }),
                ),
              }),
            ),
          },
        }),
        async (c) => {
          const code = c.req
            .valid("param")
            .code.toUpperCase()
            .replace(/[^A-Z0-9]/g, "");
          const pretty = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
          const res = await deps.dbs.appDb.execute<{ tenant_id: string; request_id: string }>(
            sql`SELECT * FROM app.resolve_signature_code(${pretty})`,
          );
          const ref = res.rows[0];
          if (!ref) throw new AppError(404, "SIGNATURE_CODE_NOT_FOUND", "Nenhum documento com este código.");
          const out = await withTenant(
            deps.dbs.appDb,
            { tenantId: ref.tenant_id, actor: "system" },
            async (tx) => {
              const [req] = await tx
                .select()
                .from(s.signatureRequests)
                .where(eq(s.signatureRequests.id, ref.request_id));
              if (!req || req.status === "rascunho")
                throw new AppError(404, "SIGNATURE_CODE_NOT_FOUND", "Nenhum documento com este código.");
              const sg = await tx
                .select()
                .from(s.signers)
                .where(eq(s.signers.requestId, req.id))
                .orderBy(asc(s.signers.signingOrder));
              const [ten] = await tx.select({ name: s.tenants.name }).from(s.tenants);
              // e-mail mascarado: a página é pública
              const mask = (e: string) => {
                const [u, d] = e.split("@");
                return `${u!.slice(0, 2)}${"•".repeat(Math.max(1, u!.length - 2))}@${d}`;
              };
              return {
                workspace: ten?.name ?? "Rec PM",
                title: req.title,
                status: req.status,
                documentSha256: req.documentSha256,
                signedSha256: req.signedSha256,
                sentAt: req.sentAt?.toISOString() ?? null,
                completedAt: req.completedAt?.toISOString() ?? null,
                signers: sg.map((x) => ({
                  name: x.name,
                  email: mask(x.email),
                  status: signerStatus(x) as "pendente",
                  signedAt: x.signedAt?.toISOString() ?? null,
                })),
              };
            },
          );
          return c.json(out, 200);
        },
      )
  );
};
