import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Erro de negócio com código estável (o front traduz pelo código, não pela mensagem). */
export class AppError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message?: string,
  ) {
    super(status, { message: message ?? code });
  }
}

export const errorBody = (code: string, message: string, extra?: Record<string, unknown>) => ({
  error: { code, message, ...extra },
});

export const isUniqueViolation = (e: unknown, constraint?: string): boolean => {
  let cur: unknown = e;
  while (cur && typeof cur === "object") {
    const c = cur as { code?: string; constraint?: string; cause?: unknown };
    if (c.code === "23505") return !constraint || c.constraint === constraint;
    cur = c.cause;
  }
  return false;
};

/** Violação de chave estrangeira (registro em uso por outro). */
export const isFkViolation = (e: unknown): boolean => {
  let cur: unknown = e;
  while (cur && typeof cur === "object") {
    const c = cur as { code?: string; cause?: unknown };
    if (c.code === "23503") return true;
    cur = c.cause;
  }
  return false;
};
