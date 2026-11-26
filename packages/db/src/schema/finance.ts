/**
 * Financeiro da agência com os clientes dela (§5 "Finance", §6.6).
 * Não confundir com a cobrança do SaaS (billing.ts).
 *
 * `installments` atende os dois casos: parcelas de contrato parcelado e cobranças mensais
 * geradas por uma mensalidade. Assim "recebido / pendente / atrasado / a receber em 30 dias"
 * é uma única consulta, e o selo "em dia / atrasado" por cliente também.
 */
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, smallint, text, unique, uuid } from "drizzle-orm/pg-core";
import { cents, pk, tenantUnique, tfk, timestamps, tstz } from "./_columns";
import { users } from "./auth";
import { clients } from "./clients";
import {
  clientSubscriptionStatus,
  contractModality,
  contractStatus,
  installmentStatus,
  paymentMethod,
} from "./enums";
import { projects } from "./projects";
import { tenantId } from "./tenants";

export const contracts = pgTable(
  "contracts",
  {
    id: pk(),
    tenantId: tenantId(),
    projectId: uuid().notNull(),
    modality: contractModality().notNull(),
    totalValueCents: cents().notNull(),
    installmentsCount: integer().notNull(),
    firstDueDate: date().notNull(),
    status: contractStatus().notNull().default("ativo"),
    notes: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    tenantUnique("contracts_tenant_id_uq", t),
    tfk("contracts_project_fk", t, t.projectId, projects),
    index("contracts_project_idx").on(t.tenantId, t.projectId),
    check("contracts_values", sql`${t.totalValueCents} >= 0 AND ${t.installmentsCount} > 0`),
  ],
);

/** Mensalidade (recorrência mensal de um cliente/projeto). Base do MRR. */
export const clientSubscriptions = pgTable(
  "client_subscriptions",
  {
    id: pk(),
    tenantId: tenantId(),
    clientId: uuid().notNull(),
    projectId: uuid(),
    contractId: uuid(),
    amountCents: cents().notNull(),
    dayOfMonth: smallint().notNull(),
    status: clientSubscriptionStatus().notNull().default("ativa"),
    startedAt: date().notNull(),
    canceledAt: date(),
    ...timestamps,
  },
  (t) => [
    tenantUnique("client_subscriptions_tenant_id_uq", t),
    tfk("client_subscriptions_client_fk", t, t.clientId, clients),
    tfk("client_subscriptions_project_fk", t, t.projectId, projects),
    tfk("client_subscriptions_contract_fk", t, t.contractId, contracts),
    index("client_subscriptions_status_idx").on(t.tenantId, t.status),
    check("client_subscriptions_day", sql`${t.dayOfMonth} BETWEEN 1 AND 31`),
  ],
);

export const installments = pgTable(
  "installments",
  {
    id: pk(),
    tenantId: tenantId(),
    contractId: uuid(),
    clientSubscriptionId: uuid(),
    /** Desnormalizado para o selo "em dia/atrasado" e filtros sem JOIN. */
    clientId: uuid(),
    number: integer().notNull(),
    amountCents: cents().notNull(),
    dueDate: date().notNull(),
    /** `atrasado` é marcado pelo job diário; `pago`/`estornado` pelo usuário. */
    status: installmentStatus().notNull().default("pendente"),
    paidAt: date(),
    paidAmountCents: cents(),
    method: paymentMethod(),
    note: text(),
    reversedAt: tstz(),
    reversedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    tfk("installments_contract_fk", t, t.contractId, contracts).onDelete("cascade"),
    tfk("installments_subscription_fk", t, t.clientSubscriptionId, clientSubscriptions),
    tfk("installments_client_fk", t, t.clientId, clients),
    unique("installments_contract_number_uq").on(t.contractId, t.number),
    unique("installments_subscription_number_uq").on(t.clientSubscriptionId, t.number),
    index("installments_due_idx").on(t.tenantId, t.status, t.dueDate),
    index("installments_client_idx").on(t.tenantId, t.clientId, t.status),
    index("installments_paid_idx").on(t.tenantId, t.paidAt),
    check("installments_one_parent", sql`num_nonnulls(${t.contractId}, ${t.clientSubscriptionId}) = 1`),
    check(
      "installments_paid_fields",
      sql`${t.status} <> 'pago' OR (${t.paidAt} IS NOT NULL AND ${t.paidAmountCents} IS NOT NULL)`,
    ),
  ],
);
