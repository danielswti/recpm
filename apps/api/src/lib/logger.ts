import pino from "pino";

export const createLogger = (level: string) =>
  pino({
    level,
    base: { service: "api" },
    redact: {
      paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.token"],
      remove: true,
    },
  });
export type Logger = ReturnType<typeof createLogger>;
