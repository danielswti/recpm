/**
 * Planos padrão (§4). Ficam no banco e são editáveis pelo super_admin — nada é hard-coded na
 * aplicação.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type PlanFeatures, type PlanLimits, plans } from "../schema";

const f = (over: Partial<PlanFeatures>): PlanFeatures => ({
  clientPortal: false,
  eSignature: false,
  publicApi: false,
  aiAssistant: false,
  customDomain: false,
  advancedReports: false,
  outgoingWebhooks: false,
  sso: false,
  ...over,
});
const l = (tasksPerCycle: number | null, maxUsers: number | null, storageGb: number): PlanLimits => ({
  tasksPerCycle,
  maxUsers,
  maxClientPortalUsers: maxUsers === null ? null : maxUsers * 2,
  storageGb,
  aiMessagesPerCycle: tasksPerCycle === null ? null : tasksPerCycle * 2,
});

/**
 * Planos definidos pelo usuário em 2026-11-26 (preços mensais em centavos, BRL).
 * Opção anual fica desligada (priceYearlyCents null) até haver preço anual definido.
 */
export const DEFAULT_PLANS = [
  {
    slug: "basico",
    name: "Básico",
    sortOrder: 0,
    priceMonthlyCents: 0,
    priceYearlyCents: null,
    trialDays: 0,
    limits: l(50, 3, 1),
    features: f({}),
  },
  {
    slug: "essencial",
    name: "Essencial",
    sortOrder: 1,
    priceMonthlyCents: 9900,
    priceYearlyCents: null,
    limits: l(300, 10, 20),
    features: f({ clientPortal: true }),
  },
  {
    slug: "profissional",
    name: "Profissional",
    sortOrder: 2,
    priceMonthlyCents: 24700,
    priceYearlyCents: null,
    limits: l(1500, 30, 100),
    features: f({ clientPortal: true, eSignature: true, aiAssistant: true, publicApi: true }),
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    sortOrder: 3,
    priceMonthlyCents: 31900,
    priceYearlyCents: null,
    priceIsStartingAt: true,
    limits: l(null, null, 2000),
    features: f({
      clientPortal: true,
      eSignature: true,
      aiAssistant: true,
      publicApi: true,
      customDomain: true,
      advancedReports: true,
      outgoingWebhooks: true,
      sso: true,
    }),
  },
] as const;

/** Plano usado durante o trial de 14 dias. */
export const TRIAL_PLAN_SLUG = "profissional";

/** Plano para onde o tenant volta quando o trial acaba sem assinatura paga. */
export const FREE_PLAN_SLUG = "basico";

// biome-ignore lint/suspicious/noExplicitAny: aceita qualquer instância/tx do Drizzle com este schema
export async function seedPlans(db: NodePgDatabase<any>): Promise<number> {
  const rows = await db
    .insert(plans)
    .values(DEFAULT_PLANS.map((p) => ({ ...p })))
    .onConflictDoNothing()
    .returning({ id: plans.id });
  return rows.length;
}
