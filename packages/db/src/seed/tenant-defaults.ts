/**
 * Padrões de um tenant novo (§4 "seeded defaults", §5 catálogos). Roda na MESMA transação que
 * cria o tenant, dentro de withTenant(<tenantId>), então ou tudo é criado ou nada é.
 */
import type { BusinessHours, ProductivityWeights, TenantOperationSettings } from "../schema";
import {
  adjustmentReasons,
  kanbanColumns,
  projectTypes,
  reportCategories,
  sectors,
  taskRoles,
  taskTypeChecklistItems,
  taskTypes,
  tenantSecrets,
  tenantSettings,
} from "../schema";
import type { AppTx } from "../tenant-context";

export const DEFAULT_KANBAN_COLUMNS = [
  { key: "demandas", label: "Produzir briefing", emoji: "📝", color: "#94a3b8" },
  { key: "a_fazer", label: "Pronto para executar", emoji: "📋", color: "#64748b" },
  { key: "executar_primeiro", label: "Executar primeiro", emoji: "🔥", color: "#f97316" },
  { key: "em_andamento", label: "Em andamento", emoji: "⚙️", color: "#3b82f6" },
  { key: "ajustes", label: "Ajustes", emoji: "🔁", color: "#eab308" },
  {
    key: "aguardando_aprovacao",
    label: "Aprovação interna",
    emoji: "👀",
    color: "#a855f7",
    isApproval: true,
  },
  { key: "enviar_cliente", label: "Enviar ao cliente", emoji: "📤", color: "#06b6d4" },
  { key: "aguardando_cliente", label: "Aguardando cliente", emoji: "⏳", color: "#f59e0b" },
  { key: "veicular", label: "Veicular", emoji: "📣", color: "#14b8a6" },
  { key: "concluido", label: "Concluído", emoji: "✅", color: "#22c55e", isFinal: true },
] as const;

const REPORT_CATEGORIES = [
  { slug: "artes", label: "Artes", color: "#ec4899" },
  { slug: "videos", label: "Vídeos", color: "#6366f1" },
  { slug: "captacoes", label: "Captações", color: "#f97316" },
  { slug: "planejamento", label: "Planejamento", color: "#14b8a6" },
] as const;
type CategorySlug = (typeof REPORT_CATEGORIES)[number]["slug"];

const PROJECT_TYPES = [
  { slug: "avulso", label: "Avulso" },
  { slug: "mensal", label: "Mensal" },
  { slug: "evento", label: "Evento" },
  { slug: "clipe", label: "Clipe" },
] as const;

const TASK_TYPES: {
  slug: string;
  label: string;
  hours: number;
  category: CategorySlug | null;
  checklist?: string[];
}[] = [
  { slug: "arte_digital", label: "Arte digital", hours: 2, category: "artes" },
  { slug: "capa", label: "Capa", hours: 1.5, category: "artes" },
  { slug: "identidade_visual", label: "Identidade visual", hours: 20, category: "artes" },
  {
    slug: "captacao",
    label: "Captação",
    hours: 4,
    category: "captacoes",
    checklist: ["Confirmar local e horário", "Checar equipamento", "Backup do material"],
  },
  { slug: "fotos", label: "Fotos", hours: 3, category: "captacoes" },
  {
    slug: "edicao",
    label: "Edição",
    hours: 4,
    category: "videos",
    checklist: ["Decupagem", "Montagem", "Trilha e mixagem", "Correção de cor", "Exportar formatos"],
  },
  { slug: "filme", label: "Filme", hours: 16, category: "videos" },
  { slug: "email_marketing", label: "E-mail marketing", hours: 2, category: "planejamento" },
  { slug: "trafego_pago", label: "Tráfego pago", hours: 3, category: "planejamento" },
];

