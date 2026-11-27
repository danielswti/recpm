/**
 * Planos do site. Os valores abaixo são só o ponto de partida (iguais ao seed do banco, §4); ao
 * abrir a página buscamos /api/v1/public/plans, que traz o que o super_admin deixou valendo.
 */
export type Plan = {
  slug: string;
  name: string;
  priceMonthlyCents: number;
  priceIsStartingAt: boolean;
  trialDays: number;
  limits: { tasksPerCycle: number | null; maxUsers: number | null; storageGb: number };
  features: Record<string, boolean>;
};

const f = (on: string[]) =>
  Object.fromEntries(
    ["clientPortal", "eSignature", "aiAssistant", "publicApi", "outgoingWebhooks"].map((k) => [
      k,
      on.includes(k),
    ]),
  );

export const FALLBACK_PLANS: Plan[] = [
  {
    slug: "basico",
    name: "Básico",
    priceMonthlyCents: 0,
    priceIsStartingAt: false,
    trialDays: 0,
    limits: { tasksPerCycle: 50, maxUsers: 3, storageGb: 1 },
    features: f([]),
  },
  {
    slug: "essencial",
    name: "Essencial",
    priceMonthlyCents: 9900,
    priceIsStartingAt: false,
    trialDays: 14,
    limits: { tasksPerCycle: 300, maxUsers: 10, storageGb: 20 },
    features: f(["clientPortal"]),
  },
  {
    slug: "profissional",
    name: "Profissional",
    priceMonthlyCents: 24700,
    priceIsStartingAt: false,
    trialDays: 14,
    limits: { tasksPerCycle: 1500, maxUsers: 30, storageGb: 100 },
    features: f(["clientPortal", "eSignature", "aiAssistant", "publicApi"]),
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    priceMonthlyCents: 31900,
    priceIsStartingAt: true,
    trialDays: 14,
    limits: { tasksPerCycle: null, maxUsers: null, storageGb: 2000 },
    features: f(["clientPortal", "eSignature", "aiAssistant", "publicApi", "outgoingWebhooks"]),
  },
];

/** Recursos mostrados no site (só os que o produto já entrega). */
export const FEATURE_LABELS: [string, string][] = [
  ["clientPortal", "Portal do cliente"],
  ["eSignature", "Assinatura eletrônica"],
  ["aiAssistant", "Assistente de IA no chat"],
  ["publicApi", "API pública"],
  ["outgoingWebhooks", "Webhooks de saída"],
];

export const TAGLINES: Record<string, string> = {
  basico: "Para começar a organizar a agência.",
  essencial: "Para equipes pequenas com clientes recorrentes.",
  profissional: "Para agências em crescimento.",
  enterprise: "Para operações grandes, sem limite de tarefas.",
};
