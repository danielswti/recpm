/**
 * Projetos e tarefas (§5 "Projects"/"Tasks", §6.2, §6.3): schemas de entrada da API e da web.
 */
import { z } from "zod";

export const PROJECT_STATUSES = [
  "planejamento",
  "ativo",
  "em_validacao",
  "pausado",
  "entregue_suporte",
  "concluido",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PRIORITIES = ["baixa", "media", "alta"] as const;
export const PROJECT_MODALITIES = ["mensal", "avulso"] as const;
export const RECURRENCES = ["diaria", "semanal", "mensal"] as const;
export const ADJUSTMENT_KINDS = ["internal", "client"] as const;

/** Conteúdo TipTap (ProseMirror JSON). */
export const richText = z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() });
export type RichTextDoc = z.infer<typeof richText>;

/** Texto puro de um documento TipTap (para busca e para a versão "texto" gravada ao lado). */
export function richTextToPlain(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: string; text?: string; content?: unknown[] };
    if (node.type === "text" && node.text) out.push(node.text);
    if (node.type === "hardBreak") out.push("\n");
    node.content?.forEach(walk);
    if (node.type && ["paragraph", "heading", "listItem", "blockquote", "codeBlock"].includes(node.type))
      out.push("\n");
  };
  walk(doc);
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Texto simples → documento TipTap (um parágrafo por linha). */
export const plainToRichText = (text: string): RichTextDoc => ({
  type: "doc",
  content: text.split("\n").map((line) => ({
    type: "paragraph",
    ...(line ? { content: [{ type: "text", text: line }] } : {}),
  })),
});

const isoDate = z.iso.date();
const optDate = isoDate.nullable().optional();
const optUuid = z.uuid().nullable().optional();
const optCents = z.number().int().min(0).max(1_000_000_000_00).nullable().optional();
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

export const contractItemInput = z.object({
  taskTypeId: z.uuid(),
  quantityPerPeriod: z.number().int().min(1).max(100_000),
  formats: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});

export const projectInput = z
  .object({
    name: z.string().trim().min(1, "Informe o nome.").max(160),
    clientId: optUuid,
    internal: z.boolean().default(false),
    modality: z.enum(PROJECT_MODALITIES).default("avulso"),
    periodicity: z.enum(["mensal", "anual"]).nullable().optional(),
    typeId: optUuid,
    status: z.enum(PROJECT_STATUSES).optional(),
    waitingClient: z.boolean().optional(),
    priority: z.enum(PRIORITIES).optional(),
    startDate: optDate,
    deliveryDeadline: optDate,
    clientDeliveryDate: optDate,
    firstDeliveryDate: optDate,
    feedbackDeadline: optDate,
    supportStart: optDate,
    supportEnd: optDate,
    signedAt: optDate,
    contractEnd: optDate,
    contractIndefinite: z.boolean().optional(),
    deadlineText: optText(200),
    valueCents: optCents,
    recurringValueCents: optCents,
    extraCostCents: optCents,
    extraCostDescription: optText(500),
    managerId: optUuid,
    description: richText.nullable().optional(),
    publicSummary: optText(2000),
    notes: optText(5000),
    tagIds: z.array(z.uuid()).max(30).optional(),
    members: z
      .array(z.object({ userId: z.uuid(), roleId: optUuid }))
      .max(200)
      .optional(),
    contractItems: z.array(contractItemInput).max(50).optional(),
  })
  .refine((p) => p.internal || !!p.clientId || p.clientId === undefined, {
    message: "Projeto de cliente precisa de um cliente.",
    path: ["clientId"],
  });
export type ProjectInput = z.input<typeof projectInput>;

export const duplicateProjectInput = z.object({
  name: z.string().trim().min(1).max(160),
  includeTasks: z.boolean().default(false),
  /** Desloca todas as datas do projeto e prazos das tarefas (ex.: 30 para o próximo mês). */
  shiftDays: z.number().int().min(-3650).max(3650).default(0),
});

export const recurrenceRuleInput = z.object({
  interval: z.number().int().min(1).max(365).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  at: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  until: isoDate.optional(),
  deadlineOffsetDays: z.number().int().min(0).max(365).optional(),
});
export type RecurrenceRuleInput = z.infer<typeof recurrenceRuleInput>;

