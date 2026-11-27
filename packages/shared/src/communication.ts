/** Agenda, notificações e chat (Fase 6). */
import { z } from "zod";

// ── Notificações ─────────────────────────────────────────────────────────────

/** Tipos de notificação e os canais ligados por padrão (o usuário muda nas preferências). */
export const NOTIFICATION_TYPES = {
  tarefa_atribuida: { email: false, push: true },
  tarefa_aprovacao_pendente: { email: true, push: true },
  tarefa_ajuste: { email: false, push: true },
  tarefa_comentario: { email: false, push: true },
  tarefa_arquivamento_pedido: { email: true, push: true },
  prazo_proximo: { email: false, push: true },
  prazo_vencido: { email: true, push: true },
  cobranca_cliente_sla: { email: true, push: true },
  ajuste_tempo_pendente: { email: true, push: true },
  ajuste_tempo_aprovado: { email: false, push: true },
  ajuste_tempo_recusado: { email: false, push: true },
  mencao: { email: true, push: true },
  chat_mensagem: { email: false, push: true },
  parcela_atrasada: { email: true, push: true },
  assinatura_concluida: { email: true, push: true },
  assinatura_recusada: { email: true, push: true },
} as const satisfies Record<string, { email: boolean; push: boolean }>;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

export const notificationPreferencesInput = z.object({
  preferences: z
    .array(
      z.object({
        type: z.enum(NOTIFICATION_TYPE_KEYS as [NotificationType, ...NotificationType[]]),
        inApp: z.boolean(),
        email: z.boolean(),
        push: z.boolean(),
      }),
    )
    .max(50),
});

export const pushSubscriptionInput = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

// ── Agenda ───────────────────────────────────────────────────────────────────

export const CALENDAR_EVENT_TYPES = [
  "reuniao",
  "treinamento",
  "podcast",
  "aniversario",
  "feriado",
  "outro",
] as const;

export const calendarEventInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  date: z.iso.date(),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
  type: z.enum(CALENDAR_EVENT_TYPES).default("outro"),
  yearlyRecurring: z.boolean().default(false),
  isDayOff: z.boolean().default(false),
  projectId: z.uuid().nullable().optional(),
});
export type CalendarEventInput = z.input<typeof calendarEventInput>;

export const calendarQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  tab: z.enum(["schedule", "team", "deliveries"]).default("schedule"),
  types: z.string().optional(),
  mine: z.stringbool().optional(),
});

export const holidayImportInput = z.object({
  year: z.number().int().min(2000).max(2100),
  national: z.boolean().default(true),
});

// ── Chat ─────────────────────────────────────────────────────────────────────

export const conversationInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dm"), userId: z.uuid() }),
  z.object({
    type: z.literal("grupo"),
    name: z.string().trim().min(1).max(80),
    userIds: z.array(z.uuid()).min(1).max(100),
  }),
]);
export type ConversationInput = z.input<typeof conversationInput>;

export const conversationUpdateInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  photoFileId: z.uuid().nullable().optional(),
});

export const messageInput = z
  .object({
    body: z.string().trim().max(10_000).default(""),
    fileIds: z.array(z.uuid()).max(10).default([]),
  })
  .refine((m) => m.body.length > 0 || m.fileIds.length > 0, "Escreva algo ou anexe um arquivo.");
export type MessageInput = z.input<typeof messageInput>;

/** Para onde a notificação leva (no app web). */
export function notificationPath(referenceType: string | null, referenceId: string | null): string {
  if (!referenceType || !referenceId) return "/";
  switch (referenceType) {
    case "task":
      return `/tarefas?task=${referenceId}`;
    case "project":
      return `/projetos/${referenceId}`;
    case "time_adjustment":
      return "/aprovacoes";
    case "conversation":
      return `/chat?c=${referenceId}`;
    case "finance":
      return "/financeiro";
    case "signature":
      return `/projetos/${referenceId}?tab=assinaturas`;
    default:
      return "/";
  }
}
