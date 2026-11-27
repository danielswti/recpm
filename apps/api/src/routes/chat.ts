/**
 * Chat (§6.9): conversas diretas (DM), grupos, conversa do projeto e conversa com a IA.
 * Não lidas, marcar como não lida, fixar, "digitando", anexos, foto do grupo e participantes.
 * O RLS só mostra conversas de que a pessoa participa; a conversa do projeto é aberta para quem
 * vê o projeto (entrar nela usa o contexto de sistema, depois de checar o acesso ao projeto).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { assertProjectAccess } from "@recpm/core";
import { type AppTx, schema, withTenant } from "@recpm/db";
import { conversationInput, conversationUpdateInput, messageInput } from "@recpm/shared";
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { aiConfig, assistantReply } from "../lib/ai";
import { AppError } from "../lib/errors";
import type { LiveHub } from "../lib/live";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";
import { projectVisibleTo } from "./projects";
import { taskVisibleTo } from "./tasks";

const s = schema;
const tags = ["Chat"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const IdParam = z.object({ id: z.uuid() });
const noContent = { 204: { description: "OK" } };
const notFound = () => new AppError(404, "CONVERSATION_NOT_FOUND", "Conversa não encontrada.");

const Person = z.object({ id: z.uuid(), name: z.string(), image: z.string().nullable() });
const Conversation = z
  .object({
    id: z.uuid(),
    type: z.enum(["dm", "grupo", "ia", "projeto"]),
    name: z.string(),
    photoFileId: z.string().nullable(),
    project: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    participants: z.array(Person.extend({ isAdmin: z.boolean() })),
    lastMessage: z.object({ body: z.string(), authorName: z.string().nullable(), at: z.string() }).nullable(),
    unread: z.number(),
    markedUnread: z.boolean(),
    pinned: z.boolean(),
    isAdmin: z.boolean(),
  })
  .openapi("Conversation");
type ConversationT = z.infer<typeof Conversation>;

const Message = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    author: Person.nullable(),
    authorType: z.enum(["user", "assistant", "system", "tool"]),
    body: z.string(),
    attachments: z.array(
      z.object({ id: z.uuid(), name: z.string(), mimeType: z.string(), sizeBytes: z.number() }),
    ),
    toolCalls: z.array(z.object({ name: z.string() })).nullable(),
    editedAt: z.string().nullable(),
    deleted: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("ChatMessage");

async function aiName(tx: AppTx) {
  const [st] = await tx.select({ ai: s.tenantSettings.ai }).from(s.tenantSettings);
  return st?.ai.assistantName || "Assistente";
}

/** Conversas da pessoa (ou uma só), com participantes, última mensagem e não lidas. */
async function listConversations(tx: AppTx, userId: string, only?: string): Promise<ConversationT[]> {
  const mine = await tx
    .select({ c: s.conversations, me: s.conversationParticipants, pname: s.projects.name })
    .from(s.conversationParticipants)
    .innerJoin(s.conversations, eq(s.conversations.id, s.conversationParticipants.conversationId))
    .leftJoin(s.projects, eq(s.projects.id, s.conversations.projectId))
    .where(
      and(eq(s.conversationParticipants.userId, userId), only ? eq(s.conversations.id, only) : undefined),
    );
  if (!mine.length) return [];
  const ids = mine.map((m) => m.c.id);
  const people = await tx
    .select({
      conv: s.conversationParticipants.conversationId,
      id: s.users.id,
      name: s.users.name,
      image: s.users.image,
      isAdmin: s.conversationParticipants.isAdmin,
    })
    .from(s.conversationParticipants)
    .innerJoin(s.users, eq(s.users.id, s.conversationParticipants.userId))
    .where(inArray(s.conversationParticipants.conversationId, ids));
  const last = await tx.execute<{
    conversation_id: string;
    body: string;
    author: string | null;
    at: Date;
    deleted: boolean;
  }>(sql`
    SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.body, u.name AS author, m.created_at AS at,
           (m.deleted_at IS NOT NULL) AS deleted
      FROM messages m LEFT JOIN users u ON u.id = m.author_id
     WHERE m.conversation_id IN ${sql.raw(`(${ids.map((i) => `'${i}'`).join(",")})`)}
     ORDER BY m.conversation_id, m.created_at DESC`);
  const unread = await tx.execute<{ conversation_id: string; n: number }>(sql`
    SELECT p.conversation_id, count(m.id)::int AS n
      FROM conversation_participants p
      JOIN messages m ON m.conversation_id = p.conversation_id
       AND m.created_at > coalesce(p.last_read_at, p.joined_at)
       AND m.author_id IS DISTINCT FROM p.user_id
       AND m.deleted_at IS NULL
     WHERE p.user_id = ${userId} AND p.conversation_id IN ${sql.raw(`(${ids.map((i) => `'${i}'`).join(",")})`)}
     GROUP BY p.conversation_id`);
  const assistant = mine.some((m) => m.c.type === "ia") ? await aiName(tx) : "Assistente";
  return mine
    .map(({ c, me, pname }) => {
      const parts = people.filter((p) => p.conv === c.id);
      const others = parts.filter((p) => p.id !== userId);
      const l = last.rows.find((x) => x.conversation_id === c.id);
      const name =
        c.type === "dm"
          ? (others[0]?.name ?? "—")
          : c.type === "ia"
            ? assistant
            : c.type === "projeto"
              ? (pname ?? c.name ?? "Projeto")
              : (c.name ?? others.map((o) => o.name.split(" ")[0]).join(", "));
      return {
        id: c.id,
        type: c.type,
        name,
        photoFileId: c.photoFileId,
        project: c.projectId && pname ? { id: c.projectId, name: pname } : null,
        participants: parts.map(({ conv: _c, ...p }) => p),
        lastMessage: l
          ? {
              body: l.deleted ? "" : l.body.slice(0, 160),
              authorName: l.author,
              at: new Date(l.at).toISOString(),
            }
          : null,
        unread: unread.rows.find((x) => x.conversation_id === c.id)?.n ?? 0,
        markedUnread: me.markedUnread,
        pinned: me.pinned,
        isAdmin: me.isAdmin,
      };
    })
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.lastMessage?.at ?? "").localeCompare(a.lastMessage?.at ?? ""),
    );
}

