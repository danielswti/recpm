import type { TFunction } from "i18next";
import { ApiError } from "./api";
import { AuthError } from "./auth-client";

/** Mensagem traduzida para um erro da API ou do Better Auth (pelo código; senão, genérica). */
export function errorMessage(t: TFunction, e: unknown): string {
  const code = e instanceof ApiError || e instanceof AuthError ? e.code : undefined;
  if (code) {
    const key = `errors.${code}`;
    const msg = t(key);
    if (msg !== key) return msg;
    if (e instanceof AuthError && e.status === 429) return t("errors.RATE_LIMITED");
  }
  return t("errors.generic");
}
