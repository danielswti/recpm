/**
 * Chat, notificações, push e notas pessoais (§5 "Communication", §6.9, §6.10).
 * RLS extra: conversas só para participantes; notificações/notas/push só para o dono.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, tenantUnique, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { conversationType, messageAuthorType } from "./enums";
import { files } from "./files";
import { projects, type RichText } from "./projects";
import { tenantId } from "./tenants";

export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    tenantId: tenantId(),
    type: conversationType().notNull(),
    name: text(),
    photoFileId: uuid(),
    projectId: uuid(),
    /** Para DMs: "menorUserId:maiorUserId" — impede duas DMs entre as mesmas pessoas. */
    dmKey: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    lastMessageAt: tstz(),
    ...timestamps,
  },
  (t) => [
    tenantUnique("conversations_tenant_id_uq", t),
    tfk("conversations_project_fk", t, t.projectId, projects).onDelete("cascade"),
    tfk("conversations_photo_fk", t, t.photoFileId, files),
    uniqueIndex("conversations_dm_uq").on(t.tenantId, t.dmKey).where(sql`${t.type} = 'dm'`),
    uniqueIndex("conversations_project_uq")
      .on(t.tenantId, t.projectId)
      .where(sql`${t.type} = 'projeto'`),
  ],
);

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    tenantId: tenantId(),
    conversationId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isAdmin: boolean().notNull().default(false),
    lastReadAt: tstz(),
    pinned: boolean().notNull().default(false),
    markedUnread: boolean().notNull().default(false),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "conversation_participants_pk", columns: [t.conversationId, t.userId] }),
    tfk("conversation_participants_conv_fk", t, t.conversationId, conversations).onDelete(
      "cascade",
    ),
    index("conversation_participants_user_idx").on(t.tenantId, t.userId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    tenantId: tenantId(),
    conversationId: uuid().notNull(),
    /** NULL quando o autor é o assistente de IA / sistema. */
    authorId: uuid().references(() => users.id, { onDelete: "set null" }),
    authorType: messageAuthorType().notNull().default("user"),
    body: text().notNull(),
    /** Chamadas de ferramenta da IA (Vercel AI SDK), para auditoria e reexibição. */
    toolCalls: jsonb(),
    editedAt: tstz(),
    deletedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantUnique("messages_tenant_id_uq", t),
    tfk("messages_conversation_fk", t, t.conversationId, conversations).onDelete("cascade"),
    index("messages_conversation_idx").on(t.tenantId, t.conversationId, t.createdAt.desc()),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    tenantId: tenantId(),
    messageId: uuid().notNull(),
    fileId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ name: "message_attachments_pk", columns: [t.messageId, t.fileId] }),
    tfk("message_attachments_message_fk", t, t.messageId, messages).onDelete("cascade"),
    tfk("message_attachments_file_fk", t, t.fileId, files),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Ex.: tarefa_aprovacao_pendente, tarefa_atribuida, prazo_proximo, sla_cobranca… */
    type: text().notNull(),
    title: text().notNull(),
    message: text(),
    referenceType: text(),
    referenceId: uuid(),
    read: boolean().notNull().default(false),
    readAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_idx").on(t.tenantId, t.userId, t.createdAt.desc()),
    index("notifications_unread_idx")
      .on(t.tenantId, t.userId)
      .where(sql`NOT ${t.read}`),
  ],
);

/** Preferência por tipo de notificação × canal. Sem linha = padrão do tipo. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    inApp: boolean().notNull().default(true),
    email: boolean().notNull().default(true),
    push: boolean().notNull().default(true),
  },
  (t) => [primaryKey({ name: "notification_preferences_pk", columns: [t.tenantId, t.userId, t.type] })],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    userAgent: text(),
    lastUsedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_uq").on(t.tenantId, t.endpoint),
    index("push_subscriptions_user_idx").on(t.tenantId, t.userId),
  ],
);

/** Widget de notas rápidas do dashboard. Privadas do usuário (RLS de dono). */
export const personalNotes = pgTable(
  "personal_notes",
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: jsonb().$type<RichText>().notNull(),
    archived: boolean().notNull().default(false),
    position: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [index("personal_notes_user_idx").on(t.tenantId, t.userId, t.archived, t.position)],
);