async function messagesOut(tx: AppTx, rows: (typeof s.messages.$inferSelect)[]) {
  const ids = rows.map((r) => r.id);
  const authors = [...new Set(rows.map((r) => r.authorId).filter(Boolean) as string[])];
  const users = authors.length
    ? await tx
        .select({ id: s.users.id, name: s.users.name, image: s.users.image })
        .from(s.users)
        .where(inArray(s.users.id, authors))
    : [];
  const atts = ids.length
    ? await tx
        .select({
          messageId: s.messageAttachments.messageId,
          id: s.files.id,
          name: s.files.originalName,
          mimeType: s.files.mimeType,
          sizeBytes: s.files.sizeBytes,
        })
        .from(s.messageAttachments)
        .innerJoin(s.files, eq(s.files.id, s.messageAttachments.fileId))
        .where(inArray(s.messageAttachments.messageId, ids))
    : [];
  return rows.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    author: users.find((u) => u.id === m.authorId) ?? null,
    authorType: m.authorType,
    body: m.deletedAt ? "" : m.body,
    attachments: m.deletedAt
      ? []
      : atts.filter((a) => a.messageId === m.id).map(({ messageId: _m, ...a }) => a),
    toolCalls: Array.isArray(m.toolCalls)
      ? (m.toolCalls as { name: string }[]).map((t) => ({ name: t.name }))
      : null,
    editedAt: m.editedAt?.toISOString() ?? null,
    deleted: !!m.deletedAt,
    createdAt: m.createdAt.toISOString(),
  }));
}

