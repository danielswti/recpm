import type { createDbs } from "@recpm/db";
import type { Redis } from "ioredis";
import type { BillingProviders } from "./billing";
import type { Env } from "./env";
import type { Scanner } from "./lib/antivirus";
import type { LiveHub } from "./lib/live";
import type { Logger } from "./lib/logger";
import type { Mailer } from "./lib/mailer";
import type { PushSender } from "./lib/push";
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
  /** Antivírus dos uploads; sem isso, usa o ClamAV de CLAMAV_HOST (ou nenhum). */
  scanner?: Scanner;
  /** Avisos em tempo real (LISTEN/NOTIFY); sem isso, abre sob demanda com DATABASE_URL_APP. */
  live?: LiveHub | null;
  /** Envio de web push; sem isso, usa web-push com as chaves VAPID do ambiente. */
  push?: PushSender | null;
  /** fetch usado pela IA e pela BrasilAPI (os testes trocam por um falso). */
  fetch?: typeof fetch;
};
