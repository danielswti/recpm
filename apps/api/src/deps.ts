import type { createDbs } from "@recpm/db";
import type { Redis } from "ioredis";
import type { BillingProviders } from "./billing";
import type { Env } from "./env";
import type { LiveHub } from "./lib/live";
import type { Logger } from "./lib/logger";
import type { Mailer } from "./lib/mailer";
import type { Storage } from "./lib/storage";

export type Dbs = ReturnType<typeof createDbs>;

/** Tudo que a API precisa do mundo externo — injetado, para os testes trocarem peças. */
export type Deps = {
  env: Env;
  dbs: Dbs;
  redis?: Redis;
  mailer: Mailer;
  logger: Logger;
  /** Provedores de cobrança; sem isso, monta a partir do ambiente (testes injetam um falso). */
  billing?: BillingProviders;
  /** Armazenamento de arquivos; sem isso, monta a partir do ambiente (S3/R2/MinIO). */
  storage?: Storage | null;
  /** Avisos em tempo real (LISTEN/NOTIFY); sem isso, abre sob demanda com DATABASE_URL_APP. */
  live?: LiveHub | null;
};