export const taskInput = z.object({
  title: z.string().trim().min(1, "Informe o título.").max(300),
  projectId: optUuid,
  phaseId: optUuid,
  description: richText.nullable().optional(),
  statusKey: z.string().max(48).optional(),
  assigneeId: optUuid,
  mainRoleId: optUuid,
  taskTypeId: optUuid,
  approverId: optUuid,
  assignees: z
    .array(z.object({ userId: z.uuid(), roleId: optUuid }))
    .max(30)
    .optional(),
  tagIds: z.array(z.uuid()).max(30).optional(),
  driveLink: z
    .union([z.url(), z.literal("")])
    .nullable()
    .optional(),
  deadline: z.iso.datetime({ offset: true }).nullable().optional(),
  deadlineHasTime: z.boolean().optional(),
  clientDeliveryDate: optDate,
  priority: z.enum(PRIORITIES).optional(),
  visibleToClient: z.boolean().optional(),
  estimatedHours: z.number().min(0).max(9999).nullable().optional(),
  pieceQuantity: z.number().int().min(0).max(10_000).optional(),
  recurrence: z.enum(RECURRENCES).nullable().optional(),
  recurrenceRule: recurrenceRuleInput.nullable().optional(),
  /** Itens do checklist ao criar (senão, vem do modelo do tipo de tarefa). */
  checklist: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
});
export type TaskInput = z.input<typeof taskInput>;

export const adjustmentInput = z.object({
  reasonId: z.uuid(),
  kind: z.enum(ADJUSTMENT_KINDS),
  description: z.string().trim().max(2000).nullable().optional(),
});
export type AdjustmentInput = z.infer<typeof adjustmentInput>;

/** Mover card: coluna de destino e vizinhos (para a ordem); ajuste obrigatório ao ir para `ajustes`. */
export const moveTaskInput = z.object({
  statusKey: z.string().min(1).max(48),
  afterId: z.uuid().nullable().optional(),
  beforeId: z.uuid().nullable().optional(),
  adjustment: adjustmentInput.optional(),
});

export const TASK_BULK_ACTIONS = ["move", "assign", "deadline", "archive", "priority"] as const;
export const bulkTaskInput = z.object({
  ids: z.array(z.uuid()).min(1).max(200),
  action: z.enum(TASK_BULK_ACTIONS),
  statusKey: z.string().max(48).optional(),
  assigneeId: z.uuid().nullable().optional(),
  deadline: z.iso.datetime({ offset: true }).nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
});

export const TASK_SCOPES = ["mine", "team", "all"] as const;
export const taskFilters = z.object({
  scope: z.enum(TASK_SCOPES).default("all"),
  status: z.string().max(48).optional(),
  overdue: z.stringbool().optional(),
  due24h: z.stringbool().optional(),
  waitingClient: z.stringbool().optional(),
  projectId: z.uuid().optional(),
  clientId: z.uuid().optional(),
  assigneeId: z.uuid().optional(),
  typeId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  archived: z.stringbool().optional(),
  archiveRequested: z.stringbool().optional(),
  /** Sem projeto (tarefas avulsas). */
  standalone: z.stringbool().optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["deadline", "board", "recent", "priority"]).default("deadline"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type TaskFilters = z.input<typeof taskFilters>;

export const projectFilters = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  clientId: z.uuid().optional(),
  managerId: z.uuid().optional(),
  typeId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  archived: z.stringbool().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export const phaseInput = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(120),
  startDate: optDate,
  endDate: optDate,
  completed: z.boolean().optional(),
});

export const milestoneInput = z.object({
  title: z.string().trim().min(1, "Informe o título.").max(160),
  date: isoDate,
  completed: z.boolean().optional(),
  visibleToClient: z.boolean().optional(),
});

export const commentInput = z.object({
  body: richText,
  visibleToClient: z.boolean().optional(),
});

export const folderInput = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(120),
  parentId: optUuid,
  visibleToClient: z.boolean().optional(),
});

/** Anexo: arquivo já enviado (fileId) OU link externo (url). */
export const attachmentInput = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    fileId: z.uuid().optional(),
    url: z.url().max(2000).optional(),
    folderId: optUuid,
    visibleToClient: z.boolean().optional(),
  })
  .refine((a) => !!a.fileId !== !!a.url, { message: "Envie um arquivo ou um link.", path: ["url"] });

export const projectColumnsInput = z.object({
  columns: z
    .array(
      z.object({
        key: z.string().min(1).max(48),
        visible: z.boolean(),
        labelOverride: z.string().trim().max(60).nullable().optional(),
      }),
    )
    .max(50),
});

export const uploadRequestInput = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 ** 3),
});

export const checklistItemInput = z.object({
  text: z.string().trim().min(1).max(300),
  done: z.boolean().optional(),
});

export const archiveRequestInput = z.object({ reason: z.string().trim().max(1000).optional() });
export const archiveDecisionInput = z.object({ approve: z.boolean() });
