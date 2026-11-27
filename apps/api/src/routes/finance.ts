/**
 * Financeiro (§6.6): visão geral com KPIs, contratos do projeto com parcelas geradas e
 * recalculadas, pagamentos e estornos, e mensalidades (base do MRR).
 * Leitura: finance.read. Alterações: finance.manage. Só a equipe (o portal não vê valores).
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  audit,
  generateSubscriptionCharges,
  payInstallment,
  regenerateInstallments,
  reverseInstallment,
  splitCents,
  syncContractStatus,
  tenantTimezone,
  todayIn,
} from "@recpm/core";
import { type AppTx, schema } from "@recpm/db";
import {
  CONTRACT_MODALITIES,
  clientSubscriptionInput,
  contractInput,
  contractStatusInput,
  PAYMENT_METHODS,
  paymentInput,
} from "@recpm/shared";
import { and, asc, between, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { actorOf, teamOnly } from "../lib/actor";
import { AppError } from "../lib/errors";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;
const tags = ["Financeiro"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const IdParam = z.object({ id: z.uuid() });
const noContent = { 204: { description: "OK" } };

const Installment = z
  .object({
    id: z.uuid(),
    number: z.number(),
    amountCents: z.number(),
    dueDate: z.string(),
    status: z.enum(["pendente", "pago", "atrasado", "estornado"]),
    paidAt: z.string().nullable(),
    paidAmountCents: z.number().nullable(),
    method: z.enum(PAYMENT_METHODS).nullable(),
    note: z.string().nullable(),
    reversedAt: z.string().nullable(),
  })
  .openapi("Installment");
const Contract = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    modality: z.enum(CONTRACT_MODALITIES),
    totalValueCents: z.number(),
    installmentsCount: z.number(),
    firstDueDate: z.string(),
    status: z.enum(["ativo", "concluido", "cancelado"]),
    notes: z.string().nullable(),
    paidCents: z.number(),
    remainingCents: z.number(),
    overdueCents: z.number(),
    installments: z.array(Installment),
    createdAt: z.string(),
  })
  .openapi("Contract");
const SubscriptionRow = z
  .object({
    id: z.uuid(),
    client: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
    project: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    contractId: z.uuid().nullable(),
    amountCents: z.number(),
    dayOfMonth: z.number(),
    status: z.enum(["ativa", "cancelada"]),
    startedAt: z.string(),
    canceledAt: z.string().nullable(),
    /** O cliente tem alguma parcela atrasada (em qualquer contrato ou mensalidade)? */
    upToDate: z.boolean(),
    nextDueDate: z.string().nullable(),
  })
  .openapi("ClientSubscription");

const instOut = (r: typeof s.installments.$inferSelect) => ({
  id: r.id,
  number: r.number,
  amountCents: Number(r.amountCents),
  dueDate: String(r.dueDate),
  status: r.status,
  paidAt: r.paidAt ? String(r.paidAt) : null,
  paidAmountCents: r.paidAmountCents === null ? null : Number(r.paidAmountCents),
  method: r.method,
  note: r.note,
  reversedAt: r.reversedAt?.toISOString() ?? null,
});

const today = async (tx: AppTx) => todayIn(await tenantTimezone(tx));
const plus30 = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
};

