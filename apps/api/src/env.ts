import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  API_URL: z.url().default("http://localhost:3000"),
  WEB_URL: z.url().default("http://localhost:5173"),
  DATABASE_URL_APP: z.string().min(1),
  DATABASE_URL_AUTH: z.string().min(1),
  DATABASE_URL_PLATFORM: z.string().min(1),
  REDIS_URL: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET precisa de 32+ caracteres"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Rec PM <nao-responda@localhost>"),
  SMTP_URL: z.string().optional(),
  // Cobrança (sem chaves = cobrança desligada; o trial e o plano gratuito funcionam normalmente)
  BILLING_PROVIDER: z.enum(["stripe", "asaas"]).default("stripe"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  ASAAS_API_KEY: z.string().optional(),
  ASAAS_BASE_URL: z.url().default("https://api-sandbox.asaas.com/v3"),
  ASAAS_WEBHOOK_TOKEN: z.string().optional(),
  // Arquivos (R2 em produção, MinIO em dev). Sem bucket = upload desligado (links externos seguem).
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Env = z.infer<typeof schema>;

export const parseEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const r = schema.safeParse(source);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Variáveis de ambiente inválidas:\n${issues}`);
  }
  return r.data;
};
