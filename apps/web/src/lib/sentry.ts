/**
 * Sentry no navegador: só carrega (import dinâmico, fora do bundle inicial) se o build tiver
 * VITE_SENTRY_DSN. Sem PII e sem replay; o requestId da API vai junto quando o erro vem dela.
 */
export function startSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn || import.meta.env.DEV) return;
  void import("@sentry/react").then((Sentry) => {
    Sentry.init({
      dsn,
      release: (import.meta.env.VITE_RELEASE as string | undefined) || undefined,
      environment: "production",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      ignoreErrors: ["ResizeObserver loop", "Failed to fetch", "Load failed", "NetworkError"],
    });
  });
}
