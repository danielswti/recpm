/**
 * Financeiro da agência (§6.6): parcelas de contrato, mensalidades, pagamentos, estornos e
 * a rotina diária de atraso. Valores sempre em centavos; datas de vencimento são datas puras
 * ("AAAA-MM-DD") no fuso do workspace.
 */
import { type AppDb, type AppTx, schema as s, withTenant } from "@recpm/db";
import { and, eq, inArray, lt, max, sql } from "drizzle-orm";
import { DomainError } from "../errors";
import { type Actor, audit, notify, tenantTimezone } from "../tasks/service";

type PlatformDb = AppDb;

/** "AAAA-MM-DD" + n meses, mantendo o dia (31/01 + 1 = 28 ou 29/02). */
export function addMonthsYmd(ymd: string, months: number, day?: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day ?? d, last));
  return target.toISOString().slice(0, 10);
}

/** Hoje no fuso do workspace. */
export const todayIn = (tz: string, now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

/** Divide o total em N parcelas; os centavos que sobram vão nas primeiras. */
export function splitCents(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const rest = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0));
}

type Contract = typeof s.contracts.$inferSelect;

/**
 * (Re)gera as parcelas em aberto de um contrato. As pagas ficam como estão; as estornadas
 * ficam no histórico. O que falta receber (total − pago) é dividido pelas parcelas que faltam,
 * com vencimentos mensais a partir da primeira data, na posição de cada parcela.
 */
export async function regenerateInstallments(tx: AppTx, contract: Contract, today: string) {
  const rows = await tx.select().from(s.installments).where(eq(s.installments.contractId, contract.id));
  const paid = rows.filter((r) => r.status === "pago");
  const open = rows.filter((r) => r.status === "pendente" || r.status === "atrasado");
  if (open.length)
    await tx.delete(s.installments).where(
      inArray(
        s.installments.id,
        open.map((r) => r.id),
      ),
    );
  if (contract.status !== "ativo") return;

  const paidCents = paid.reduce((a, r) => a + Number(r.paidAmountCents ?? r.amountCents), 0);
  const remaining = Math.max(0, Number(contract.totalValueCents) - paidCents);
  const left = Math.max(contract.installmentsCount - paid.length, remaining > 0 ? 1 : 0);
  if (!left || !remaining) return;
  const [{ n } = { n: 0 }] = await tx
    .select({ n: max(s.installments.number) })
    .from(s.installments)
    .where(eq(s.installments.contractId, contract.id));
  const firstDay = Number(contract.firstDueDate.slice(8, 10));
  const [proj] = await tx
    .select({ clientId: s.projects.clientId })
    .from(s.projects)
    .where(eq(s.projects.id, contract.projectId));
  const amounts = splitCents(remaining, left);
  await tx.insert(s.installments).values(
    amounts.map((amountCents, i) => {
      const dueDate = addMonthsYmd(contract.firstDueDate, paid.length + i, firstDay);
      return {
        tenantId: contract.tenantId,
        contractId: contract.id,
        clientId: proj?.clientId ?? null,
        number: (n ?? 0) + i + 1,
        amountCents,
        dueDate,
        status: (dueDate < today ? "atrasado" : "pendente") as "atrasado" | "pendente",
      };
    }),
  );
}

/** Fecha o contrato quando não há mais nada em aberto (e reabre se voltar a ter). */
export async function syncContractStatus(tx: AppTx, contractId: string) {
  const [c] = await tx.select().from(s.contracts).where(eq(s.contracts.id, contractId));
  if (!c || c.status === "cancelado") return;
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(s.installments)
    .where(
      and(
        eq(s.installments.contractId, contractId),
        inArray(s.installments.status, ["pendente", "atrasado"]),
      ),
    );
  const next = open?.n ? "ativo" : "concluido";
  if (next !== c.status)
    await tx
      .update(s.contracts)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(s.contracts.id, contractId));
}

