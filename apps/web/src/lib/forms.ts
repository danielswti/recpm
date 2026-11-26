import type { TFunction } from "i18next";
import type { FieldError } from "react-hook-form";

/** Mensagens dos schemas (shared e locais) → chaves de tradução. */
const MAP: Record<string, string> = {
  slug_invalido: "validation.slug",
  slug_reservado: "validation.slugReserved",
  senha_curta: "validation.passwordMin",
};

export function fieldError(t: TFunction, e: FieldError | undefined): string | undefined {
  if (!e?.message) return undefined;
  const key = MAP[e.message] ?? e.message;
  return key.startsWith("validation.") ? t(key, { min: 10 }) : t("validation.required");
}

/** Props de acessibilidade para um input com erro. */
export const invalid = (id: string, e: FieldError | undefined) =>
  e ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