async function contractsOut(tx: AppTx, rows: (typeof s.contracts.$inferSelect)[]) {
  if (!rows.length) return [];
  const inst = await tx
    .select()
    .from(s.installments)
    .where(
      inArray(
        s.installments.contractId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(s.installments.dueDate), asc(s.installments.number));
  return rows.map((c) => {
    const mine = inst.filter((i) => i.contractId === c.id);
    const paid = mine
      .filter((i) => i.status === "pago")
      .reduce((a, i) => a + Number(i.paidAmountCents ?? 0), 0);
    const open = mine.filter((i) => i.status === "pendente" || i.status === "atrasado");
    return {
      id: c.id,
      projectId: c.projectId,
      modality: c.modality,
      totalValueCents: Number(c.totalValueCents),
      installmentsCount: c.installmentsCount,
      firstDueDate: String(c.firstDueDate),
      status: c.status,
      notes: c.notes,
      paidCents: paid,
      remainingCents: open.reduce((a, i) => a + Number(i.amountCents), 0),
      overdueCents: open
        .filter((i) => i.status === "atrasado")
        .reduce((a, i) => a + Number(i.amountCents), 0),
      installments: mine.map(instOut),
      createdAt: c.createdAt.toISOString(),
    };
  });
}

/** Mensalidade ligada a um contrato "mensalidade": valor mensal e dia do vencimento. */
async function syncLinkedSubscription(tx: AppTx, c: typeof s.contracts.$inferSelect) {
  const [link] = await tx
    .select()
    .from(s.clientSubscriptions)
    .where(eq(s.clientSubscriptions.contractId, c.id));
  if (c.modality !== "mensalidade") {
    if (link) await tx.delete(s.clientSubscriptions).where(eq(s.clientSubscriptions.id, link.id));
    return;
  }
  const [p] = await tx
    .select({ clientId: s.projects.clientId })
    .from(s.projects)
    .where(eq(s.projects.id, c.projectId));
  if (!p?.clientId) return;
  const monthly = splitCents(Number(c.totalValueCents), c.installmentsCount)[0] ?? 0;
  const values = {
    amountCents: monthly,
    dayOfMonth: Number(String(c.firstDueDate).slice(8, 10)),
    startedAt: String(c.firstDueDate),
    status: (c.status === "cancelado" ? "cancelada" : "ativa") as "ativa" | "cancelada",
    canceledAt: c.status === "cancelado" ? new Date().toISOString().slice(0, 10) : null,
    // contrato concluído também sai do MRR
    ...(c.status === "concluido" ? { status: "cancelada" as const } : {}),
  };
  if (link)
    await tx
      .update(s.clientSubscriptions)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(s.clientSubscriptions.id, link.id));
  else
    await tx.insert(s.clientSubscriptions).values({
      tenantId: c.tenantId,
      clientId: p.clientId,
      projectId: c.projectId,
      contractId: c.id,
      ...values,
    });
}

async function subscriptionsOut(tx: AppTx, status: "active" | "canceled" | "all", t: string) {
  const rows = await tx
    .select({ sub: s.clientSubscriptions, c: s.clients, pname: s.projects.name })
    .from(s.clientSubscriptions)
    .innerJoin(s.clients, eq(s.clients.id, s.clientSubscriptions.clientId))
    .leftJoin(s.projects, eq(s.projects.id, s.clientSubscriptions.projectId))
    .where(
      status === "all"
        ? undefined
        : eq(s.clientSubscriptions.status, status === "active" ? "ativa" : "cancelada"),
    )
    .orderBy(asc(s.clients.code));
  const late = await tx
    .selectDistinct({ clientId: s.installments.clientId })
    .from(s.installments)
    .where(eq(s.installments.status, "atrasado"));
  const lateSet = new Set(late.map((l) => l.clientId));
  const next = await tx
    .select({
      subId: s.installments.clientSubscriptionId,
      contractId: s.installments.contractId,
      due: sql<string>`min(${s.installments.dueDate})::text`,
    })
    .from(s.installments)
    .where(
      and(inArray(s.installments.status, ["pendente", "atrasado"]), sql`${s.installments.dueDate} >= ${t}`),
    )
    .groupBy(s.installments.clientSubscriptionId, s.installments.contractId);
  return rows.map(({ sub, c, pname }) => ({
    id: sub.id,
    client: { id: c.id, code: c.code, name: c.name },
    project: sub.projectId && pname ? { id: sub.projectId, name: pname } : null,
    contractId: sub.contractId,
    amountCents: Number(sub.amountCents),
    dayOfMonth: sub.dayOfMonth,
    status: sub.status,
    startedAt: String(sub.startedAt),
    canceledAt: sub.canceledAt ? String(sub.canceledAt) : null,
    upToDate: !lateSet.has(c.id),
    nextDueDate:
      next.find((n) => (sub.contractId ? n.contractId === sub.contractId : n.subId === sub.id))?.due ?? null,
  }));
}

