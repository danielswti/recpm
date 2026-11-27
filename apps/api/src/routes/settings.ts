/**
 * Configurações do workspace (§6.12): operação (fuso, horário comercial padrão, SLA de cobrança),
 * pesos de produtividade, marca, assistente de IA e chaves de API.
 * A chave da IA é criptografada (tenant_secrets) e nunca volta: só `keyConfigured`.
 * A chave de API aparece UMA vez, na criação; guardamos o prefixo e o SHA-256 do segredo.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { audit } from "@recpm/core";
import { schema } from "@recpm/db";
import {
  aiSettingsInput,
  apiKeyInput,
  brandingInput,
  operationSettingsInput,
  productivityWeightsInput,
} from "@recpm/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError } from "../lib/errors";
import { router } from "../lib/router";
import { encryptSecret, secretsKey } from "../lib/secrets";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;
const tags = ["Configurações"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const Hours = z.object({
  days: z.record(z.string(), z.array(z.object({ start: z.string(), end: z.string() }))),
});

const Settings = z
  .object({
    timezone: z.string(),
    operation: z.object({
      clientChaseSlaBusinessHours: z.number(),
      idleCardHours: z.number(),
      defaultBusinessHours: Hours,
    }),
    productivityWeights: productivityWeightsInput,
    branding: z.object({
      primaryColor: z.string().nullable(),
      secondaryColor: z.string().nullable(),
      chatColor: z.string().nullable(),
      logoFileId: z.string().nullable(),
      faviconFileId: z.string().nullable(),
      logoScale: z.number().nullable(),
    }),
    ai: z.object({
      enabled: z.boolean(),
      assistantName: z.string().nullable(),
      baseUrl: z.string().nullable(),
      model: z.string().nullable(),
      keyConfigured: z.boolean(),
    }),
  })
  .openapi("WorkspaceSettings");

const ApiKey = z
  .object({
    id: z.uuid(),
    name: z.string(),
    prefix: z.string(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  })
  .openapi("ApiKey");

export const settingsRoutes = (deps: Deps) => {
  const r = router();
  r.use("/settings", requireTenant(deps.dbs), teamOnly, requirePermission("tenant.settings"));
  r.use("/settings/*", requireTenant(deps.dbs), teamOnly);
  r.on(
    ["PUT"],
    ["/settings/operation", "/settings/productivity", "/settings/ai"],
    requirePermission("tenant.settings"),
  );
  r.on(["PUT"], ["/settings/branding"], requirePermission("tenant.branding"));
  r.on(
    ["GET", "POST", "DELETE"],
    ["/settings/api-keys", "/settings/api-keys/*"],
    requirePermission("tenant.apiKeys"),
  );

  const load = (c: Parameters<typeof actorOf>[0]) =>
    c.var.tenant.tx(async (tx) => {
      const [t] = await tx.select({ tz: s.tenants.timezone }).from(s.tenants);
      const [st] = await tx.select().from(s.tenantSettings);
      const [sec] = await tx.select({ ai: s.tenantSecrets.aiApiKeyEnc }).from(s.tenantSecrets);
      if (!st) throw new AppError(404, "NOT_FOUND", "Configurações não encontradas.");
      const b = st.branding ?? {};
      return {
        timezone: t?.tz ?? "America/Sao_Paulo",
        operation: {
          clientChaseSlaBusinessHours: st.operation.clientChaseSlaBusinessHours,
          idleCardHours: st.operation.idleCardHours,
          defaultBusinessHours: st.operation.defaultBusinessHours as z.infer<typeof Hours>,
        },
        productivityWeights: st.productivityWeights,
        branding: {
          primaryColor: b.primaryColor ?? null,
          secondaryColor: b.secondaryColor ?? null,
          chatColor: b.chatColor ?? null,
          logoFileId: b.logoFileId ?? null,
          faviconFileId: b.faviconFileId ?? null,
          logoScale: b.logoScale ?? null,
        },
        ai: {
          enabled: st.ai.enabled,
          assistantName: st.ai.assistantName ?? null,
          baseUrl: st.ai.baseUrl ?? null,
          model: st.ai.model ?? null,
          keyConfigured: !!sec?.ai,
        },
      };
    });

  const validTz = (tz: string) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  };

  return r
    .openapi(
      createRoute({
        method: "get",
        path: "/settings",
        tags,
        summary: "Configurações do workspace",
        responses: { 200: ok(Settings) },
      }),
      async (c) => c.json(await load(c), 200),
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/settings/operation",
        tags,
        summary: "Fuso, horário comercial padrão e SLA de cobrança",
        request: body(operationSettingsInput),
        responses: { 200: ok(Settings) },
      }),
      async (c) => {
        const b = c.req.valid("json");
        if (!validTz(b.timezone)) throw new AppError(400, "INVALID_TIMEZONE", "Fuso horário inválido.");
        await c.var.tenant.tx(async (tx) => {
          const [st] = await tx.select({ op: s.tenantSettings.operation }).from(s.tenantSettings);
          await tx
            .update(s.tenants)
            .set({ timezone: b.timezone })
            .where(eq(s.tenants.id, c.var.tenant.tenantId));
          await tx
            .update(s.tenantSettings)
            .set({
              operation: {
                ...st!.op,
                clientChaseSlaBusinessHours: b.clientChaseSlaBusinessHours,
                idleCardHours: b.idleCardHours,
                defaultBusinessHours: b.defaultBusinessHours as never,
              },
            })
            .where(eq(s.tenantSettings.tenantId, c.var.tenant.tenantId));
          await audit(tx, actorOf(c), {
            entity: "settings",
            action: "update",
            details: { section: "operation" },
          });
        });
        return c.json(await load(c), 200);
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/settings/productivity",
        tags,
        summary: "Pesos da pontuação de produtividade",
        request: body(productivityWeightsInput),
        responses: { 200: ok(Settings) },
      }),
      async (c) => {
        const b = c.req.valid("json");
        await c.var.tenant.tx(async (tx) => {
          await tx
            .update(s.tenantSettings)
            .set({ productivityWeights: b })
            .where(eq(s.tenantSettings.tenantId, c.var.tenant.tenantId));
          await audit(tx, actorOf(c), {
            entity: "settings",
            action: "update",
            details: { section: "productivity", to: b },
          });
        });
        return c.json(await load(c), 200);
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/settings/branding",
        tags,
        summary: "Identidade visual (cores, logo, favicon)",
        request: body(brandingInput),
        responses: { 200: ok(Settings) },
      }),
      async (c) => {
        const b = c.req.valid("json");
        await c.var.tenant.tx(async (tx) => {
          const fileIds = [b.logoFileId, b.faviconFileId].filter((x): x is string => !!x);
          if (fileIds.length) {
            const found = await tx
              .select({ id: s.files.id, mime: s.files.mimeType })
              .from(s.files)
              .where(and(inArray(s.files.id, fileIds), isNull(s.files.deletedAt)));
            if (found.length !== new Set(fileIds).size || found.some((f) => !f.mime.startsWith("image/")))
              throw new AppError(400, "INVALID_IMAGE", "Envie uma imagem (PNG, JPG, SVG ou WebP).");
          }
          const [st] = await tx.select({ b: s.tenantSettings.branding }).from(s.tenantSettings);
          const next: Record<string, unknown> = { ...(st?.b ?? {}) };
          for (const [k, v] of Object.entries(b)) {
            if (v === undefined) continue;
            if (v === null) delete next[k];
            else next[k] = v;
          }
          await tx
            .update(s.tenantSettings)
            .set({ branding: next })
            .where(eq(s.tenantSettings.tenantId, c.var.tenant.tenantId));
          await audit(tx, actorOf(c), {
            entity: "settings",
            action: "update",
            details: { section: "branding" },
          });
        });
        return c.json(await load(c), 200);
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/settings/ai",
        tags,
        summary: "Assistente de IA (provedor compatível com OpenAI). A chave nunca é devolvida.",
        request: body(aiSettingsInput),
        responses: { 200: ok(Settings) },
      }),
      async (c) => {
        const b = c.req.valid("json");
        const enc = typeof b.apiKey === "string" ? encryptSecret(b.apiKey, secretsKey(deps.env)) : b.apiKey;
        await c.var.tenant.tx(async (tx) => {
          const [st] = await tx.select({ ai: s.tenantSettings.ai }).from(s.tenantSettings);
          await tx
            .update(s.tenantSettings)
            .set({
              ai: {
                ...(st?.ai ?? {}),
                enabled: b.enabled,
                assistantName: b.assistantName || undefined,
                baseUrl: b.baseUrl || undefined,
                model: b.model || undefined,
              },
            })
            .where(eq(s.tenantSettings.tenantId, c.var.tenant.tenantId));
          if (enc !== undefined)
            await tx
              .update(s.tenantSecrets)
              .set({ aiApiKeyEnc: enc })
              .where(eq(s.tenantSecrets.tenantId, c.var.tenant.tenantId));
          await audit(tx, actorOf(c), {
            entity: "settings",
            action: "update",
            details: { section: "ai", keyChanged: enc !== undefined },
          });
        });
        return c.json(await load(c), 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/settings/api-keys",
        tags,
        summary: "Chaves de API ativas",
        responses: { 200: ok(z.object({ data: z.array(ApiKey) })) },
      }),
      async (c) => {
        const rows = await c.var.tenant.tx((tx) =>
          tx
            .select({ k: s.apiKeys, name: s.users.name })
            .from(s.apiKeys)
            .leftJoin(s.users, eq(s.users.id, s.apiKeys.createdBy))
            .where(isNull(s.apiKeys.revokedAt))
            .orderBy(desc(s.apiKeys.createdAt)),
        );
        return c.json(
          {
            data: rows.map(({ k, name }) => ({
              id: k.id,
              name: k.name,
              prefix: `pk_live_${k.prefix}`,
              createdBy: name,
              createdAt: k.createdAt.toISOString(),
              lastUsedAt: iso(k.lastUsedAt),
              expiresAt: iso(k.expiresAt),
            })),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/settings/api-keys",
        tags,
        summary: "Criar chave de API (o segredo aparece só nesta resposta)",
        request: body(apiKeyInput),
        responses: { 201: ok(ApiKey.extend({ key: z.string() }), "Criada") },
      }),
      async (c) => {
        const b = c.req.valid("json");
        const prefix = randomBytes(6).toString("hex");
        const secret = randomBytes(32).toString("base64url");
        const hashedKey = createHash("sha256").update(secret).digest("hex");
        const expiresAt = b.expiresAt ? new Date(`${b.expiresAt}T23:59:59Z`) : null;
        if (expiresAt && expiresAt < new Date())
          throw new AppError(400, "INVALID_EXPIRY", "A validade precisa ser uma data futura.");
        const row = await c.var.tenant.tx(async (tx) => {
          const [k] = await tx
            .insert(s.apiKeys)
            .values({
              tenantId: c.var.tenant.tenantId,
              name: b.name,
              prefix,
              hashedKey,
              createdBy: c.var.tenant.userId,
              expiresAt,
            })
            .returning();
          await audit(tx, actorOf(c), {
            entity: "api_key",
            entityId: k!.id,
            entityLabel: b.name,
            action: "create",
          });
          return k!;
        });
        return c.json(
          {
            id: row.id,
            name: row.name,
            prefix: `pk_live_${prefix}`,
            createdBy: c.var.session?.user.name ?? null,
            createdAt: row.createdAt.toISOString(),
            lastUsedAt: null,
            expiresAt: iso(row.expiresAt),
            key: `pk_live_${prefix}_${secret}`,
          },
          201,
        );
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/settings/api-keys/{id}",
        tags,
        summary: "Revogar chave de API",
        request: { params: z.object({ id: z.uuid() }) },
        responses: { 204: { description: "OK" } },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await c.var.tenant.tx(async (tx) => {
          const [k] = await tx
            .update(s.apiKeys)
            .set({ revokedAt: new Date() })
            .where(and(eq(s.apiKeys.id, id), isNull(s.apiKeys.revokedAt)))
            .returning();
          if (!k) throw new AppError(404, "NOT_FOUND", "Chave não encontrada.");
          await audit(tx, actorOf(c), {
            entity: "api_key",
            entityId: id,
            entityLabel: k.name,
            action: "revoke",
          });
        });
        return c.body(null, 204);
      },
    );
};
