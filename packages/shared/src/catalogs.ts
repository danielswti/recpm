/**
 * Cadastros (§5 "Catalogs", §6.7, §6.12): schemas de entrada usados pela API e pelos formulários da web.
 */
import { z } from "zod";

/** Catálogos simples: todos têm rótulo, cor, ícone, posição e ativo. */
export const SIMPLE_CATALOGS = [
  "project-types",
  "report-categories",
  "adjustment-reasons",
  "tags",
  "project-tags",
  "sectors",
  "task-roles",
] as const;
export type SimpleCatalog = (typeof SIMPLE_CATALOGS)[number];

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Cor no formato #RRGGBB.")
  .nullable();
const label = z.string().trim().min(1, "Informe o nome.").max(80);

export const catalogItemInput = z.object({
  label,
  color: color.optional(),
  icon: z.string().trim().max(40).nullable().optional(),
  active: z.boolean().optional(),
});
export type CatalogItemInput = z.infer<typeof catalogItemInput>;

export const reorderInput = z.object({ ids: z.array(z.uuid()).min(1).max(500) });

export const taskTypeInput = catalogItemInput.extend({
  defaultEstimatedHours: z.number().min(0).max(999).nullable().optional(),
  sellable: z.boolean().optional(),
  usableAsType: z.boolean().optional(),
  countsAsPiece: z.boolean().optional(),
  reportCategoryId: z.uuid().nullable().optional(),
  /** Modelo de checklist, na ordem. Substitui o anterior inteiro. */
  checklist: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
});
export type TaskTypeInput = z.infer<typeof taskTypeInput>;

export const kanbanColumnInput = z.object({
  label,
  color: color.optional(),
  emoji: z.string().trim().max(8).nullable().optional(),
  isApproval: z.boolean().optional(),
  isFinal: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type KanbanColumnInput = z.infer<typeof kanbanColumnInput>;

/** Colunas com regra própria no fluxo (§6.3): não podem ser apagadas nem desativadas. */
export const SYSTEM_COLUMN_KEYS = ["ajustes", "aguardando_cliente"] as const;

export const BRIEFING_FIELD_TYPES = ["texto", "paragrafo", "escolha_unica", "caixas"] as const;
export const briefingFieldInput = z
  .object({
    label: z.string().trim().min(1).max(200),
    type: z.enum(BRIEFING_FIELD_TYPES),
    options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    allowOther: z.boolean().default(false),
    required: z.boolean().default(false),
    help: z.string().trim().max(500).nullable().optional(),
  })
  .refine((f) => (f.type === "escolha_unica" || f.type === "caixas" ? f.options.length >= 2 : true), {
    message: "Campos de escolha precisam de pelo menos 2 opções.",
    path: ["options"],
  });
export const briefingFormInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  taskTypeId: z.uuid().nullable().optional(),
  projectTypeId: z.uuid().nullable().optional(),
  active: z.boolean().optional(),
  fields: z.array(briefingFieldInput).max(100),
});
export type BriefingFormInput = z.input<typeof briefingFormInput>;

// ── Clientes ────────────────────────────────────────────────────────────────

const onlyDigits = (s: string) => s.replace(/\D/g, "");

/** Valida CPF (11) ou CNPJ (14) pelos dígitos verificadores. */
export function isValidDocument(raw: string): boolean {
  const d = onlyDigits(raw);
  if (/^(\d)\1+$/.test(d)) return false;
  const check = (base: string, weights: number[]) => {
    const sum = weights.reduce((s, w, i) => s + Number(base[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  if (d.length === 11) {
    const w1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
    const w2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
    return check(d, w1) === Number(d[9]) && check(d, w2) === Number(d[10]);
  }
  if (d.length === 14) {
    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    return check(d, w1) === Number(d[12]) && check(d, w2) === Number(d[13]);
  }
  return false;
}

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable()
    .optional();

export const clientInput = z.object({
  code: z
    .string()
    .trim()
    .min(2, "Código com 2 a 12 caracteres.")
    .max(12, "Código com 2 a 12 caracteres.")
    .regex(/^[A-Za-z0-9_-]+$/, "Use letras, números, - ou _.")
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1, "Informe o nome.").max(160),
  email: z
    .union([z.email("E-mail inválido."), z.literal("")])
    .nullable()
    .optional()
    .transform((v) => v || null),
  phone: optText(40),
  document: z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((v) => (v ? onlyDigits(v) : null))
    .refine((v) => v === null || isValidDocument(v), "CPF ou CNPJ inválido."),
  notes: optText(5000),
  assetsLink: z
    .union([z.url("Link inválido."), z.literal("")])
    .nullable()
    .optional()
    .transform((v) => v || null),
  active: z.boolean().optional(),
});
export type ClientInput = z.input<typeof clientInput>;

/** Sugere um código a partir do nome ("Café Aroma Ltda" → "CAFEAR"). */
export const suggestClientCode = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((w, _i, a) => w.slice(0, a.length === 1 ? 6 : 3))
    .join("")
    .slice(0, 8);

// ── Usuários (perfil de trabalho do vínculo, §3) ────────────────────────────

export const SENIORITY_LEVELS = ["junior", "pleno", "senior"] as const;
export const EMPLOYMENT_TYPES = ["clt", "pj", "terceirizado"] as const;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora no formato HH:mm.");
export const businessHoursInput = z.object({
  days: z.partialRecord(
    z.enum(["0", "1", "2", "3", "4", "5", "6"]),
    z
      .array(z.object({ start: hhmm, end: hhmm }).refine((r) => r.start < r.end, "Início antes do fim."))
      .max(4),
  ),
});

export const memberProfileInput = z.object({
  role: z.enum(["admin", "gestor", "funcionario"]).optional(),
  jobTitle: optText(80),
  level: z.enum(SENIORITY_LEVELS).nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable().optional(),
  sectorId: z.uuid().nullable().optional(),
  defaultTaskRoleId: z.uuid().nullable().optional(),
  isAccountManager: z.boolean().optional(),
  hourlyCostCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  phone: optText(40),
  whatsapp: optText(40),
  birthday: z.iso.date().nullable().optional(),
  hireDate: z.iso.date().nullable().optional(),
  timezone: z.string().max(60).nullable().optional(),
  /** NULL = herda o horário padrão do workspace. */
  businessHours: businessHoursInput.nullable().optional(),
});
export type MemberProfileInput = z.input<typeof memberProfileInput>;