export const financeRoutes = (deps: Deps) => {
  const r = router();
  const guard = [requireTenant(deps.dbs), teamOnly, requirePermission("finance.read")] as const;
  r.use("/finance/*", ...guard);
  r.use("/contracts/*", ...guard);
  r.use("/installments/*", ...guard);
  r.use("/projects/:id/contracts", ...guard);
  r.on(
    ["POST", "PATCH", "PUT", "DELETE"],
    ["/finance/*", "/contracts/*", "/installments/*", "/projects/:id/contracts"],
    requirePermission("finance.manage"),
  );

  const loadContract = async (tx: AppTx, id: string) => {
    const [c] = await tx.select().from(s.contracts).where(eq(s.contracts.id, id)).for("update");
    if (!c) throw new AppError(404, "CONTRACT_NOT_FOUND", "Contrato não encontrado.");
    return c;
  };
  const oneContract = async (tx: AppTx, id: string) => {
    const [c] = await tx.select().from(s.contracts).where(eq(s.contracts.id, id));
    return (await contractsOut(tx, [c!]))[0]!;
  };

  return r
    .openapi(
      createRoute({
        method: "get",
        path: "/finance/overview",
        tags,
        summary: "KPIs, mensalidades ativas e contratos",
        request: {
          query: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
        },
        responses: {
          200: ok(
            z.object({
              period: z.object({ from: z.string(), to: z.string() }),
              kpis: z.object({
                receivedCents: z.number(),
                paymentsCount: z.number(),
                pendingCents: z.number(),
                overdueCents: z.number(),
                overdueCount: z.number(),
                receivable30Cents: z.number(),
                mrrCents: z.number(),
                activeSubscriptions: z.number(),
              }),
              subscriptions: z.array(SubscriptionRow),
              contracts: z.array(
                Contract.omit({ installments: true }).extend({
                  project: z.object({ id: z.uuid(), name: z.string(), clientCode: z.string().nullable() }),
                }),
              ),
            }),
          ),
        },
      }),
      async (c) => {
        const q = c.req.valid("query");
        const res = await c.var.tenant.tx(async (tx) => {
          const t = await today(tx);
          const from = q.from ?? `${t.slice(0, 8)}01`;
          const to = q.to ?? t;
          const [k] = await tx
            .select({
              received: sql<number>`coalesce(sum(${s.installments.paidAmountCents}) FILTER (WHERE ${s.installments.status} = 'pago' AND ${s.installments.paidAt} BETWEEN ${from} AND ${to}), 0)::bigint`,
              payments: sql<number>`count(*) FILTER (WHERE ${s.installments.status} = 'pago' AND ${s.installments.paidAt} BETWEEN ${from} AND ${to})::int`,
              pending: sql<number>`coalesce(sum(${s.installments.amountCents}) FILTER (WHERE ${s.installments.status} = 'pendente'), 0)::bigint`,
              overdue: sql<number>`coalesce(sum(${s.installments.amountCents}) FILTER (WHERE ${s.installments.status} = 'atrasado'), 0)::bigint`,
              overdueCount: sql<number>`count(*) FILTER (WHERE ${s.installments.status} = 'atrasado')::int`,
              receivable30: sql<number>`coalesce(sum(${s.installments.amountCents}) FILTER (WHERE ${s.installments.status} = 'pendente' AND ${s.installments.dueDate} BETWEEN ${t} AND ${plus30(t)}), 0)::bigint`,
            })
            .from(s.installments);
          const subs = await subscriptionsOut(tx, "active", t);
          const contractRows = await tx
            .select({ c: s.contracts, pname: s.projects.name, code: s.clients.code })
            .from(s.contracts)
            .innerJoin(s.projects, eq(s.projects.id, s.contracts.projectId))
            .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
            .where(isNull(s.projects.deletedAt))
            .orderBy(desc(s.contracts.createdAt))
            .limit(500);
          const out = await contractsOut(
            tx,
            contractRows.map((x) => x.c),
          );
          return {
            period: { from, to },
            kpis: {
              receivedCents: Number(k?.received ?? 0),
              paymentsCount: k?.payments ?? 0,
              pendingCents: Number(k?.pending ?? 0),
              overdueCents: Number(k?.overdue ?? 0),
              overdueCount: k?.overdueCount ?? 0,
              receivable30Cents: Number(k?.receivable30 ?? 0),
              mrrCents: subs.reduce((a, x) => a + x.amountCents, 0),
              activeSubscriptions: subs.length,
            },
            subscriptions: subs,
            contracts: out.map(({ installments: _i, ...x }, i) => ({
              ...x,
              project: {
                id: contractRows[i]!.c.projectId,
                name: contractRows[i]!.pname,
                clientCode: contractRows[i]!.code ?? null,
              },
            })),
          };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{id}/contracts",
        tags,
        summary: "Contratos do projeto com as parcelas",
        request: { params: IdParam },
        responses: { 200: ok(z.object({ data: z.array(Contract) })) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const data = await c.var.tenant.tx(async (tx) =>
          contractsOut(
            tx,
            await tx
              .select()
              .from(s.contracts)
              .where(eq(s.contracts.projectId, id))
              .orderBy(desc(s.contracts.createdAt)),
          ),
        );
        return c.json({ data }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{id}/contracts",
        tags,
        summary: "Criar contrato (gera as parcelas)",
        request: { params: IdParam, ...body(contractInput) },
        responses: { 201: ok(Contract, "Criado") },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const t = c.var.tenant;
        const out = await t.tx(async (tx) => {
          const [p] = await tx
            .select({ id: s.projects.id, name: s.projects.name, clientId: s.projects.clientId })
            .from(s.projects)
            .where(and(eq(s.projects.id, id), isNull(s.projects.deletedAt)));
          if (!p) throw new AppError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
          if (b.modality === "mensalidade" && !p.clientId)
            throw new AppError(
              409,
              "PROJECT_WITHOUT_CLIENT",
              "Mensalidade precisa de um projeto com cliente.",
            );
          const [row] = await tx
            .insert(s.contracts)
            .values({
              tenantId: t.tenantId,
              projectId: id,
              modality: b.modality,
              totalValueCents: b.totalValueCents,
              installmentsCount: b.installmentsCount,
              firstDueDate: b.firstDueDate,
              notes: b.notes ?? null,
              createdBy: t.userId,
            })
            .returning();
          await regenerateInstallments(tx, row!, await today(tx));
          await syncLinkedSubscription(tx, row!);
          await audit(tx, actorOf(c), {
            entity: "contract",
            entityId: row!.id,
            entityLabel: p.name,
            action: "contract.created",
            details: {
              modality: b.modality,
              totalValueCents: b.totalValueCents,
              installments: b.installmentsCount,
            },
          });
          return oneContract(tx, row!.id);
        });
        return c.json(out, 201);
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/contracts/{id}",
        tags,
        summary: "Mudar as condições (recalcula as parcelas em aberto)",
        request: { params: IdParam, ...body(contractInput.partial()) },
        responses: { 200: ok(Contract) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const out = await c.var.tenant.tx(async (tx) => {
          const cur = await loadContract(tx, id);
          const [row] = await tx
            .update(s.contracts)
            .set({ ...b, updatedAt: new Date() })
            .where(eq(s.contracts.id, id))
            .returning();
          const reopened = row!.status === "concluido" ? { ...row!, status: "ativo" as const } : row!;
          await regenerateInstallments(tx, reopened, await today(tx));
          await syncContractStatus(tx, id);
          const [fresh] = await tx.select().from(s.contracts).where(eq(s.contracts.id, id));
          await syncLinkedSubscription(tx, fresh!);
          await audit(tx, actorOf(c), {
            entity: "contract",
            entityId: id,
            action: "contract.updated",
            details: {
              from: {
                totalValueCents: Number(cur.totalValueCents),
                installmentsCount: cur.installmentsCount,
                firstDueDate: cur.firstDueDate,
              },
              to: b,
            },
          });
          return oneContract(tx, id);
        });
        return c.json(out, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/contracts/{id}/status",
        tags,
        summary: "Cancelar ou reativar o contrato",
        request: { params: IdParam, ...body(contractStatusInput) },
        responses: { 200: ok(Contract) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const { status } = c.req.valid("json");
        const out = await c.var.tenant.tx(async (tx) => {
          const cur = await loadContract(tx, id);
          if (cur.status === status) return oneContract(tx, id);
          const [row] = await tx
            .update(s.contracts)
            .set({ status, updatedAt: new Date() })
            .where(eq(s.contracts.id, id))
            .returning();
          await regenerateInstallments(tx, row!, await today(tx));
          await syncContractStatus(tx, id);
          const [fresh] = await tx.select().from(s.contracts).where(eq(s.contracts.id, id));
          await syncLinkedSubscription(tx, fresh!);
          await audit(tx, actorOf(c), {
            entity: "contract",
            entityId: id,
            action: status === "cancelado" ? "contract.canceled" : "contract.reactivated",
          });
          return oneContract(tx, id);
        });
        return c.json(out, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/contracts/{id}",
        tags,
        summary: "Apagar contrato sem pagamentos",
        request: { params: IdParam },
        responses: noContent,
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await c.var.tenant.tx(async (tx) => {
          await loadContract(tx, id);
          const [paid] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(s.installments)
            .where(
              and(eq(s.installments.contractId, id), inArray(s.installments.status, ["pago", "estornado"])),
            );
          if (paid?.n)
            throw new AppError(
              409,
              "CONTRACT_HAS_PAYMENTS",
              "Contrato com pagamentos não pode ser apagado. Cancele-o.",
            );
          await tx.delete(s.clientSubscriptions).where(eq(s.clientSubscriptions.contractId, id));
          await tx.delete(s.contracts).where(eq(s.contracts.id, id));
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/installments/{id}/pay",
        tags,
        summary: "Registrar pagamento",
        request: { params: IdParam, ...body(paymentInput) },
        responses: { 200: ok(Installment) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const out = await c.var.tenant.tx(async (tx) => {
          await payInstallment(tx, actorOf(c), id, b);
          const [row] = await tx.select().from(s.installments).where(eq(s.installments.id, id));
          return instOut(row!);
        });
        return c.json(out, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/installments/{id}/reverse",
        tags,
        summary: "Estornar pagamento (o valor volta a ser devido)",
        request: { params: IdParam },
        responses: { 200: ok(Installment) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const out = await c.var.tenant.tx(async (tx) => {
          await reverseInstallment(tx, actorOf(c), id, await today(tx));
          const [row] = await tx.select().from(s.installments).where(eq(s.installments.id, id));
          return instOut(row!);
        });
        return c.json(out, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/finance/subscriptions",
        tags,
        summary: "Mensalidades: MRR, ativas, canceladas e a receber em 30 dias",
        request: { query: z.object({ status: z.enum(["active", "canceled", "all"]).default("active") }) },
        responses: {
          200: ok(
            z.object({
              kpis: z.object({
                mrrCents: z.number(),
                active: z.number(),
                canceled: z.number(),
                receivable30Cents: z.number(),
              }),
              data: z.array(SubscriptionRow),
            }),
          ),
        },
      }),
      async (c) => {
        const { status } = c.req.valid("query");
        const res = await c.var.tenant.tx(async (tx) => {
          const t = await today(tx);
          const all = await subscriptionsOut(tx, "all", t);
          const active = all.filter((x) => x.status === "ativa");
          const [r30] = await tx
            .select({
              v: sql<number>`coalesce(sum(${s.installments.amountCents}), 0)::bigint`,
            })
            .from(s.installments)
            .innerJoin(
              s.clientSubscriptions,
              sql`${s.clientSubscriptions.id} = ${s.installments.clientSubscriptionId} OR ${s.clientSubscriptions.contractId} = ${s.installments.contractId}`,
            )
            .where(
              and(
                eq(s.clientSubscriptions.status, "ativa"),
                eq(s.installments.status, "pendente"),
                between(s.installments.dueDate, t, plus30(t)),
              ),
            );
          return {
            kpis: {
              mrrCents: active.reduce((a, x) => a + x.amountCents, 0),
              active: active.length,
              canceled: all.length - active.length,
              receivable30Cents: Number(r30?.v ?? 0),
            },
            data:
              status === "all"
                ? all
                : all.filter((x) => x.status === (status === "active" ? "ativa" : "cancelada")),
          };
        });
        return c.json(res, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/finance/subscriptions",
        tags,
        summary: "Nova mensalidade avulsa (as cobranças mensais saem sozinhas)",
        request: body(clientSubscriptionInput),
        responses: { 201: ok(z.object({ id: z.uuid() }), "Criada") },
      }),
      async (c) => {
        const b = c.req.valid("json");
        const t = c.var.tenant;
        const res = await t.tx(async (tx) => {
          const [cl] = await tx
            .select({ id: s.clients.id })
            .from(s.clients)
            .where(eq(s.clients.id, b.clientId));
          if (!cl) throw new AppError(400, "INVALID_REFERENCE", "Cliente não encontrado.");
          const [row] = await tx
            .insert(s.clientSubscriptions)
            .values({
              tenantId: t.tenantId,
              clientId: b.clientId,
              projectId: b.projectId ?? null,
              amountCents: b.amountCents,
              dayOfMonth: b.dayOfMonth,
              startedAt: b.startedAt,
            })
            .returning({ id: s.clientSubscriptions.id });
          await generateSubscriptionCharges(tx, await today(tx));
          await audit(tx, actorOf(c), {
            entity: "client_subscription",
            entityId: row!.id,
            action: "subscription.created",
            details: { amountCents: b.amountCents, dayOfMonth: b.dayOfMonth },
          });
          return row!;
        });
        return c.json(res, 201);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/finance/subscriptions/{id}/status",
        tags,
        summary: "Cancelar ou reativar mensalidade",
        request: { params: IdParam, ...body(z.object({ status: z.enum(["ativa", "cancelada"]) })) },
        responses: noContent,
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const { status } = c.req.valid("json");
        await c.var.tenant.tx(async (tx) => {
          const [sub] = await tx.select().from(s.clientSubscriptions).where(eq(s.clientSubscriptions.id, id));
          if (!sub) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND", "Mensalidade não encontrada.");
          if (sub.contractId)
            throw new AppError(
              409,
              "SUBSCRIPTION_FROM_CONTRACT",
              "Esta mensalidade vem de um contrato. Cancele o contrato.",
            );
          const t = await today(tx);
          await tx
            .update(s.clientSubscriptions)
            .set({ status, canceledAt: status === "cancelada" ? t : null, updatedAt: new Date() })
            .where(eq(s.clientSubscriptions.id, id));
          if (status === "cancelada")
            // cobranças futuras deixam de existir; as vencidas continuam devidas
            await tx
              .delete(s.installments)
              .where(
                and(
                  eq(s.installments.clientSubscriptionId, id),
                  eq(s.installments.status, "pendente"),
                  sql`${s.installments.dueDate} > ${t}`,
                ),
              );
          else {
            await generateSubscriptionCharges(tx, t);
          }
          await audit(tx, actorOf(c), {
            entity: "client_subscription",
            entityId: id,
            action: status === "cancelada" ? "subscription.canceled" : "subscription.reactivated",
          });
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/finance/subscriptions/{id}/installments",
        tags,
        summary: "Cobranças de uma mensalidade",
        request: { params: IdParam },
        responses: { 200: ok(z.object({ data: z.array(Installment) })) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const data = await c.var.tenant.tx(async (tx) => {
          const [sub] = await tx.select().from(s.clientSubscriptions).where(eq(s.clientSubscriptions.id, id));
          if (!sub) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND", "Mensalidade não encontrada.");
          const rows = await tx
            .select()
            .from(s.installments)
            .where(
              sub.contractId
                ? eq(s.installments.contractId, sub.contractId)
                : eq(s.installments.clientSubscriptionId, id),
            )
            .orderBy(desc(s.installments.dueDate));
          return rows.map(instOut);
        });
        return c.json({ data }, 200);
      },
    );
};
