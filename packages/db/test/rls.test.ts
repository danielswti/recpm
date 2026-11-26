/**
 * Isolamento entre tenants contra um Postgres real (banco descartável criado no globalSetup,
 * migrado com schema + RLS como em produção). A aplicação conecta como recpm_app.
 *
 *   TEST_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @recpm/db test
 */
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll as after, beforeAll as before, describe, inject, test } from "vitest";
import * as s from "../src/schema";
import { withTenant } from "../src/tenant-context";

const urls = inject("db");
const ownerPool = new Pool({ connectionString: urls.owner });
const appPool = new Pool({ connectionString: urls.app, max: 25 });
const owner = drizzle({ client: ownerPool, schema: s, casing: "snake_case" });
const app = drizzle({ client: appPool, schema: s, casing: "snake_case" });

const id = () => uuidv7();
const T = { A: id(), B: id() };
const U = { adminA: id(), memberA: id(), clientUserA: id(), adminB: id() };
const C = { a1: id(), a2: id(), b1: id() };
const P = { a1: id(), a2: id(), b1: id() };
const K = { aVisible: id(), aHidden: id(), a2: id(), b1: id() };
const conv = id();

const pgCode = (e: unknown): string | undefined => {
  let cur: any = e;
  while (cur) {
    if (cur.code) return cur.code;
    cur = cur.cause;
  }
  return undefined;
};

before(async () => {
  // Seed como dono (ignora RLS), exatamente como o seed de dev fará.
  await owner
    .insert(s.users)
    .values(Object.entries(U).map(([k, v]) => ({ id: v, name: k, email: `${k}@example.test` })));
  await owner.insert(s.tenants).values([
    { id: T.A, name: "Agência A", slug: `a-${T.A.slice(-6)}` },
    { id: T.B, name: "Agência B", slug: `b-${T.B.slice(-6)}` },
  ]);
  await owner.insert(s.clients).values([
    { id: C.a1, tenantId: T.A, code: "A1", name: "Cliente A1" },
    { id: C.a2, tenantId: T.A, code: "A2", name: "Cliente A2" },
    { id: C.b1, tenantId: T.B, code: "B1", name: "Cliente B1" },
  ]);
  await owner.insert(s.memberships).values([
    { tenantId: T.A, userId: U.adminA, role: "admin", hourlyCostCents: 15000 },
    { tenantId: T.A, userId: U.memberA, role: "funcionario" },
    { tenantId: T.A, userId: U.clientUserA, role: "cliente", clientId: C.a1 },
    { tenantId: T.B, userId: U.adminB, role: "admin" },
  ]);
  await owner.insert(s.kanbanColumns).values([
    { tenantId: T.A, key: "a_fazer", label: "A fazer" },
    { tenantId: T.B, key: "a_fazer", label: "A fazer" },
  ]);
  await owner.insert(s.projects).values([
    { id: P.a1, tenantId: T.A, name: "Projeto A1", clientId: C.a1, modality: "avulso" },
    { id: P.a2, tenantId: T.A, name: "Projeto A2", clientId: C.a2, modality: "avulso" },
    { id: P.b1, tenantId: T.B, name: "Projeto B1", clientId: C.b1, modality: "avulso" },
  ]);
  const task = (tid: string, tenantId: string, projectId: string, visibleToClient: boolean) => ({
    id: tid,
    tenantId,
    projectId,
    title: tid,
    statusKey: "a_fazer",
    rank: "a0",
    visibleToClient,
  });
  await owner
    .insert(s.tasks)
    .values([
      task(K.aVisible, T.A, P.a1, true),
      task(K.aHidden, T.A, P.a1, false),
      task(K.a2, T.A, P.a2, true),
      task(K.b1, T.B, P.b1, true),
    ]);
  await owner.insert(s.personalNotes).values({ tenantId: T.A, userId: U.adminA, content: { type: "doc" } });
  await owner
    .insert(s.conversations)
    .values({ id: conv, tenantId: T.A, type: "grupo", name: "Diretoria", createdBy: U.adminA });
  await owner
    .insert(s.conversationParticipants)
    .values({ tenantId: T.A, conversationId: conv, userId: U.adminA });
  await owner
    .insert(s.messages)
    .values({ tenantId: T.A, conversationId: conv, authorId: U.adminA, body: "segredo" });
  await owner.insert(s.plans).values({
    id: id(),
    name: "Teste",
    slug: `teste-${T.A.slice(-6)}`,
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    limits: {
      tasksPerCycle: 5,
      maxUsers: null,
      maxClientPortalUsers: null,
      storageGb: 1,
      aiMessagesPerCycle: null,
    },
    features: {
      clientPortal: true,
      eSignature: true,
      publicApi: true,
      aiAssistant: true,
      customDomain: false,
      advancedReports: false,
      outgoingWebhooks: false,
      sso: false,
    },
  });
  await owner.insert(s.usageCounters).values({
    tenantId: T.A,
    periodStart: new Date("2026-11-01"),
    periodEnd: new Date("2026-12-01"),
  });
});

