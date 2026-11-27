import type { createDbs } from "@recpm/db";
import type { Redis } from "ioredis";
import type { BillingProviders } from "./billing";
import type { Env } from "./env";
import type { Logger } from "./lib/logger";
import type { Mailer } from "./lib/mailer";

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
};
