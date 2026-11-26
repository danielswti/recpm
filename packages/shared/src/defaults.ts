export const DEFAULT_LOCALE = "pt-BR" as const;
export const SUPPORTED_LOCALES = ["pt-BR", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_CURRENCY = "BRL";
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";
export const TRIAL_DAYS = 14;