after(async () => {
  await owner.delete(s.tenants).where(sql`${s.tenants.id} IN (${T.A}, ${T.B})`);
  await owner.delete(s.users).where(
    sql`${s.users.id} IN (${sql.join(
      Object.values(U).map((u) => sql`${u}`),
      sql`, `,
    )})`,
  );
  await ownerPool.end();
  await appPool.end();
});

describe("isolamento entre tenants", () => {
  test("sem contexto de tenant, nenhuma linha aparece (falha fechada)", async () => {
    const rows = await app.select().from(s.tasks);
    assert.equal(rows.length, 0);
    const clients = await app.select().from(s.clients);
    assert.equal(clients.length, 0);
  });

  test("tenant A só enxerga as próprias tarefas", async () => {
    const rows = await withTenant(app, { tenantId: T.A, userId: U.adminA }, (tx) =>
      tx.select().from(s.tasks),
    );
    assert.deepEqual(rows.map((r) => r.id).sort(), [K.aVisible, K.aHidden, K.a2].sort());
  });

  test("não é possível gravar com tenant_id de outro tenant", async () => {
    await assert.rejects(
      withTenant(app, { tenantId: T.A, userId: U.adminA }, (tx) =>
        tx.insert(s.clients).values({ tenantId: T.B, code: "X", name: "Invasor" }),
      ),
      (e) => pgCode(e) === "42501",
    );
  });

  test("FK composta impede apontar para projeto de outro tenant", async () => {
    await assert.rejects(
      withTenant(app, { tenantId: T.A, userId: U.adminA }, (tx) =>
        tx
          .insert(s.tasks)
          .values({ tenantId: T.A, projectId: P.b1, title: "x", statusKey: "a_fazer", rank: "a1" }),
      ),
      (e) => pgCode(e) === "23503",
    );
  });

  test("UPDATE/DELETE em linha de outro tenant não afeta nada", async () => {
    const res = await withTenant(app, { tenantId: T.A, userId: U.adminA }, async (tx) => {
      const u = await tx.update(s.tasks).set({ title: "hackeado" }).where(eq(s.tasks.id, K.b1)).returning();
      const d = await tx.delete(s.tasks).where(eq(s.tasks.id, K.b1)).returning();
      return u.length + d.length;
    });
    assert.equal(res, 0);
    const [b1] = await owner.select().from(s.tasks).where(eq(s.tasks.id, K.b1));
    assert.equal(b1?.title, K.b1);
  });

  test("users: só eu e os membros do tenant atual", async () => {
    const rows = await withTenant(app, { tenantId: T.A, userId: U.adminA }, (tx) =>
      tx.select({ id: s.users.id }).from(s.users),
    );
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(U.memberA) && ids.includes(U.clientUserA));
    assert.ok(!ids.includes(U.adminB));
  });

  test("todas as tabelas com tenant_id têm RLS (assert_rls_coverage)", async () => {
    await owner.execute(sql`SELECT app.assert_rls_coverage()`);
  });
});

