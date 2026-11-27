/**
 * Sentry (opcional): só liga com SENTRY_DSN. Sem PII (nada de e-mail, IP ou corpo da requisição);
 * cada erro leva o requestId, que também está no log, para cruzar os dois.
 */
import * as Sentry from "@sentry/node";

export function initSentry(dsn: string | undefined, service: string) {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.NODE_ENV ?? "development",
    serverName: service,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.contextLinesIntegration(),
    ],
  });
  return true;
}

/** Não faz nada se o Sentry estiver desligado. */
export function captureError(err: unknown, tags: Record<string, string | undefined> = {}) {
  Sentry.captureException(err, { tags });
}

export const flushSentry = (ms = 2000) => Sentry.flush(ms);
