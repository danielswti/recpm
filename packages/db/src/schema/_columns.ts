/**
 * Colunas e helpers compartilhados por todo o schema.
 *
 * Convenções (valem para todos os arquivos):
 * - Nomes em camelCase no TypeScript; o Drizzle está configurado com `casing: "snake_case"`,
 *   então `tenantId` vira a coluna `tenant_id` sem precisar repetir o nome.
 * - IDs são UUID v7 gerados na aplicação (ordenados no tempo → índices B-tree mais compactos
 *   que UUID v4). O Postgres 17 ainda não tem `uuidv7()` nativo (só no 18).
 * - Dinheiro em centavos (`bigint`, modo number): sem erros de ponto flutuante e sem
 *   strings de `numeric` circulando pelo frontend. Moeda vem do tenant/plano.
 * - Datas "de calendário" (prazo de entrega, vencimento) usam `date` (string `yyyy-MM-dd`);
 *   instantes usam `timestamptz`.
 */
import {
  type AnyPgColumn,
  bigint,
  boolean,
  foreignKey,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

export const pk = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const tstz = () => timestamp({ withTimezone: true, mode: "date" });

export const createdAt = () => tstz().defaultNow().notNull();

export const timestamps = {
  createdAt: createdAt(),
  updatedAt: tstz()
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

/** Soft delete: linhas com `deletedAt` preenchido somem das consultas normais. */
export const softDelete = {
  deletedAt: tstz(),
};

export const cents = () => bigint({ mode: "number" });

/** Colunas comuns a todos os catálogos configuráveis pelo admin (ordenáveis, com cor/ícone). */
export const catalogColumns = {
  color: text(),
  icon: text(),
  position: integer().notNull().default(0),
  active: boolean().notNull().default(true),
};

/**
 * `UNIQUE (tenant_id, id)` em cada tabela-pai, para permitir FKs compostas.
 * É o que garante, no próprio banco, que uma tarefa do tenant A nunca aponte para
 * um projeto do tenant B — mesmo que a aplicação tenha um bug.
 */
export const tenantUnique = (name: string, t: { tenantId: AnyPgColumn; id: AnyPgColumn }) =>
  unique(name).on(t.tenantId, t.id);

/**
 * FK composta `(tenant_id, <col>) → parent(tenant_id, id)`.
 * Com MATCH SIMPLE (padrão), se `<col>` for NULL a FK não é checada — serve para FKs opcionais.
 */
export const tfk = (
  name: string,
  t: { tenantId: AnyPgColumn },
  col: AnyPgColumn,
  parent: { tenantId: AnyPgColumn; id: AnyPgColumn },
) =>
  foreignKey({
    name,
    columns: [t.tenantId, col],
    foreignColumns: [parent.tenantId, parent.id],
  });