const ADJUSTMENT_REASONS = [
  ["briefing_errado", "Briefing errado"],
  ["erro_ortografia", "Erro de ortografia"],
  ["erro_render", "Erro de render"],
  ["empacotamento", "Empacotamento de arquivos"],
  ["abaixo_padrao", "Abaixo do padrão de qualidade"],
  ["ajustes_nao_aplicados", "Ajustes anteriores não aplicados"],
  ["roteiro_errado", "Roteiro errado"],
  ["trilha_inadequada", "Trilha inadequada"],
  ["fora_do_briefing", "Fora do briefing"],
  ["captacao_fora_briefing", "Captação não seguiu o briefing"],
  ["gosto_cliente", "Gosto pessoal do cliente"],
  ["outro", "Outro"],
] as const;

const SECTORS = ["Criação", "Audiovisual", "Atendimento", "Planejamento"];
const TASK_ROLES = ["Editor", "Designer", "Videomaker", "Copywriter", "Fotógrafo", "Atendimento"];

const WEEKDAY_9_18: BusinessHours = {
  days: Object.fromEntries(
    [1, 2, 3, 4, 5].map((d) => [
      d,
      [
        { start: "09:00", end: "12:00" },
        { start: "13:00", end: "18:00" },
      ],
    ]),
  ) as BusinessHours["days"],
};

export const DEFAULT_OPERATION: TenantOperationSettings = {
  clientChaseSlaBusinessHours: 16,
  idleCardHours: 48,
  holidayImport: { national: true, states: [] },
  defaultBusinessHours: WEEKDAY_9_18,
};

export const DEFAULT_PRODUCTIVITY_WEIGHTS: ProductivityWeights = {
  production: { perPiece: 10, perBusinessHour: 1, onTimeBonus: 5, reworkPenalty: 3 },
  accountManagement: {
    perClientChase: 2,
    perShootBooked: 5,
    perPiece: 2,
    perIdleCard: -5,
    idleCardPenaltyCap: -30,
  },
};

export async function seedTenantDefaults(tx: AppTx, tenantId: string): Promise<void> {
  await tx.insert(tenantSettings).values({
    tenantId,
    operation: DEFAULT_OPERATION,
    productivityWeights: DEFAULT_PRODUCTIVITY_WEIGHTS,
  });
  await tx.insert(tenantSecrets).values({ tenantId });

  await tx
    .insert(kanbanColumns)
    .values(DEFAULT_KANBAN_COLUMNS.map((c, i) => ({ ...c, tenantId, position: i })));

  const cats = await tx
    .insert(reportCategories)
    .values(REPORT_CATEGORIES.map((c, i) => ({ ...c, tenantId, position: i })))
    .returning({ id: reportCategories.id, slug: reportCategories.slug });
  const catId = new Map(cats.map((c) => [c.slug, c.id]));

  await tx.insert(projectTypes).values(PROJECT_TYPES.map((p, i) => ({ ...p, tenantId, position: i })));

  const types = await tx
    .insert(taskTypes)
    .values(
      TASK_TYPES.map((t, i) => ({
        tenantId,
        slug: t.slug,
        label: t.label,
        defaultEstimatedHours: t.hours,
        reportCategoryId: t.category ? catId.get(t.category) : null,
        position: i,
      })),
    )
    .returning({ id: taskTypes.id, slug: taskTypes.slug });
  const typeId = new Map(types.map((t) => [t.slug, t.id]));
  const checklist = TASK_TYPES.flatMap((t) =>
    (t.checklist ?? []).map((text, position) => ({
      tenantId,
      taskTypeId: typeId.get(t.slug)!,
      text,
      position,
    })),
  );
  if (checklist.length) await tx.insert(taskTypeChecklistItems).values(checklist);

  await tx
    .insert(adjustmentReasons)
    .values(ADJUSTMENT_REASONS.map(([slug, label], i) => ({ tenantId, slug, label, position: i })));
  await tx.insert(sectors).values(SECTORS.map((name, i) => ({ tenantId, name, position: i })));
  await tx.insert(taskRoles).values(TASK_ROLES.map((name, i) => ({ tenantId, name, position: i })));
}
