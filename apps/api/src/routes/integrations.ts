/**
 * Integrações do workspace (§6.13–§6.15):
 *   /settings/webhooks           webhooks de saída (plano com `outgoingWebhooks`), segredo exibido uma vez
 *   /settings/webhooks/{id}/…    teste, últimas entregas e nova tentativa
 *   /settings/backup             agenda da exportação de dados
 *   /exports                     "Exportar agora", lista e download
 *   /audit                       log de auditoria (somente leitura, filtros por pessoa, entidade, ação e data)
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { createRoute, z } from "@hono/zod-openapi";
import { assertFeature, audit, loadEntitlements, tenantTimezone, zonedToUtc } from "@recpm/core";
import { type AppTx, schema } from "@recpm/db";
import { and, count, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError } from "../lib/errors";
import { router } from "../lib/router";
import { encryptSecret, secretsKey } from "../lib/secrets";
import { createStorage } from "../lib/storage";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const IdParam = z.object({ id: z.uuid() });

export const WEBHOOK_EVENTS = [
  "task.created",
  "task.status_changed",
  "task.completed",
  "project.created",
  "installment.paid",
] as const;

/** Bloqueia destinos internos (SSRF) em produção; fora dela, http e localhost valem para testar. */
export function checkWebhookUrl(raw: string, production: boolean) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError(400, "INVALID_URL", "URL inválida.");
  }
  if (u.username || u.password) throw new AppError(400, "INVALID_URL", "A URL não pode ter usuário e senha.");
  if (!production) {
    if (u.protocol !== "https:" && u.protocol !== "http:")
      throw new AppError(400, "INVALID_URL", "Use uma URL http(s).");
    return u.toString();
  }
  if (u.protocol !== "https:") throw new AppError(400, "INVALID_URL", "Use uma URL https.");
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateV4 =
    /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    (isIP(h) === 4 && privateV4.test(h)) ||
    (isIP(h) === 6 && (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")))
  )
    throw new AppError(400, "INVALID_URL", "Endereços internos não são permitidos.");
  return u.toString();
}

const Webhook = z
  .object({
    id: z.uuid(),
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
    active: z.boolean(),
    createdAt: z.string(),
    lastDelivery: z
      .object({ status: z.string(), at: z.string(), responseStatus: z.number().nullable() })
      .nullable(),
  })
  .openapi("Webhook");
const WebhookInput = z.object({
  url: z.string().trim().min(1).max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  active: z.boolean().optional(),
});
const Delivery = z
  .object({
    id: z.uuid(),
    event: z.string(),
    status: z.enum(["pending", "running", "succeeded", "failed"]),
    attempts: z.number(),
    responseStatus: z.number().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    deliveredAt: z.string().nullable(),
    nextAttemptAt: z.string().nullable(),
  })
  .openapi("WebhookDelivery");

const Backup = z
  .object({
    enabled: z.boolean(),
    everyNDays: z.number().int().min(1).max(90),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    format: z.enum(["json", "csv"]),
    webhookUrl: z.string().max(2000).nullable(),
  })
  .openapi("BackupSchedule");
const Export = z
  .object({
    id: z.uuid(),
    trigger: z.enum(["manual", "schedule"]),
    format: z.string(),
    status: z.enum(["pending", "running", "succeeded", "failed"]),
    requestedBy: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    error: z.string().nullable(),
    sizeBytes: z.number().nullable(),
  })
  .openapi("DataExport");

const AuditRow = z
  .object({
    id: z.uuid(),
    createdAt: z.string(),
    actor: z.object({ id: z.string().nullable(), name: z.string().nullable(), role: z.string().nullable() }),
    impersonated: z.boolean(),
    entity: z.string(),
    entityId: z.string().nullable(),
    entityLabel: z.string().nullable(),
    action: z.string(),
    details: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
  })
  .openapi("AuditLog");

