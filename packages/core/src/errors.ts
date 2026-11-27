/** Erro de regra de negócio com status HTTP e código estável (a API repassa; o front traduz pelo código). */
export class DomainError extends Error {
  constructor(
    readonly status: 400 | 402 | 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}