export const chatRoutes = (deps: Deps & { live: LiveHub }) => {
  const r = router();
  r.use("/chat/*", requireTenant(deps.dbs), teamOnly, requirePermission("chat.use"));

  const system = <T>(tenantId: string, fn: (tx: AppTx) => Promise<T>) =>
    withTenant(deps.dbs.appDb, { tenantId, actor: "system" }, fn);

  /** Participação da pessoa (o RLS já esconde as conversas alheias). */
  const membership = async (tx: AppTx, conv: string, userId: string) => {
    const [row] = await tx
      .select({ c: s.conversations, me: s.conversationParticipants })
      .from(s.conversations)
      .innerJoin(
        s.conversationParticipants,
        and(
          eq(s.conversationParticipants.conversationId, s.conversations.id),
          eq(s.conversationParticipants.userId, userId),
        ),
      )
      .where(eq(s.conversations.id, conv));
    if (!row) throw notFound();
    return row;
  };

  const assertTeamMembers = async (tx: AppTx, ids: string[]) => {
    const rows = await tx
      .select({ id: s.memberships.userId })
      .from(s.memberships)
      .where(
        and(
          inArray(s.memberships.userId, ids),
          eq(s.memberships.active, true),
          ne(s.memberships.role, "cliente"),
        ),
      );
    if (rows.length !== new Set(ids).size)
      throw new AppError(400, "INVALID_REFERENCE", "Alguém selecionado não faz parte da equipe.");
  };

  const one = async (tx: AppTx, userId: string, id: string) => {
    const [c] = await listConversations(tx, userId, id);
    if (!c) throw notFound();
    return c;
  };

  const routes = r
    .openapi(
      createRoute({
        method: "get",
        path: "/chat/conversations",
        tags,
        summary: "Minhas conversas (fixadas primeiro, depois as mais recentes)",
        responses: { 200: ok(z.object({ data: z.array(Conversation), unread: z.number() })) },
      }),
      async (c) => {
        const data = await c.var.tenant.tx((tx) => listConversations(tx, c.var.tenant.userId));
        return c.json({ data, unread: data.filter((x) => x.unread > 0 || x.markedUnread).length }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/chat/conversations",
        tags,
        summary: "Abrir conversa direta (reaproveita a existente) ou criar grupo",
        request: body(conversationInput),
        responses: { 200: ok(Conversation), 201: ok(Conversation, "Criada") },
      }),
      async (c) => {
        const b = c.req.valid("json");
        const t = c.var.tenant;
        const res = await t.tx(async (tx) => {
          if (b.type === "dm") {
            if (b.userId === t.userId) throw new AppError(400, "INVALID_REFERENCE", "Escolha outra pessoa.");
            await assertTeamMembers(tx, [b.userId]);
            const dmKey = [t.userId, b.userId].sort().join(":");
            const [existing] = await tx
              .select({ id: s.conversations.id })
              .from(s.conversations)
              .where(and(eq(s.conversations.type, "dm"), eq(s.conversations.dmKey, dmKey)));
            if (existing) return { created: false, conv: await one(tx, t.userId, existing.id) };
            const [conv] = await tx
              .insert(s.conversations)
              .values({ tenantId: t.tenantId, type: "dm", dmKey, createdBy: t.userId })
              .returning();
            await tx.insert(s.conversationParticipants).values(
              [t.userId, b.userId].map((userId) => ({
                tenantId: t.tenantId,
                conversationId: conv!.id,
                userId,
              })),
            );
            return { created: true, conv: await one(tx, t.userId, conv!.id) };
          }
          const others = [...new Set(b.userIds.filter((u) => u !== t.userId))];
          await assertTeamMembers(tx, others);
          const [conv] = await tx
            .insert(s.conversations)
            .values({ tenantId: t.tenantId, type: "grupo", name: b.name, createdBy: t.userId })
            .returning();
          await tx
            .insert(s.conversationParticipants)
            .values([
              { tenantId: t.tenantId, conversationId: conv!.id, userId: t.userId, isAdmin: true },
              ...others.map((userId) => ({ tenantId: t.tenantId, conversationId: conv!.id, userId })),
            ]);
          return { created: true, conv: await one(tx, t.userId, conv!.id) };
        });
        return res.created ? c.json(res.conv, 201) : c.json(res.conv, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/chat/ai",
        tags,
        summary: "Abrir a minha conversa com o assistente de IA",
        responses: { 200: ok(Conversation) },
      }),
      async (c) => {
        const t = c.var.tenant;
        const conv = await t.tx(async (tx) => {
          const [existing] = await tx
            .select({ id: s.conversations.id })
            .from(s.conversations)
            .where(and(eq(s.conversations.type, "ia"), eq(s.conversations.createdBy, t.userId)));
          if (existing) return one(tx, t.userId, existing.id);
          const [created] = await tx
            .insert(s.conversations)
            .values({ tenantId: t.tenantId, type: "ia", createdBy: t.userId })
            .returning();
          await tx
            .insert(s.conversationParticipants)
            .values({ tenantId: t.tenantId, conversationId: created!.id, userId: t.userId, isAdmin: true });
          return one(tx, t.userId, created!.id);
        });
        return c.json(conv, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/chat/projects/{id}",
        tags,
        summary: "Entrar na conversa do projeto (cria na primeira vez)",
        request: { params: IdParam },
        responses: { 200: ok(Conversation) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const t = c.var.tenant;
        await t.tx((tx) => assertProjectAccess(tx, actorOf(c), id));
        await system(t.tenantId, async (tx) => {
          let [conv] = await tx
            .select({ id: s.conversations.id })
            .from(s.conversations)
            .where(and(eq(s.conversations.type, "projeto"), eq(s.conversations.projectId, id)));
          if (!conv)
            [conv] = await tx
              .insert(s.conversations)
              .values({ tenantId: t.tenantId, type: "projeto", projectId: id, createdBy: t.userId })
              .onConflictDoNothing()
              .returning({ id: s.conversations.id });
          if (!conv)
            [conv] = await tx
              .select({ id: s.conversations.id })
              .from(s.conversations)
              .where(and(eq(s.conversations.type, "projeto"), eq(s.conversations.projectId, id)));
          await tx
            .insert(s.conversationParticipants)
            .values({ tenantId: t.tenantId, conversationId: conv!.id, userId: t.userId })
            .onConflictDoNothing();
        });
        const conv = await t.tx(async (tx) => {
          const [x] = await tx
            .select({ id: s.conversations.id })
            .from(s.conversations)
            .where(and(eq(s.conversations.type, "projeto"), eq(s.conversations.projectId, id)));
          return one(tx, t.userId, x!.id);
        });
        return c.json(conv, 200);
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/chat/conversations/{id}",
        tags,
        summary: "Renomear grupo ou trocar a foto (admin do grupo)",
        request: { params: IdParam, ...body(conversationUpdateInput) },
        responses: { 200: ok(Conversation) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const t = c.var.tenant;
        const conv = await t.tx(async (tx) => {
          const m = await membership(tx, id, t.userId);
          if (m.c.type !== "grupo") throw new AppError(409, "NOT_A_GROUP", "Só grupos têm nome e foto.");
          if (!m.me.isAdmin)
            throw new AppError(403, "FORBIDDEN", "Só quem administra o grupo pode mudar isso.");
          if (b.photoFileId) {
            const [f] = await tx
              .select({ mime: s.files.mimeType })
              .from(s.files)
              .where(and(eq(s.files.id, b.photoFileId), isNull(s.files.deletedAt)));
            if (!f?.mime.startsWith("image/")) throw new AppError(400, "INVALID_IMAGE", "Envie uma imagem.");
          }
          await tx
            .update(s.conversations)
            .set({
              ...(b.name !== undefined ? { name: b.name } : {}),
              ...(b.photoFileId !== undefined ? { photoFileId: b.photoFileId } : {}),
              updatedAt: new Date(),
            })
            .where(eq(s.conversations.id, id));
          return one(tx, t.userId, id);
        });
        return c.json(conv, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/chat/conversations/{id}/participants",
        tags,
        summary: "Adicionar pessoas ao grupo",
        request: { params: IdParam, ...body(z.object({ userIds: z.array(z.uuid()).min(1).max(100) })) },
        responses: { 200: ok(Conversation) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const { userIds } = c.req.valid("json");
        const t = c.var.tenant;
        const conv = await t.tx(async (tx) => {
          const m = await membership(tx, id, t.userId);
          if (m.c.type !== "grupo")
            throw new AppError(409, "NOT_A_GROUP", "Só dá para adicionar pessoas em grupos.");
          if (!m.me.isAdmin)
            throw new AppError(403, "FORBIDDEN", "Só quem administra o grupo pode adicionar.");
          await assertTeamMembers(tx, userIds);
          await tx
            .insert(s.conversationParticipants)
            .values(userIds.map((userId) => ({ tenantId: t.tenantId, conversationId: id, userId })))
            .onConflictDoNothing();
          return one(tx, t.userId, id);
        });
        return c.json(conv, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/chat/conversations/{id}/participants/{userId}",
        tags,
        summary: "Remover alguém do grupo (ou sair dele)",
        request: { params: z.object({ id: z.uuid(), userId: z.uuid() }) },
        responses: noContent,
      }),
      async (c) => {
        const { id, userId } = c.req.valid("param");
        const t = c.var.tenant;
        await t.tx(async (tx) => {
          const m = await membership(tx, id, t.userId);
          if (m.c.type !== "grupo" && !(m.c.type === "projeto" && userId === t.userId))
            throw new AppError(409, "NOT_A_GROUP", "Só dá para sair de grupos e conversas de projeto.");
          if (userId !== t.userId && !m.me.isAdmin)
            throw new AppError(403, "FORBIDDEN", "Só quem administra o grupo pode remover pessoas.");
          await tx
            .delete(s.conversationParticipants)
            .where(
              and(
                eq(s.conversationParticipants.conversationId, id),
                eq(s.conversationParticipants.userId, userId),
              ),
            );
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/chat/conversations/{id}/state",
        tags,
        summary: "Marcar como lida/não lida e fixar",
        request: {
          params: IdParam,
          ...body(z.object({ read: z.boolean().optional(), pinned: z.boolean().optional() })),
        },
        responses: noContent,
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const t = c.var.tenant;
        await t.tx(async (tx) => {
          await membership(tx, id, t.userId);
          await tx
            .update(s.conversationParticipants)
            .set({
              ...(b.read === true ? { lastReadAt: new Date(), markedUnread: false } : {}),
              ...(b.read === false ? { markedUnread: true } : {}),
              ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
            })
            .where(
              and(
                eq(s.conversationParticipants.conversationId, id),
                eq(s.conversationParticipants.userId, t.userId),
              ),
            );
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/chat/conversations/{id}/typing",
        tags,
        summary: 'Avisar que estou digitando (os outros veem "digitando…")',
        request: { params: IdParam },
        responses: noContent,
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const t = c.var.tenant;
        await t.tx((tx) => membership(tx, id, t.userId));
        const name = (c.var.session?.user.name ?? "").replace(/:/g, " ").slice(0, 60);
        await deps.live.publish("recpm_typing", `${t.tenantId}:${id}:${t.userId}:${name}`);
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/chat/conversations/{id}/messages",
        tags,
        summary: "Mensagens (mais antigas primeiro; use before para paginar para trás)",
        request: {
          params: IdParam,
          query: z.object({
            before: z.iso.datetime({ offset: true }).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
        },
        responses: { 200: ok(z.object({ data: z.array(Message), hasMore: z.boolean() })) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const q = c.req.valid("query");
        const t = c.var.tenant;
        const res = await t.tx(async (tx) => {
          await membership(tx, id, t.userId);
          const rows = await tx
            .select()
            .from(s.messages)
            .where(
              and(
                eq(s.messages.conversationId, id),
                q.before ? lt(s.messages.createdAt, new Date(q.before)) : undefined,
              ),
            )
            .orderBy(desc(s.messages.createdAt))
            .limit(q.limit + 1);
          const page = rows.slice(0, q.limit).reverse();
          return { data: await messagesOut(tx, page), hasMore: rows.length > q.limit };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/chat/conversations/{id}/messages",
        tags,
        summary: "Enviar mensagem (na conversa com a IA, devolve também a resposta do assistente)",
        request: { params: IdParam, ...body(messageInput) },
        responses: { 201: ok(z.object({ data: z.array(Message) }), "Enviada") },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const t = c.var.tenant;
        const actor = actorOf(c);
        const { msg, conv } = await t.tx(async (tx) => {
          const m = await membership(tx, id, t.userId);
          if (b.fileIds.length) {
            const found = await tx
              .select({ id: s.files.id })
              .from(s.files)
              .where(and(inArray(s.files.id, b.fileIds), isNull(s.files.deletedAt)));
            if (found.length !== new Set(b.fileIds).size)
              throw new AppError(400, "INVALID_REFERENCE", "Algum anexo não existe mais.");
          }
          const now = new Date();
          const [msg] = await tx
            .insert(s.messages)
            .values({ tenantId: t.tenantId, conversationId: id, authorId: t.userId, body: b.body })
            .returning();
          if (b.fileIds.length)
            await tx.insert(s.messageAttachments).values(
              [...new Set(b.fileIds)].map((fileId) => ({
                tenantId: t.tenantId,
                messageId: msg!.id,
                fileId,
              })),
            );
          await tx.update(s.conversations).set({ lastMessageAt: now }).where(eq(s.conversations.id, id));
          await tx
            .update(s.conversationParticipants)
            .set({ lastReadAt: now, markedUnread: false })
            .where(
              and(
                eq(s.conversationParticipants.conversationId, id),
                eq(s.conversationParticipants.userId, t.userId),
              ),
            );

          // Menções (@Nome) viram notificação; os demais recebem só o push da mensagem.
          const others = await tx
            .select({ id: s.users.id, name: s.users.name })
            .from(s.conversationParticipants)
            .innerJoin(s.users, eq(s.users.id, s.conversationParticipants.userId))
            .where(
              and(
                eq(s.conversationParticipants.conversationId, id),
                ne(s.conversationParticipants.userId, t.userId),
              ),
            );
          const text = b.body.toLowerCase();
          const mentioned = others.filter((o) => {
            const first = o.name.split(" ")[0]!.toLowerCase();
            return (
              text.includes(`@${o.name.toLowerCase()}`) || new RegExp(`@${first}(?![\\p{L}])`, "u").test(text)
            );
          });
          const sender = actor.name ?? "Alguém";
          const convName =
            m.c.type === "grupo" ? (m.c.name ?? "grupo") : m.c.type === "projeto" ? "projeto" : null;
          const preview = b.body ? b.body.slice(0, 140) : "📎 anexo";
          const rows = [
            ...mentioned.map((o) => ({
              tenantId: t.tenantId,
              userId: o.id,
              type: "mencao",
              title: `${sender} mencionou você${convName ? ` em ${convName}` : ""}`,
              message: preview,
              referenceType: "conversation",
              referenceId: id,
            })),
            ...others
              .filter((o) => !mentioned.includes(o))
              .map((o) => ({
                tenantId: t.tenantId,
                userId: o.id,
                type: "chat_mensagem",
                title: convName ? `${sender} em ${convName}` : sender,
                message: preview,
                referenceType: "conversation",
                referenceId: id,
                read: true, // só push: não entra no sino
              })),
          ];
          if (rows.length) await tx.insert(s.notifications).values(rows);
          return { msg: msg!, conv: m.c };
        });

        const out = [msg];
        if (conv.type === "ia") {
          const history = await t.tx((tx) =>
            tx
              .select({ role: s.messages.authorType, body: s.messages.body })
              .from(s.messages)
              .where(and(eq(s.messages.conversationId, id), isNull(s.messages.deletedAt)))
              .orderBy(desc(s.messages.createdAt))
              .limit(20),
          );
          let reply: { content: string; toolCalls: { name: string; args: unknown }[] };
          let authorType: "assistant" | "system" = "assistant";
          try {
            const config = await t.tx((tx) => aiConfig(tx, deps.env));
            const tz = (await t.tx((tx) => tx.select({ tz: s.tenants.timezone }).from(s.tenants)))[0]?.tz;
            reply = await assistantReply({
              withTx: (fn) => t.tx(fn),
              actor,
              config,
              history: history
                .reverse()
                .filter((h) => (h.role === "user" || h.role === "assistant") && h.body)
                .map((h) => ({ role: h.role as "user" | "assistant", content: h.body })),
              tools: { taskVisible: taskVisibleTo as never, projectVisible: projectVisibleTo as never },
              fetchFn: deps.fetch ?? fetch,
              today: new Intl.DateTimeFormat("pt-BR", {
                dateStyle: "full",
                timeZone: tz ?? "America/Sao_Paulo",
              }).format(new Date()),
            });
          } catch (e) {
            authorType = "system";
            reply = {
              content:
                e instanceof AppError ? e.message : "O assistente não respondeu. Tente de novo em instantes.",
              toolCalls: [],
            };
            if (!(e instanceof AppError)) deps.logger.error({ err: e }, "falha no assistente de IA");
          }
          const [ans] = await t.tx((tx) =>
            tx
              .insert(s.messages)
              .values({
                tenantId: t.tenantId,
                conversationId: id,
                authorId: null,
                authorType,
                body: reply.content,
                toolCalls: reply.toolCalls.length ? reply.toolCalls : null,
              })
              .returning(),
          );
          await t.tx((tx) =>
            tx
              .update(s.conversationParticipants)
              .set({ lastReadAt: new Date() })
              .where(
                and(
                  eq(s.conversationParticipants.conversationId, id),
                  eq(s.conversationParticipants.userId, t.userId),
                ),
              ),
          );
          out.push(ans!);
        }
        const data = await t.tx((tx) => messagesOut(tx, out));
        return c.json({ data }, 201);
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/chat/messages/{id}",
        tags,
        summary: "Editar a minha mensagem",
        request: { params: IdParam, ...body(z.object({ body: z.string().trim().min(1).max(10_000) })) },
        responses: { 200: ok(Message) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const t = c.var.tenant;
        const out = await t.tx(async (tx) => {
          const [m] = await tx
            .update(s.messages)
            .set({ body: b.body, editedAt: new Date() })
            .where(
              and(eq(s.messages.id, id), eq(s.messages.authorId, t.userId), isNull(s.messages.deletedAt)),
            )
            .returning();
          if (!m) throw new AppError(404, "MESSAGE_NOT_FOUND", "Mensagem não encontrada.");
          return (await messagesOut(tx, [m]))[0]!;
        });
        return c.json(out, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/chat/messages/{id}",
        tags,
        summary: "Apagar a minha mensagem",
        request: { params: IdParam },
        responses: noContent,
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const t = c.var.tenant;
        await t.tx(async (tx) => {
          const [m] = await tx
            .update(s.messages)
            .set({ deletedAt: new Date() })
            .where(
              and(eq(s.messages.id, id), eq(s.messages.authorId, t.userId), isNull(s.messages.deletedAt)),
            )
            .returning({ id: s.messages.id });
          if (!m) throw new AppError(404, "MESSAGE_NOT_FOUND", "Mensagem não encontrada.");
        });
        return c.body(null, 204);
      },
    );
  return routes;
};
