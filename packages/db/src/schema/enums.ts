/**
 * Enums do Postgres. Valores seguem a especificação: termos de domínio em pt-BR quando
 * a spec os define assim (status de projeto, parcelas…), em inglês quando a spec usa inglês
 * (status de assinatura SaaS, pedidos de ajuste de tempo…). Os rótulos de UI vêm do i18n.
 *
 * Tudo que o admin do tenant pode customizar (colunas do Kanban, tipos de tarefa…) NÃO é enum:
 * vira tabela de catálogo.
 */
import { pgEnum } from "drizzle-orm/pg-core";

// ── Núcleo SaaS ────────────────────────────────────────────────────────────
export const tenantRole = pgEnum("tenant_role", ["admin", "gestor", "funcionario", "cliente"]);
export const tenantStatus = pgEnum("tenant_status", ["active", "read_only", "suspended"]);
export const subscriptionStatus = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
]);
export const billingProvider = pgEnum("billing_provider", ["stripe", "asaas", "manual"]);
export const billingInterval = pgEnum("billing_interval", ["monthly", "yearly"]);

// ── Perfil do membro ───────────────────────────────────────────────────────
export const seniorityLevel = pgEnum("seniority_level", ["junior", "pleno", "senior"]);
export const employmentType = pgEnum("employment_type", ["clt", "pj", "terceirizado"]);

// ── Catálogos ──────────────────────────────────────────────────────────────
export const briefingFieldType = pgEnum("briefing_field_type", [
  "texto",
  "paragrafo",
  "escolha_unica",
  "caixas",
]);

// ── Projetos e tarefas ─────────────────────────────────────────────────────
export const projectModality = pgEnum("project_modality", ["mensal", "avulso"]);
export const projectPeriodicity = pgEnum("project_periodicity", ["mensal", "anual"]);
export const projectStatus = pgEnum("project_status", [
  "planejamento",
  "ativo",
  "em_validacao",
  "pausado",
  "entregue_suporte",
  "concluido",
]);
export const priority = pgEnum("priority", ["baixa", "media", "alta"]);
export const recurrence = pgEnum("recurrence", ["diaria", "semanal", "mensal"]);
/** Por onde a tarefa foi criada — todas contam na cota do plano (§4). */
export const taskSource = pgEnum("task_source", [
  "ui",
  "duplicate",
  "recurrence",
  "api",
  "portal",
  "portal_demand",
  "import",
]);
export const adjustmentKind = pgEnum("adjustment_kind", ["internal", "client"]);
export const reviewStatus = pgEnum("review_status", ["pending", "approved", "rejected"]);
export const demandStatus = pgEnum("demand_status", ["pending", "accepted", "rejected"]);

// ── Financeiro ─────────────────────────────────────────────────────────────
export const contractModality = pgEnum("contract_modality", ["parcelado", "mensalidade"]);
export const contractStatus = pgEnum("contract_status", ["ativo", "concluido", "cancelado"]);
export const installmentStatus = pgEnum("installment_status", ["pendente", "pago", "atrasado", "estornado"]);
export const paymentMethod = pgEnum("payment_method", [
  "pix",
  "boleto",
  "cartao",
  "transferencia",
  "dinheiro",
  "outro",
]);
export const clientSubscriptionStatus = pgEnum("client_subscription_status", ["ativa", "cancelada"]);

// ── Assinatura eletrônica ──────────────────────────────────────────────────
export const signatureStatus = pgEnum("signature_status", [
  "rascunho",
  "enviado",
  "assinado",
  "recusado",
  "cancelado",
]);

// ── Agenda ─────────────────────────────────────────────────────────────────
export const calendarEventType = pgEnum("calendar_event_type", [
  "reuniao",
  "treinamento",
  "podcast",
  "aniversario",
  "feriado",
  "outro",
]);
export const calendarEventSource = pgEnum("calendar_event_source", ["interno", "feriado_api"]);

// ── Comunicação ────────────────────────────────────────────────────────────
export const conversationType = pgEnum("conversation_type", ["dm", "grupo", "ia", "projeto"]);
export const messageAuthorType = pgEnum("message_author_type", ["user", "assistant", "system", "tool"]);

// ── Arquivos, integrações e jobs ───────────────────────────────────────────
export const fileScanStatus = pgEnum("file_scan_status", ["pending", "clean", "infected", "error"]);
export const jobStatus = pgEnum("job_status", ["pending", "running", "succeeded", "failed"]);
export const exportTrigger = pgEnum("export_trigger", ["manual", "schedule"]);