export type PaymentInput = { paidAt: string; paidAmountCents: number; method: string; note?: string | null };

export async function payInstallment(tx: AppTx, actor: Actor, id: string, p: PaymentInput) {
  const [row] = await tx.select().from(s.installments).where(eq(s.installments.id, id)).for("update");
  if (!row) throw new DomainError(404, "INSTALLMENT_NOT_FOUND", "Parcela não encontrada.");
  if (row.status === "pago") throw new DomainError(409, "ALREADY_PAID", "Esta parcela já está paga.");
  if (row.status === "estornado") throw new DomainError(409, "INSTALLMENT_REVERSED", "Parcela estornada.");
  await tx
    .update(s.installments)
    .set({
      status: "pago",
      paidAt: p.paidAt,
      paidAmountCents: p.paidAmountCents,
      method: p.method as never,
      note: p.note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(s.installments.id, id));
  if (row.contractId) await syncContractStatus(tx, row.contractId);
  await audit(tx, actor, {
    entity: "installment",
    entityId: id,
    entityLabel: `Parcela ${row.number}`,
    action: "installment.paid",
    details: { amountCents: p.paidAmountCents, method: p.method, paidAt: p.paidAt },
  });
}

/**
 * Estorno: a parcela paga vira "estornada" (fica no histórico) e o valor volta a ser devido:
 * no contrato, as parcelas em aberto são recalculadas; na mensalidade, nasce uma cobrança nova
 * com o mesmo vencimento.
 */
export async function reverseInstallment(tx: AppTx, actor: Actor, id: string, today: string) {
  const [row] = await tx.select().from(s.installments).where(eq(s.installments.id, id)).for("update");
  if (!row) throw new DomainError(404, "INSTALLMENT_NOT_FOUND", "Parcela não encontrada.");
  if (row.status !== "pago") throw new DomainError(409, "NOT_PAID", "Só dá para estornar parcela paga.");
  await tx
    .update(s.installments)
    .set({ status: "estornado", reversedAt: new Date(), reversedBy: actor.userId, updatedAt: new Date() })
    .where(eq(s.installments.id, id));
  if (row.contractId) {
    const [c] = await tx.select().from(s.contracts).where(eq(s.contracts.id, row.contractId));
    if (c) {
      if (c.status === "concluido")
        await tx.update(s.contracts).set({ status: "ativo" }).where(eq(s.contracts.id, c.id));
      await regenerateInstallments(
        tx,
        { ...c, status: c.status === "cancelado" ? "cancelado" : "ativo" },
        today,
      );
    }
  } else if (row.clientSubscriptionId) {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: max(s.installments.number) })
      .from(s.installments)
      .where(eq(s.installments.clientSubscriptionId, row.clientSubscriptionId));
    await tx.insert(s.installments).values({
      tenantId: row.tenantId,
      clientSubscriptionId: row.clientSubscriptionId,
      clientId: row.clientId,
      number: Math.max(10_000, (n ?? 0) + 1),
      amountCents: row.amountCents,
      dueDate: row.dueDate,
      status: row.dueDate < today ? "atrasado" : "pendente",
    });
  }
  await audit(tx, actor, {
    entity: "installment",
    entityId: id,
    entityLabel: `Parcela ${row.number}`,
    action: "installment.reversed",
    details: { amountCents: Number(row.paidAmountCents ?? row.amountCents) },
  });
}

/**
 * Cobranças das mensalidades avulsas (sem contrato): uma por mês, do início até 35 dias à frente
 * (para entrar em "a receber em 30 dias"). Idempotente: o número da parcela é o mês desde o início.
 */