describe("portal do cliente", () => {
  const portal = { tenantId: T.A, userId: U.clientUserA, clientId: C.a1 };

  test("vê só tarefas visíveis dos projetos do próprio cliente", async () => {
    const rows = await withTenant(app, portal, (tx) => tx.select({ id: s.tasks.id }).from(s.tasks));
    assert.deepEqual(
      rows.map((r) => r.id),
      [K.aVisible],
    );
  });

  test("vê só o próprio cliente e os projetos dele", async () => {
    const [clients, projects] = await withTenant(app, portal, (tx) =>
      Promise.all([tx.select().from(s.clients), tx.select().from(s.projects)]),
    );
    assert.deepEqual(
      clients.map((c) => c.id),
      [C.a1],
    );
    assert.deepEqual(
      projects.map((p) => p.id),
      [P.a1],
    );
  });

  test("não vê custo/hora nem dados de outros membros", async () => {
    const rows = await withTenant(app, portal, (tx) => tx.select().from(s.memberships));
    assert.deepEqual(
      rows.map((r) => r.userId),
      [U.clientUserA],
    );
  });

  test("não acessa tabelas internas (financeiro, auditoria, tempo)", async () => {
    const counts = await withTenant(app, portal, async (tx) => [
      (await tx.select().from(s.installments)).length,
      (await tx.select().from(s.auditLogs)).length,
      (await tx.select().from(s.timeEntries)).length,
      (await tx.select().from(s.kanbanColumns)).length, // catálogo: leitura liberada
    ]);
    assert.deepEqual(counts, [0, 0, 0, 1]);
  });

  test("cria e apaga tarefas só nos próprios projetos, sempre visíveis", async () => {
    const created = await withTenant(app, portal, (tx) =>
      tx
        .insert(s.tasks)
        .values({
          tenantId: T.A,
          projectId: P.a1,
          title: "pedido do cliente",
          statusKey: "a_fazer",
          rank: "c0",
          visibleToClient: true,
          source: "portal",
        })
        .returning(),
    );
    assert.equal(created.length, 1);
    const deleted = await withTenant(app, portal, (tx) =>
      tx.delete(s.tasks).where(eq(s.tasks.id, created[0]!.id)).returning(),
    );
    assert.equal(deleted.length, 1);
    // projeto de outro cliente → recusado
    await assert.rejects(
      withTenant(app, portal, (tx) =>
        tx
          .insert(s.tasks)
          .values({
            tenantId: T.A,
            projectId: P.a2,
            title: "x",
            statusKey: "a_fazer",
            rank: "c1",
            visibleToClient: true,
          }),
      ),
      (e) => pgCode(e) === "42501",
    );
    // tarefa oculta → recusado
    await assert.rejects(
      withTenant(app, portal, (tx) =>
        tx
          .insert(s.tasks)
          .values({
            tenantId: T.A,
            projectId: P.a1,
            title: "x",
            statusKey: "a_fazer",
            rank: "c2",
            visibleToClient: false,
          }),
      ),
      (e) => pgCode(e) === "42501",
    );
    // não apaga tarefa oculta nem de outro cliente
    const none = await withTenant(app, portal, (tx) =>
      tx.delete(s.tasks).where(sql`${s.tasks.id} IN (${K.aHidden}, ${K.a2})`).returning(),
    );
    assert.equal(none.length, 0);
  });

  test("abre demanda só para o próprio cliente", async () => {
    await withTenant(app, portal, (tx) =>
      tx
        .insert(s.demandRequests)
        .values({ tenantId: T.A, clientId: C.a1, title: "Nova arte", requestedBy: U.clientUserA }),
    );
    await assert.rejects(
      withTenant(app, portal, (tx) =>
        tx.insert(s.demandRequests).values({ tenantId: T.A, clientId: C.a2, title: "Para outro cliente" }),
      ),
      (e) => pgCode(e) === "42501",
    );
  });
});

