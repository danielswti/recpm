/** Financeiro da agência e assinatura eletrônica (Fase 7). */
import { z } from "zod";

export const CONTRACT_MODALITIES = ["parcelado", "mensalidade"] as const;
export const PAYMENT_METHODS = ["pix", "boleto", "cartao", "transferencia", "dinheiro", "outro"] as const;

const cents = z.number().int().min(0).max(100_000_000_000);

export const contractInput = z.object({
  modality: z.enum(CONTRACT_MODALITIES),
  totalValueCents: cents.min(1),
  installmentsCount: z.number().int().min(1).max(120),
  firstDueDate: z.iso.date(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type ContractInput = z.input<typeof contractInput>;

export const contractStatusInput = z.object({ status: z.enum(["ativo", "cancelado"]) });

export const paymentInput = z.object({
  paidAt: z.iso.date(),
  paidAmountCents: cents.min(1),
  method: z.enum(PAYMENT_METHODS),
  note: z.string().trim().max(500).nullable().optional(),
});
export type PaymentInputBody = z.input<typeof paymentInput>;

export const clientSubscriptionInput = z.object({
  clientId: z.uuid(),
  projectId: z.uuid().nullable().optional(),
  amountCents: cents.min(1),
  dayOfMonth: z.number().int().min(1).max(31),
  startedAt: z.iso.date(),
});
export type ClientSubscriptionInput = z.input<typeof clientSubscriptionInput>;

export const signatureRequestInput = z.object({
  projectId: z.uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  documentFileId: z.uuid(),
  message: z.string().trim().max(2000).nullable().optional(),
  signers: z
    .array(z.object({ name: z.string().trim().min(2).max(120), email: z.email().max(200) }))
    .min(1)
    .max(20),
});
export type SignatureRequestInput = z.input<typeof signatureRequestInput>;

export const signInput = z.object({
  /** Nome digitado como assinatura (precisa bater com o do signatário). */
  typedName: z.string().trim().min(2).max(120),
  agree: z.literal(true),
});
export const refuseInput = z.object({ reason: z.string().trim().min(3).max(1000) });