export async function generateSubscriptionCharges(tx: AppTx, today: string) {
  const subs = await tx
    .select()
    .from(s.clientSubscriptions)
    .where(and(eq(s.clientSubscriptions.status, "ativa"), sql`${s.clientSubscriptions.contractId} IS NULL`));
  const until = new Date(`${today}T00:00:00Z`);
  until.setUTCDate(until.getUTCDate() + 35);
  const untilYmd = until.toISOString().slice(0, 10);
  let created = 0;
  for (const sub of subs) {
    const existing = await tx
      .select({ number: s.installments.number })
      .from(s.installments)
      .where(eq(s.installments.clientSubscriptionId, sub.id));
    const have = new Set(existing.map((e) => e.number));
    // primeiro vencimento: o dia escolhido no mês do início (ou no seguinte, se já passou)
    const start = sub.startedAt;
    let first = addMonthsYmd(`${start.slice(0, 8)}01`, 0, sub.dayOfMonth);
    if (first < start) first = addMonthsYmd(`${start.slice(0, 8)}01`, 1, sub.dayOfMonth);
    const rows: (typeof s.installments.$inferInsert)[] = [];
    for (let i = 0; i < 240; i++) {
      const due = addMonthsYmd(`${first.slice(0, 8)}01`, i, sub.dayOfMonth);
      if (due > untilYmd) break;
      if (sub.canceledAt && due > sub.canceledAt) break;
      // estorno cria uma cobrança extra com número alto; o mês i usa o número i+1
      if (have.has(i + 1)) continue;
      rows.push({
        tenantId: sub.tenantId,
        clientSubscriptionId: sub.id,
        clientId: sub.clientId,
        number: i + 1,
        amountCents: sub.amountCents,
        dueDate: due,
        status: due < today ? "atrasado" : "pendente",
      });
    }
    if (rows.length) {
      await tx.insert(s.installments).values(rows).onConflictDoNothing();
      created += rows.length;
    }
  }
  return created;
}

/** Marca como atrasadas as parcelas vencidas e avisa admin e gestores (uma vez por parcela). */
export async function flagOverdueInstallments(tx: AppTx, tenantId: string, today: string) {
  const overdue = await tx
    .update(s.installments)
    .set({ status: "atrasado", updatedAt: new Date() })
    .where(and(eq(s.installments.status, "pendente"), lt(s.installments.dueDate, today)))
    .returning({
      id: s.installments.id,
      amountCents: s.installments.amountCents,
      clientId: s.installments.clientId,
    });
  if (!overdue.length) return 0;
  const managers = await tx
    .select({ id: s.memberships.userId })
    .from(s.memberships)
    .where(and(eq(s.memberships.active, true), inArray(s.memberships.role, ["admin", "gestor"])));
  const total = overdue.reduce((a, r) => a + Number(r.amountCents), 0);
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(total / 100);
  await notify(
    tx,
    tenantId,
    managers.map((m) => m.id),
    {
      type: "parcela_atrasada",
      title:
        overdue.length === 1
          ? "1 parcela venceu sem pagamento"
          : `${overdue.length} parcelas venceram sem pagamento`,
      message: `Total em atraso hoje: ${brl}.`,
      referenceType: "finance",
      referenceId: overdue[0]!.id,
    },
  );
  return overdue.length;
}

/** Rotina diária: gera as cobranças das mensalidades e marca os atrasos, por workspace. */
export async function runFinanceDaily(dbs: { platformDb: PlatformDb; appDb: AppDb }, now = new Date()) {
  const tenants = await dbs.platformDb
    .select({ id: s.tenants.id })
    .from(s.tenants)
    .where(sql`${s.tenants.status} <> 'suspended'`);
  let charges = 0;
  let overdue = 0;
  for (const t of tenants)
    await withTenant(dbs.appDb, { tenantId: t.id, actor: "system" }, async (tx) => {
      const today = todayIn(await tenantTimezone(tx), now);
      charges += await generateSubscriptionCharges(tx, today);
      overdue += await flagOverdueInstallments(tx, t.id, today);
    });
  return { tenants: tenants.length, charges, overdue };
}
