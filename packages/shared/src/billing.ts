/**
 * Contrato de entitlements (o que o plano do tenant libera) — mesmo formato na API e no front
 * (`useEntitlements()`). A fonte da verdade são as tabelas plans/tenant_subscriptions/usage_counters.
 */
export const PLAN_FEATURES = [
  "clientPortal",
  "eSignature",
  "publicApi",
  "aiAssistant",
  "customDomain",
  "advancedReports",
  "outgoingWebhooks",
  "sso",
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Limiares dos avisos de uso da cota (banner + e-mail para admins, uma vez por ciclo). */
export const USAGE_WARNING_THRESHOLDS = [80, 90, 100] as const;
export type UsageWarning = (typeof USAGE_WARNING_THRESHOLDS)[number];

/** Dias de carência após falha de pagamento antes de o workspace ficar somente leitura. */
export const PAYMENT_GRACE_DAYS = 7;

export const BILLING_ERROR_CODES = {
  taskLimit: "PLAN_TASK_LIMIT_REACHED",
  userLimit: "PLAN_USER_LIMIT_REACHED",
  feature: "FEATURE_NOT_IN_PLAN",
  readOnly: "TENANT_READ_ONLY",
  notConfigured: "BILLING_NOT_CONFIGURED",
} as const;

export type Entitlements = {
  plan: {
    id: string;
    slug: string;
    name: string;
    priceMonthlyCents: number;
    priceIsStartingAt: boolean;
    currency: string;
  };
  pendingPlan: { slug: string; name: string } | null;
  status: SubscriptionStatus;
  provider: "stripe" | "asaas" | "manual" | null;
  /** Assinatura paga no provedor (há portal de pagamento). */
  hasPaidSubscription: boolean;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: string | null;
  readOnly: boolean;
  limits: {
    tasksPerCycle: number | null;
    maxUsers: number | null;
    maxClientPortalUsers: number | null;
    storageGb: number;
    aiMessagesPerCycle: number | null;
  };
  features: Record<PlanFeature, boolean>;
  usage: {
    tasksCreated: number;
    /** 0–100 (null quando ilimitado). */
    tasksPercent: number | null;
  };
};
