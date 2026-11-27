/** Tempo, entregas e configurações do workspace (Fase 5). */
import { z } from "zod";
import { businessHoursInput } from "./catalogs";

const reason = z.string().trim().min(3, "Explique o motivo.").max(500);

export const timeAdjustmentInput = z.union([
  z.object({
    taskId: z.uuid(),
    /** Acréscimo (positivo) ou desconto (negativo), em minutos. */
    deltaMinutes: z
      .number()
      .int()
      .min(-24 * 60)
      .max(24 * 60)
      .refine((n) => n !== 0, "Informe os minutos."),
    reason,
  }),
  z.object({
    timeEntryId: z.uuid(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    reason,
  }),
]);
export type TimeAdjustmentInput = z.input<typeof timeAdjustmentInput>;

export const reviewInput = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const deliveryInput = z.object({
  quantity: z.number().int().min(1).max(1000),
  note: z.string().trim().max(500).nullable().optional(),
});
export type DeliveryInput = z.input<typeof deliveryInput>;

export const timeEntriesFilters = z.object({
  userId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

// ── Configurações do workspace (§6.12) ───────────────────────────────────────

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor no formato #RRGGBB.");

export const operationSettingsInput = z.object({
  timezone: z.string().min(1).max(60),
  clientChaseSlaBusinessHours: z.number().int().min(1).max(500),
  idleCardHours: z.number().int().min(1).max(1000),
  defaultBusinessHours: businessHoursInput,
});
export type OperationSettingsInput = z.input<typeof operationSettingsInput>;

const weight = z.number().min(-1000).max(1000);
export const productivityWeightsInput = z.object({
  production: z.object({
    perPiece: weight,
    perBusinessHour: weight,
    onTimeBonus: weight,
    reworkPenalty: weight,
  }),
  accountManagement: z.object({
    perClientChase: weight,
    perShootBooked: weight,
    perPiece: weight,
    perIdleCard: weight,
    idleCardPenaltyCap: weight,
  }),
});
export type ProductivityWeightsInput = z.input<typeof productivityWeightsInput>;

export const brandingInput = z.object({
  primaryColor: hex.nullable().optional(),
  secondaryColor: hex.nullable().optional(),
  chatColor: hex.nullable().optional(),
  logoFileId: z.uuid().nullable().optional(),
  faviconFileId: z.uuid().nullable().optional(),
  logoScale: z.number().min(0.5).max(2).nullable().optional(),
});
export type BrandingInput = z.input<typeof brandingInput>;

export const aiSettingsInput = z.object({
  enabled: z.boolean(),
  assistantName: z.string().trim().max(40).nullable().optional(),
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(300)
    .nullable()
    .optional()
    .or(z.literal("")),
  model: z.string().trim().max(100).nullable().optional(),
  /** undefined = mantém; null = apaga; texto = troca. Nunca volta para o front. */
  apiKey: z.string().trim().min(8).max(500).nullable().optional(),
});
export type AiSettingsInput = z.input<typeof aiSettingsInput>;

export const apiKeyInput = z.object({
  name: z.string().trim().min(2).max(60),
  expiresAt: z.iso.date().nullable().optional(),
});