export const integrationRoutes = (deps: Deps) => {
  const r = router();
  const production = deps.env.NODE_ENV === "production";
  const storage = deps.storage === undefined ? createStorage(deps.env) : deps.storage;
  const tenant = [requireTenant(deps.dbs), teamOnly] as const;
  r.use("/settings/webhooks", ...tenant, requirePermission("tenant.settings"));
  r.use("/settings/webhooks/*", ...tenant, requirePermission("tenant.settings"));
  r.use("/settings/backup", ...tenant, requirePermission("tenant.export"));
  r.use("/exports", ...tenant, requirePermission("tenant.export"));
  r.use("/exports/*", ...tenant, requirePermission("tenant.export"));
  r.use("/audit", ...tenant, requirePermission("tenant.audit"));
  r.use("/audit/*", ...tenant, requirePermission("tenant.audit"));

  const webhookOut = async (tx: AppTx, ids?: string[]) => {
    const eps = await tx
      .select()
      .from(s.webhookEndpoints)
      .where(ids ? inArray(s.webhookEndpoints.id, ids) : undefined)
      .orderBy(desc(s.webhookEndpoints.createdAt));
    if (!eps.length) return [];
    const last = await tx.execute<{
      endpoint_id: string;
      status: string;
      at: Date;
      response_status: number | null;
    }>(sql`
      SELECT DISTINCT ON (endpoint_id) endpoint_id, status, coalesce(delivered_at, created_at) AS at, response_status
        FROM webhook_deliveries
       WHERE endpoint_id IN (${sql.join(
         eps.map((e) => sql`${e.id}::uuid`),
         sql`, `,
       )})
       ORDER BY endpoint_id, created_at DESC`);
    return eps.map((e) => {
      const l = last.rows.find((x) => x.endpoint_id === e.id);
      return {
        id: e.id,
        url: e.url,
        events: e.events as (typeof WEBHOOK_EVENTS)[number][],
        active: e.active,
        createdAt: e.createdAt.toISOString(),
        lastDelivery: l
          ? { status: l.status, at: new Date(l.at).toISOString(), responseStatus: l.response_status }
          : null,
      };
    });
  };

  const backupOut = (b: typeof s.tenantSettings.$inferSelect.backupSchedule) => ({
    enabled: b.enabled,
    everyNDays: b.everyNDays,
    at: b.at,
    format: b.format,
    webhookUrl: b.destination?.kind === "webhook" ? (b.destination.url ?? null) : null,
  });

  return (
    r
      // ── Webhooks ─────────────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/settings/webhooks",
          tags: ["Webhooks"],
          summary: "Webhooks de saída",
          responses: {
            200: ok(
              z.object({ data: z.array(Webhook), available: z.boolean(), events: z.array(z.string()) }),
            ),
          },
        }),
        async (c) => {
          const out = await c.var.tenant.tx(async (tx) => ({
            data: await webhookOut(tx),
            available: (await loadEntitlements(tx)).features.outgoingWebhooks,
          }));
          return c.json({ ...out, events: [...WEBHOOK_EVENTS] }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/settings/webhooks",
          tags: ["Webhooks"],
          summary: "Criar webhook (o segredo de assinatura aparece só nesta resposta)",
          request: body(WebhookInput),
          responses: { 201: ok(Webhook.extend({ secret: z.string() }), "Criado") },
        }),
        async (c) => {
          const b = c.req.valid("json");
          const url = checkWebhookUrl(b.url, production);
          const secret = `whsec_${randomBytes(24).toString("base64url")}`;
          const out = await c.var.tenant.tx(async (tx) => {
            assertFeature(await loadEntitlements(tx), "outgoingWebhooks");
            const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(s.webhookEndpoints);
            if (n >= 10) throw new AppError(409, "WEBHOOK_LIMIT", "Limite de 10 webhooks por workspace.");
            const [w] = await tx
              .insert(s.webhookEndpoints)
              .values({
                tenantId: c.var.tenant.tenantId,
                url,
                secretEnc: encryptSecret(secret, secretsKey(deps.env)),
                events: [...new Set(b.events)],
                active: b.active ?? true,
                createdBy: c.var.tenant.userId,
              })
              .returning();
            await audit(tx, actorOf(c), {
              entity: "webhook",
              entityId: w!.id,
              entityLabel: url,
              action: "create",
            });
            return (await webhookOut(tx, [w!.id]))[0]!;
          });
          return c.json({ ...out, secret }, 201);
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/settings/webhooks/{id}",
          tags: ["Webhooks"],
          summary: "Alterar URL, eventos ou ligar/desligar",
          request: { params: IdParam, ...body(WebhookInput.partial()) },
          responses: { 200: ok(Webhook) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const b = c.req.valid("json");
          const url = b.url === undefined ? undefined : checkWebhookUrl(b.url, production);
          const out = await c.var.tenant.tx(async (tx) => {
            if (b.active || url) assertFeature(await loadEntitlements(tx), "outgoingWebhooks");
            const [w] = await tx
              .update(s.webhookEndpoints)
              .set({
                ...(url ? { url } : {}),
                ...(b.events ? { events: [...new Set(b.events)] } : {}),
                ...(b.active === undefined ? {} : { active: b.active }),
              })
              .where(eq(s.webhookEndpoints.id, id))
              .returning();
            if (!w) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook não encontrado.");
            await audit(tx, actorOf(c), {
              entity: "webhook",
              entityId: id,
              entityLabel: w.url,
              action: "update",
              details: { ...b },
            });
            return (await webhookOut(tx, [id]))[0]!;
          });
          return c.json(out, 200);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/settings/webhooks/{id}",
          tags: ["Webhooks"],
          summary: "Remover webhook (e o histórico de entregas)",
          request: { params: IdParam },
          responses: { 204: { description: "Removido" } },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          await c.var.tenant.tx(async (tx) => {
            const [w] = await tx.delete(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, id)).returning();
            if (!w) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook não encontrado.");
            await audit(tx, actorOf(c), {
              entity: "webhook",
              entityId: id,
              entityLabel: w.url,
              action: "delete",
            });
          });
          return c.body(null, 204);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/settings/webhooks/{id}/test",
          tags: ["Webhooks"],
          summary: "Enviar um evento de teste (webhook.test)",
          request: { params: IdParam },
          responses: { 202: ok(Delivery, "Na fila") },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const d = await c.var.tenant.tx(async (tx) => {
            assertFeature(await loadEntitlements(tx), "outgoingWebhooks");
            const [w] = await tx.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, id));
            if (!w) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook não encontrado.");
            if (!w.active) throw new AppError(409, "WEBHOOK_INACTIVE", "Ative o webhook para testar.");
            const [row] = await tx
              .insert(s.webhookDeliveries)
              .values({
                tenantId: c.var.tenant.tenantId,
                endpointId: id,
                event: "webhook.test",
                payload: { message: "Teste do Rec PM", sentBy: c.var.session?.user.name ?? null },
                status: "pending",
                nextAttemptAt: new Date(),
              })
              .returning();
            await tx.execute(sql`SELECT pg_notify('recpm_webhooks', ${c.var.tenant.tenantId})`);
            return row!;
          });
          return c.json(deliveryOut(d), 202);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/settings/webhooks/{id}/deliveries",
          tags: ["Webhooks"],
          summary: "Últimas 50 entregas",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ data: z.array(Delivery) })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const rows = await c.var.tenant.tx((tx) =>
            tx
              .select()
              .from(s.webhookDeliveries)
              .where(eq(s.webhookDeliveries.endpointId, id))
              .orderBy(desc(s.webhookDeliveries.createdAt))
              .limit(50),
          );
          return c.json({ data: rows.map(deliveryOut) }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/settings/webhooks/{id}/deliveries/{deliveryId}/retry",
          tags: ["Webhooks"],
          summary: "Tentar de novo uma entrega que falhou",
          request: { params: z.object({ id: z.uuid(), deliveryId: z.uuid() }) },
          responses: { 202: ok(Delivery, "Na fila") },
        }),
        async (c) => {
          const { id, deliveryId } = c.req.valid("param");
          const d = await c.var.tenant.tx(async (tx) => {
            assertFeature(await loadEntitlements(tx), "outgoingWebhooks");
            const [row] = await tx
              .update(s.webhookDeliveries)
              .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null })
              .where(
                and(
                  eq(s.webhookDeliveries.id, deliveryId),
                  eq(s.webhookDeliveries.endpointId, id),
                  eq(s.webhookDeliveries.status, "failed"),
                ),
              )
              .returning();
            if (!row)
              throw new AppError(409, "DELIVERY_NOT_FAILED", "Só entregas com falha podem ser repetidas.");
            await tx.execute(sql`SELECT pg_notify('recpm_webhooks', ${c.var.tenant.tenantId})`);
            return row;
          });
          return c.json(deliveryOut(d), 202);
        },
      )

      // ── Exportação de dados ──────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/settings/backup",
          tags: ["Exportação"],
          summary: "Agenda da exportação automática",
          responses: { 200: ok(Backup) },
        }),
        async (c) => {
          const [st] = await c.var.tenant.tx((tx) =>
            tx.select({ b: s.tenantSettings.backupSchedule }).from(s.tenantSettings),
          );
          if (!st) throw new AppError(404, "NOT_FOUND", "Configurações não encontradas.");
          return c.json(backupOut(st.b), 200);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/settings/backup",
          tags: ["Exportação"],
          summary: "Salvar a agenda (a cada N dias, no horário do workspace)",
          request: body(Backup),
          responses: { 200: ok(Backup) },
        }),
        async (c) => {
          const b = c.req.valid("json");
          const webhookUrl = b.webhookUrl?.trim() ? checkWebhookUrl(b.webhookUrl.trim(), production) : null;
          const next = {
            enabled: b.enabled,
            everyNDays: b.everyNDays,
            at: b.at,
            format: b.format,
            ...(webhookUrl ? { destination: { kind: "webhook" as const, url: webhookUrl } } : {}),
          };
          await c.var.tenant.tx(async (tx) => {
            await tx.update(s.tenantSettings).set({ backupSchedule: next });
            await audit(tx, actorOf(c), {
              entity: "settings",
              entityLabel: "backup",
              action: "update",
              details: { to: next },
            });
          });
          return c.json(backupOut(next), 200);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/exports",
          tags: ["Exportação"],
          summary: "Exportações (últimas 30)",
          responses: { 200: ok(z.object({ data: z.array(Export) })) },
        }),
        async (c) => {
          const rows = await c.var.tenant.tx((tx) =>
            tx
              .select({ e: s.dataExports, by: s.users.name, size: s.files.sizeBytes })
              .from(s.dataExports)
              .leftJoin(s.users, eq(s.users.id, s.dataExports.requestedBy))
              .leftJoin(s.files, eq(s.files.id, s.dataExports.fileId))
              .orderBy(desc(s.dataExports.createdAt))
              .limit(30),
          );
          return c.json(
            {
              data: rows.map(({ e, by, size }) => ({
                id: e.id,
                trigger: e.trigger,
                format: e.format,
                status: e.status,
                requestedBy: by,
                createdAt: e.createdAt.toISOString(),
                finishedAt: iso(e.finishedAt),
                error: e.error,
                sizeBytes: size ?? null,
              })),
            },
            200,
          );
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/exports",
          tags: ["Exportação"],
          summary: "Exportar agora (gera um .zip com todos os dados do workspace)",
          request: body(z.object({ format: z.enum(["json", "csv"]).default("json") })),
          responses: { 202: ok(z.object({ id: z.uuid() }), "Na fila") },
        }),
        async (c) => {
          const b = c.req.valid("json");
          const id = await c.var.tenant.tx(async (tx) => {
            const [running] = await tx
              .select({ id: s.dataExports.id })
              .from(s.dataExports)
              .where(inArray(s.dataExports.status, ["pending", "running"]));
            if (running) throw new AppError(409, "EXPORT_RUNNING", "Já existe uma exportação em andamento.");
            const [e] = await tx
              .insert(s.dataExports)
              .values({
                tenantId: c.var.tenant.tenantId,
                trigger: "manual",
                format: b.format,
                requestedBy: c.var.tenant.userId,
              })
              .returning();
            await audit(tx, actorOf(c), {
              entity: "export",
              entityId: e!.id,
              action: "create",
              details: { format: b.format },
            });
            await tx.execute(sql`SELECT pg_notify('recpm_exports', ${c.var.tenant.tenantId})`);
            return e!.id;
          });
          return c.json({ id }, 202);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/exports/{id}/download",
          tags: ["Exportação"],
          summary: "Link temporário para baixar a exportação",
          request: { params: IdParam },
          responses: { 200: ok(z.object({ url: z.string() })) },
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          if (!storage) throw new AppError(503, "STORAGE_UNAVAILABLE", "Armazenamento indisponível.");
          const f = await c.var.tenant.tx(async (tx) => {
            const [row] = await tx
              .select({ key: s.files.storageKey, name: s.files.originalName })
              .from(s.dataExports)
              .innerJoin(s.files, eq(s.files.id, s.dataExports.fileId))
              .where(and(eq(s.dataExports.id, id), eq(s.dataExports.status, "succeeded")));
            if (!row) throw new AppError(404, "EXPORT_NOT_FOUND", "Exportação não encontrada.");
            await audit(tx, actorOf(c), { entity: "export", entityId: id, action: "download" });
            return row;
          });
          return c.json({ url: await storage.presignDownload(f.key, f.name) }, 200);
        },
      )

      // ── Auditoria ────────────────────────────────────────────────────────
      .openapi(
        createRoute({
          method: "get",
          path: "/audit",
          tags: ["Auditoria"],
          summary: "Log de auditoria (mais recentes primeiro)",
          request: {
            query: z.object({
              actorId: z.uuid().optional(),
              entity: z.string().max(40).optional(),
              action: z.string().max(40).optional(),
              q: z.string().max(100).optional(),
              from: z.iso.date().optional(),
              to: z.iso.date().optional(),
              before: z.string().optional().openapi({ description: "Cursor: createdAt|id da última linha" }),
              limit: z.coerce.number().int().min(1).max(200).default(50),
            }),
          },
          responses: {
            200: ok(
              z.object({
                data: z.array(AuditRow),
                next: z.string().nullable(),
                facets: z.object({
                  entities: z.array(z.string()),
                  actions: z.array(z.string()),
                  actors: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
                }),
              }),
            ),
          },
        }),
        async (c) => {
          const q = c.req.valid("query");
          const out = await c.var.tenant.tx(async (tx) => {
            const tz = await tenantTimezone(tx);
            const L = s.auditLogs;
            let cursor: { at: Date; id: string } | null = null;
            if (q.before) {
              const [at, id] = q.before.split("|");
              const d = new Date(at ?? "");
              if (!Number.isNaN(d.getTime()) && id) cursor = { at: d, id };
            }
            const where = and(
              q.actorId ? eq(L.actorId, q.actorId) : undefined,
              q.entity ? eq(L.entity, q.entity) : undefined,
              q.action ? eq(L.action, q.action) : undefined,
              q.q
                ? or(
                    ilike(L.entityLabel, `%${q.q.replace(/[%_\\]/g, "\\$&")}%`),
                    ilike(L.actorName, `%${q.q.replace(/[%_\\]/g, "\\$&")}%`),
                  )
                : undefined,
              q.from ? gte(L.createdAt, localMidnight(q.from, tz)) : undefined,
              q.to ? lt(L.createdAt, localMidnight(nextDay(q.to), tz)) : undefined,
              cursor
                ? or(lt(L.createdAt, cursor.at), and(eq(L.createdAt, cursor.at), lt(L.id, cursor.id)))
                : undefined,
            );
            const rows = await tx
              .select()
              .from(L)
              .where(where)
              .orderBy(desc(L.createdAt), desc(L.id))
              .limit(q.limit + 1);
            const facets = q.before
              ? { entities: [], actions: [], actors: [] }
              : {
                  entities: (await tx.selectDistinct({ v: L.entity }).from(L).orderBy(L.entity)).map(
                    (x) => x.v,
                  ),
                  actions: (await tx.selectDistinct({ v: L.action }).from(L).orderBy(L.action)).map(
                    (x) => x.v,
                  ),
                  actors: (
                    await tx
                      .selectDistinct({ id: L.actorId, name: L.actorName })
                      .from(L)
                      .where(sql`${L.actorId} IS NOT NULL`)
                  )
                    .filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i)
                    .map((a) => ({ id: a.id!, name: a.name }))
                    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
                };
            return { rows, facets };
          });
          const page = out.rows.slice(0, q.limit);
          const last = page.at(-1);
          return c.json(
            {
              data: page.map((x) => ({
                id: x.id,
                createdAt: x.createdAt.toISOString(),
                actor: { id: x.actorId, name: x.actorName, role: x.actorRole },
                impersonated: !!x.impersonatorId,
                entity: x.entity,
                entityId: x.entityId,
                entityLabel: x.entityLabel,
                action: x.action,
                details: (x.details as Record<string, unknown> | null) ?? null,
                ip: x.ip,
              })),
              next: out.rows.length > q.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
              facets: out.facets,
            },
            200,
          );
        },
      )
  );
};

const localMidnight = (ymd: string, tz: string) => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return zonedToUtc(y, m, d, 0, 0, tz);
};

const nextDay = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const deliveryOut = (d: typeof s.webhookDeliveries.$inferSelect) => ({
  id: d.id,
  event: d.event,
  status: d.status,
  attempts: d.attempts,
  responseStatus: d.responseStatus,
  lastError: d.lastError,
  createdAt: d.createdAt.toISOString(),
  deliveredAt: iso(d.deliveredAt),
  nextAttemptAt: d.status === "succeeded" ? null : iso(d.nextAttemptAt),
});
