/**
 * Planos padrão (§4). Ficam no banco e são editáveis pelo super_admin — nada é hard-coded na
 * aplicação. Preços são PROVISÓRIOS (a definir antes da Fase 2, quando entra a cobrança).
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

export const DEFAULT_PLANS = [
  {
    slug: "free",
    name: "Free",
    sortOrder: 0,
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    limits: l(50, 3, 1),
    features: f({}),
  },
  {
    slug: "starter",
    name: "Starter",
    sortOrder: 1,
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    limits: l(300, 10, 20),
    features: f({ clientPortal: true }),
  },
  {
    slug: "pro",
    name: "Pro",
    sortOrder: 2,
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    limits: l(1500, 30, 100),
    features: f({ clientPortal: true, eSignature: true, aiAssistant: true, publicApi: true }),
  },
  {
    slug: "business",
    name: "Business",
    sortOrder: 3,
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    limits: l(5000, 100, 500),
    features: f({
      clientPortal: true,
      eSignature: true,
      aiAssistant: true,
      publicApi: true,
      customDomain: true,
      advancedReports: true,
      outgoingWebhooks: true,
    }),
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    sortOrder: 4,
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    isPublic: false,
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
export const TRIAL_PLAN_SLUG = "pro";

// biome-ignore lint/suspicious/noExplicitAny: aceita qualquer instância/tx do Drizzle com este schema
export async function seedPlans(db: NodePgDatabase<any>): Promise<number> {
  const rows = await db
    .insert(plans)
    .values(DEFAULT_PLANS.map((p) => ({ ...p })))
    .onConflictDoNothing()
    .returning({ id: plans.id });
  return rows.length;
}