describe("dados pessoais e chat", () => {
  test("nota pessoal só para o dono", async () => {
    const mine = await withTenant(app, { tenantId: T.A, userId: U.adminA }, (tx) =>
      tx.select().from(s.personalNotes),
    );
    const other = await withTenant(app, { tenantId: T.A, userId: U.memberA }, (tx) =>
      tx.select().from(s.personalNotes),
    );
    assert.equal(mine.length, 1);
    assert.equal(other.length, 0);
  });

  test("notificação: qualquer um cria para outro, só o dono lê", async () => {
    await withTenant(app, { tenantId: T.A, userId: U.memberA }, (tx) =>
      tx
        .insert(s.notifications)
        .values({ tenantId: T.A, userId: U.adminA, type: "tarefa_aprovacao_pendente", title: "Aprovar" }),
    );
    const byMember = await withTenant(app, { tenantId: T.A, userId: U.memberA }, (tx) =>
      tx.select().from(s.notifications),
    );
    const byOwner = await withTenant(app, { tenantId: T.A, userId: U.adminA }, (tx) =>
      tx.select().from(s.notifications),
    );
    assert.equal(byMember.length, 0);
    assert.equal(byOwner.length, 1);
  });

  test("conversa invisível para quem não participa; job 'system' enxerga", async () => {
    const outsider = await withTenant(app, { tenantId: T.A, userId: U.memberA }, (tx) =>
      tx.select().from(s.messages),
    );
    const insider = await withTenant(app, { tenantId: T.A, userId: U.adminA }, (tx) =>
      tx.select().from(s.messages),
    );
    const system = await withTenant(app, { tenantId: T.A, actor: "system" }, (tx) =>
      tx.select().from(s.messages),
    );
    assert.equal(outsider.length, 0);
    assert.equal(insider.length, 1);
    assert.equal(system.length, 1);
  });

  test("criador de conversa nova consegue inserir e ler de volta (RETURNING)", async () => {
    const rows = await withTenant(app, { tenantId: T.A, userId: U.memberA }, (tx) =>
      tx.insert(s.conversations).values({ tenantId: T.A, type: "ia", createdBy: U.memberA }).returning(),
    );
    assert.equal(rows.length, 1);
  });
});

describe("regras garantidas pelo banco", () => {
  test("uma única tarefa em andamento por pessoa (timer)", async () => {
    await assert.rejects(
      withTenant(app, { tenantId: T.A, userId: U.memberA }, async (tx) => {
        const base = { tenantId: T.A, userId: U.memberA, startedAt: new Date(), statusAtStart: "a_fazer" };
        await tx.insert(s.timeEntries).values({ ...base, taskId: K.aVisible });
        await tx.insert(s.timeEntries).values({ ...base, taskId: K.aHidden });
      }),
      (e) => pgCode(e) === "23505",
    );
  });

  test("cota de tarefas: 20 criações concorrentes com limite 5 → exatamente 5 passam", async () => {
    const LIMIT = 5;
    const attempt = (n: number) =>
      withTenant(app, { tenantId: T.A, userId: U.adminA }, async (tx) => {
        const ok = await tx
          .update(s.usageCounters)
          .set({ tasksCreated: sql`${s.usageCounters.tasksCreated} + 1` })
          .where(and(eq(s.usageCounters.tenantId, T.A), sql`${s.usageCounters.tasksCreated} < ${LIMIT}`))
          .returning({ n: s.usageCounters.tasksCreated });
        if (ok.length === 0) return false; // → 402 PLAN_TASK_LIMIT_REACHED
        await tx
          .insert(s.tasks)
          .values({ tenantId: T.A, title: `quota ${n}`, statusKey: "a_fazer", rank: `q${n}` });
        return true;
      });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(i)));
    assert.equal(results.filter(Boolean).length, LIMIT);
    const [counter] = await owner.select().from(s.usageCounters).where(eq(s.usageCounters.tenantId, T.A));
    assert.equal(counter?.tasksCreated, LIMIT);
  });

  test("funções de entrada sem sessão resolvem o tenant (chave de API)", async () => {
    await owner
      .insert(s.apiKeys)
      .values({
        tenantId: T.B,
        name: "zap",
        prefix: `pfx${T.B.slice(-6)}`,
        hashedKey: "h",
        createdBy: U.adminB,
      });
    const r = await app.execute(sql`SELECT tenant_id FROM app.resolve_api_key(${`pfx${T.B.slice(-6)}`})`);
    assert.equal(r.rows[0]?.tenant_id, T.B);
  });
});
