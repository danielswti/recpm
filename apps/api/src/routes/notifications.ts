/**
 * Notificações (§6.10): sino com contagem, lista, marcar lidas, preferências por tipo × canal,
 * assinaturas de web push e o fluxo SSE do usuário (/stream) com notificações, chat e "digitando".
 */
import { createRoute, z } from "@hono/zod-openapi";
import { schema } from "@recpm/db";
import {
  NOTIFICATION_TYPE_KEYS,
  NOTIFICATION_TYPES,
  notificationPreferencesInput,
  pushSubscriptionInput,
} from "@recpm/shared";
import { and, desc, eq, lt, ne, notExists, sql } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../deps";
import { AppError } from "../lib/errors";
import type { LiveHub } from "../lib/live";
import type { PushSender } from "../lib/push";
import { router } from "../lib/router";
import { requireTenant } from "../middleware/tenant";
import type { AppEnv } from "../types";

const s = schema;
const tags = ["Notificações"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const noContent = { 204: { description: "OK" } };

const Notification = z
  .object({
    id: z.uuid(),
    type: z.string(),
    title: z.string(),
    message: z.string().nullable(),
    referenceType: z.string().nullable(),
    referenceId: z.string().nullable(),
    read: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Notification");

const Pref = z.object({ type: z.string(), inApp: z.boolean(), email: z.boolean(), push: z.boolean() });

type Var = AppEnv["Variables"];

/** Filtros comuns: só as do usuário, sem os tipos que ele desligou no app, sem mensagens de chat. */
const mine = (t: Var["tenant"]) =>
  and(
    eq(s.notifications.userId, t.userId),
    ne(s.notifications.type, "chat_mensagem"),
    notExists(
      sql`(select 1 from ${s.notificationPreferences} p where p.user_id = ${s.notifications.userId} and p.type = ${s.notifications.type} and not p.in_app)`,
    ),
  );

export async function unreadCount(t: Var["tenant"]) {
  const [r] = await t.tx((tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(s.notifications)
      .where(and(mine(t), eq(s.notifications.read, false))),
  );
  return r?.n ?? 0;
}

export const notificationRoutes = (deps: Deps & { live: LiveHub; push: PushSender | null }) => {
  const r = router();
  r.use("/notifications", requireTenant(deps.dbs));
  r.use("/notifications/*", requireTenant(deps.dbs));
  r.use("/push/*", requireTenant(deps.dbs));
  r.use("/stream", requireTenant(deps.dbs));

  const routes = r
    .openapi(
      createRoute({
        method: "get",
        path: "/notifications",
        tags,
        summary: "Minhas notificações (mais recentes primeiro)",
        request: {
          query: z.object({
            unread: z.stringbool().optional(),
            before: z.iso.datetime({ offset: true }).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(30),
          }),
        },
        responses: {
          200: ok(z.object({ data: z.array(Notification), unread: z.number(), hasMore: z.boolean() })),
        },
      }),
      async (c) => {
        const q = c.req.valid("query");
        const t = c.var.tenant;
        const rows = await t.tx((tx) =>
          tx
            .select()
            .from(s.notifications)
            .where(
              and(
                mine(t),
                q.unread ? eq(s.notifications.read, false) : undefined,
                q.before ? lt(s.notifications.createdAt, new Date(q.before)) : undefined,
              ),
            )
            .orderBy(desc(s.notifications.createdAt))
            .limit(q.limit + 1),
        );
        return c.json(
          {
            data: rows.slice(0, q.limit).map((n) => ({
              id: n.id,
              type: n.type,
              title: n.title,
              message: n.message,
              referenceType: n.referenceType,
              referenceId: n.referenceId,
              read: n.read,
              createdAt: n.createdAt.toISOString(),
            })),
            unread: await unreadCount(t),
            hasMore: rows.length > q.limit,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/notifications/unread-count",
        tags,
        summary: "Quantas não lidas (o sino mostra 99+)",
        responses: { 200: ok(z.object({ unread: z.number() })) },
      }),
      async (c) => c.json({ unread: await unreadCount(c.var.tenant) }, 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/notifications/{id}/read",
        tags,
        summary: "Marcar como lida (ou não lida)",
        request: {
          params: z.object({ id: z.uuid() }),
          ...body(z.object({ read: z.boolean().default(true) })),
        },
        responses: noContent,
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const { read } = c.req.valid("json");
        const t = c.var.tenant;
        const n = await t.tx((tx) =>
          tx
            .update(s.notifications)
            .set({ read, readAt: read ? new Date() : null })
            .where(and(eq(s.notifications.id, id), eq(s.notifications.userId, t.userId)))
            .returning({ id: s.notifications.id }),
        );
        if (!n.length) throw new AppError(404, "NOT_FOUND", "Notificação não encontrada.");
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/notifications/read-all",
        tags,
        summary: "Marcar todas como lidas",
        responses: noContent,
      }),
      async (c) => {
        const t = c.var.tenant;
        await t.tx((tx) =>
          tx
            .update(s.notifications)
            .set({ read: true, readAt: new Date() })
            .where(and(eq(s.notifications.userId, t.userId), eq(s.notifications.read, false))),
        );
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/notifications/preferences",
        tags,
        summary: "Preferências por tipo (no app, e-mail, push)",
        responses: { 200: ok(z.object({ data: z.array(Pref), pushAvailable: z.boolean() })) },
      }),
      async (c) => {
        const t = c.var.tenant;
        const rows = await t.tx((tx) =>
          tx.select().from(s.notificationPreferences).where(eq(s.notificationPreferences.userId, t.userId)),
        );
        return c.json(
          {
            data: NOTIFICATION_TYPE_KEYS.map((type) => {
              const p = rows.find((x) => x.type === type);
              const d = NOTIFICATION_TYPES[type];
              return { type, inApp: p?.inApp ?? true, email: p?.email ?? d.email, push: p?.push ?? d.push };
            }),
            pushAvailable: !!deps.push,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/notifications/preferences",
        tags,
        summary: "Salvar preferências",
        request: body(notificationPreferencesInput),
        responses: noContent,
      }),
      async (c) => {
        const { preferences } = c.req.valid("json");
        const t = c.var.tenant;
        await t.tx(async (tx) => {
          for (const p of preferences)
            await tx
              .insert(s.notificationPreferences)
              .values({ tenantId: t.tenantId, userId: t.userId, ...p })
              .onConflictDoUpdate({
                target: [
                  s.notificationPreferences.tenantId,
                  s.notificationPreferences.userId,
                  s.notificationPreferences.type,
                ],
                set: { inApp: p.inApp, email: p.email, push: p.push },
              });
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/push/public-key",
        tags,
        summary: "Chave pública VAPID (null = push desligado no servidor)",
        responses: { 200: ok(z.object({ key: z.string().nullable() })) },
      }),
      async (c) => c.json({ key: deps.push?.publicKey ?? null }, 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/push/subscriptions",
        tags,
        summary: "Registrar este navegador para receber push",
        request: body(pushSubscriptionInput),
        responses: noContent,
      }),
      async (c) => {
        const b = c.req.valid("json");
        const t = c.var.tenant;
        await t.tx((tx) =>
          tx
            .insert(s.pushSubscriptions)
            .values({
              tenantId: t.tenantId,
              userId: t.userId,
              endpoint: b.endpoint,
              p256dh: b.keys.p256dh,
              auth: b.keys.auth,
              userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
            })
            .onConflictDoUpdate({
              target: [s.pushSubscriptions.tenantId, s.pushSubscriptions.endpoint],
              set: { userId: t.userId, p256dh: b.keys.p256dh, auth: b.keys.auth },
            }),
        );
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/push/unsubscribe",
        tags,
        summary: "Parar o push neste navegador",
        request: body(z.object({ endpoint: z.url() })),
        responses: noContent,
      }),
      async (c) => {
        const { endpoint } = c.req.valid("json");
        const t = c.var.tenant;
        await t.tx((tx) =>
          tx
            .delete(s.pushSubscriptions)
            .where(and(eq(s.pushSubscriptions.endpoint, endpoint), eq(s.pushSubscriptions.userId, t.userId))),
        );
        return c.body(null, 204);
      },
    );

  /**
   * Fluxo do usuário (SSE). Eventos:
   *   notification {unread}            — quando chega notificação nova
   *   chat {conversationId}            — mensagem nova/editada ou participantes mudaram
   *   typing {conversationId, userId, name}
   * O chat é filtrado pelas conversas de que a pessoa participa (reconsultadas com RLS).
   */
  r.get("/stream", (c) => {
    const t = c.var.tenant;
    return streamSSE(c, async (stream) => {
      const queue: { event: string; data: unknown }[] = [];
      let wake: (() => void) | null = null;
      const push = (event: string, data: unknown) => {
        queue.push({ event, data });
        wake?.();
      };
      const allowed = new Map<string, boolean>();
      const canSee = async (conv: string) => {
        if (!allowed.has(conv)) {
          const [p] = await t.tx((tx) =>
            tx
              .select({ id: s.conversationParticipants.conversationId })
              .from(s.conversationParticipants)
              .where(
                and(
                  eq(s.conversationParticipants.conversationId, conv),
                  eq(s.conversationParticipants.userId, t.userId),
                ),
              ),
          );
          allowed.set(conv, !!p);
        }
        return allowed.get(conv)!;
      };
      const offs = [
        deps.live.subscribe("recpm_notify", `${t.tenantId}:${t.userId}`, () => {
          void unreadCount(t).then((unread) => push("notification", { unread }));
        }),
        deps.live.subscribe("recpm_chat", t.tenantId, (payload) => {
          const conv = payload.split(":")[1]!;
          allowed.delete(conv); // participantes podem ter mudado
          void canSee(conv).then((yes) => yes && push("chat", { conversationId: conv }));
        }),
        deps.live.subscribe("recpm_typing", t.tenantId, (payload) => {
          const [, conv, userId, ...name] = payload.split(":");
          if (userId === t.userId) return;
          void canSee(conv!).then(
            (yes) => yes && push("typing", { conversationId: conv, userId, name: name.join(":") }),
          );
        }),
      ];
      stream.onAbort(() => {
        for (const off of offs) off();
        wake?.();
      });
      try {
        await stream.writeSSE({
          event: "notification",
          data: JSON.stringify({ unread: await unreadCount(t) }),
        });
        while (!stream.aborted) {
          while (queue.length) {
            const m = queue.shift()!;
            await stream.writeSSE({ event: m.event, data: JSON.stringify(m.data) });
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 25_000);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = null;
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        for (const off of offs) off();
      }
    });
  });

  return routes;
};
