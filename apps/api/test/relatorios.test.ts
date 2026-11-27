/**
 * Fase 8 — relatórios e produtividade: placar (produção e atendimento) com detalhamento,
 * contratado × entregue, entregas, ajustes, financeiro, exportações e a conciliação da §9.
 */
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addMember, Browser, createWorkspace, setupApp, signUp } from "./helpers";

const { app, mailer, urls } = setupApp();
const owner = new Pool({ connectionString: urls.owner });
afterAll(() => owner.end());

const TZ = "America/Sao_Paulo";
const ymd = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
const today = ymd(new Date());
const month = today.slice(0, 7);
const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const MONTH_Q = `from=${month}-01&to=${month}-${String(lastDay).padStart(2, "0")}`;
/** Meio-dia de hoje no fuso (UTC−3): sempre dentro do período de hoje. */
const noon = new Date(`${today}T15:00:00Z`);
const H = 3_600_000;

const admin = new Browser(app);
const stranger = new Browser(app);
let tenantId: string;
let adminId: string;
let gil: { browser: Browser; userId: string };
let fabi: { browser: Browser; userId: string };
let caio: { browser: Browser; userId: string };
let cafe: string;
let pao: string;
let cafeProject: string;
let t1: string;
let t2: string;
const types: Record<string, string> = {};

const task = async (b: Browser, body: Record<string, unknown>) => {
  const r = await b.post("/api/v1/tasks", body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
};
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeAll(async () => {
  adminId = (await signUp(admin, "Ana")).userId;
  tenantId = (await createWorkspace(admin, "Agência Números")).id;
  await signUp(stranger, "Estranho");
  await createWorkspace(stranger, "Outra");
  gil = await addMember(app, admin, mailer, tenantId, "Gil", "gestor");
  fabi = await addMember(app, admin, mailer, tenantId, "Fabi", "funcionario");
  caio = await addMember(app, admin, mailer, tenantId, "Caio", "funcionario");
  const sector = (
    await owner.query(
      "insert into sectors (id, tenant_id, name) values (gen_random_uuid(), $1, 'Design') returning id",
      [tenantId],
    )
  ).rows[0].id;
  await owner.query("update memberships set sector_id = $1 where tenant_id = $2 and user_id = $3", [
    sector,
    tenantId,
    fabi.userId,
  ]);
  for (const t of (await admin.get("/api/v1/catalogs/task-types")).json.data) types[t.slug] = t.id;

  cafe = (await admin.post("/api/v1/clients", { code: "CAFE", name: "Café" })).json.id;
  pao = (await admin.post("/api/v1/clients", { code: "PAO", name: "Padaria" })).json.id;
  const p = await admin.post("/api/v1/projects", {
    name: "Café | Mensal",
    clientId: cafe,
    modality: "mensal",
    periodicity: "mensal",
    startDate: `${month}-01`,
    managerId: gil.userId,
    members: [{ userId: fabi.userId }, { userId: caio.userId }],
    contractItems: [
      { taskTypeId: types.arte_digital, quantityPerPeriod: 10 },
      { taskTypeId: types.edicao, quantityPerPeriod: 4 },
    ],
  });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  cafeProject = p.json.id;
  const paoProject = (
    await admin.post("/api/v1/projects", {
      name: "Padaria | Site",
      clientId: pao,
      modality: "avulso",
      managerId: adminId,
      members: [{ userId: caio.userId }],
    })
  ).json.id;

  // T1: arte, Fabi, no prazo, com data do cliente hoje
  t1 = await task(admin, {
    title: "Posts semana 1",
    projectId: cafeProject,
    assigneeId: fabi.userId,
    taskTypeId: types.arte_digital,
    pieceQuantity: 5,
    deadline: plusDays(1),
    clientDeliveryDate: today,
  });
  await fabi.browser.post(`/api/v1/tasks/${t1}/deliveries`, { quantity: 3 });
  // ajuste interno na T1 (responsável: Fabi)
  const reasonId = (await admin.get("/api/v1/catalogs/adjustment-reasons")).json.data[0].id;
  await fabi.browser.post(`/api/v1/tasks/${t1}/move`, { statusKey: "em_andamento" });
  const adj = await fabi.browser.post(`/api/v1/tasks/${t1}/move`, {
    statusKey: "ajustes",
    adjustment: { reasonId, kind: "internal", description: "Cor errada" },
  });
  expect(adj.status, JSON.stringify(adj.json)).toBe(200);
  expect((await fabi.browser.post(`/api/v1/tasks/${t1}/move`, { statusKey: "concluido" })).status).toBe(200);

  // T2: vídeo da Café, aberto (em andamento), parado há 3 dias, com cobrança do Gil
  t2 = await task(admin, {
    title: "Reels lançamento",
    projectId: cafeProject,
    assigneeId: caio.userId,
    taskTypeId: types.edicao,
    pieceQuantity: 2,
  });
  await gil.browser.post(`/api/v1/tasks/${t2}/move`, { statusKey: "aguardando_cliente" });
  expect((await gil.browser.post(`/api/v1/tasks/${t2}/chase`)).status).toBe(204);
  await owner.query("update tasks set status_since = now() - interval '3 days' where id = $1", [t2]);

  // T3: tarefa interna (sem projeto) com 1 peça da Fabi
  const t3 = await task(admin, {
    title: "Banner interno",
    assigneeId: fabi.userId,
    taskTypeId: types.arte_digital,
  });
  await fabi.browser.post(`/api/v1/tasks/${t3}/deliveries`, { quantity: 1 });

  // T4: Padaria, Caio, atrasada
  const t4 = await task(admin, {
    title: "Home do site",
    projectId: paoProject,
    assigneeId: caio.userId,
    taskTypeId: types.arte_digital,
    deadline: plusDays(-2),
  });
  await caio.browser.post(`/api/v1/tasks/${t4}/deliveries`, { quantity: 2 });
  await caio.browser.post(`/api/v1/tasks/${t4}/move`, { statusKey: "concluido" });

  // captação marcada pelo Gil
  await task(gil.browser, { title: "Captação loja", projectId: cafeProject, taskTypeId: types.captacao });

  // tempo: Fabi 2 h na T1 + 1 h em ajustes (entradas fechadas ao meio-dia de hoje)
  const ins =
    "insert into time_entries (id, tenant_id, user_id, task_id, started_at, ended_at, business_ms, status_at_start) values (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7)";
  await owner.query(ins, [
    tenantId,
    fabi.userId,
    t1,
    new Date(noon.getTime() - 3 * H),
    new Date(noon.getTime() - H),
    2 * H,
    "em_andamento",
  ]);
  await owner.query(ins, [tenantId, fabi.userId, t1, new Date(noon.getTime() - H), noon, H, "ajustes"]);
});

describe("conciliação (§9)", () => {
  test("peças entregues batem em entregas, produtividade e contratado × entregue", async () => {
    const d = await admin.get(`/api/v1/reports/deliveries?${MONTH_Q}`);
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    const p = await admin.get(`/api/v1/reports/productivity?${MONTH_Q}`);
    const c = await admin.get(`/api/v1/reports/contracted-delivered?month=${month}`);
    expect(d.json.totalPieces).toBe(6);
    expect(p.json.totals.pieces).toBe(6);
    expect(c.json.all.total.delivered).toBe(6);
    expect(d.json.byPerson.reduce((a: number, x: { pieces: number }) => a + x.pieces, 0)).toBe(6);
  });
});

describe("entregas realizadas", () => {
  test("por dia, pessoa, categoria, tipo e cliente; filtros", async () => {
    const d = (await gil.browser.get(`/api/v1/reports/deliveries?${MONTH_Q}`)).json;
    expect(d.byDay).toEqual([{ day: today, pieces: 6, deliveries: 3 }]);
    expect(d.byPerson.map((x: { name: string; pieces: number }) => [x.name, x.pieces])).toEqual([
      ["Fabi", 4],
      ["Caio", 2],
    ]);
    expect(d.byCategory).toEqual([expect.objectContaining({ slug: "artes", pieces: 6 })]);
    expect(
      d.byClient.map((x: { client: { code: string } | null; pieces: number }) => [
        x.client?.code ?? null,
        x.pieces,
      ]),
    ).toEqual([
      ["CAFE", 3],
      ["PAO", 2],
      [null, 1],
    ]);
    const onlyCafe = (await gil.browser.get(`/api/v1/reports/deliveries?${MONTH_Q}&clientId=${cafe}`)).json;
    expect(onlyCafe.totalPieces).toBe(3);
    const onlyCaio = (await gil.browser.get(`/api/v1/reports/deliveries?${MONTH_Q}&userId=${caio.userId}`))
      .json;
    expect(onlyCaio.records).toHaveLength(1);
    expect((await fabi.browser.get(`/api/v1/reports/deliveries?${MONTH_Q}`)).status).toBe(403);
    expect((await stranger.get(`/api/v1/reports/deliveries?${MONTH_Q}`)).json.totalPieces).toBe(0);
    expect((await admin.get("/api/v1/reports/deliveries?from=2026-01-01&to=2028-01-01")).status).toBe(400);
  });
});

describe("produtividade", () => {
  test("placar de produção e atendimento com os pesos padrão", async () => {
    const p = (await gil.browser.get(`/api/v1/reports/productivity?${MONTH_Q}`)).json;
    const row = (name: string) => p.rows.find((r: { user: { name: string } }) => r.user.name === name);
    // Fabi: 10×4 peças + 1×3 h + 5×1 no prazo − 3×1 ajuste interno = 45
    expect(row("Fabi").production).toEqual({ pieces: 4, hours: 3, onTime: 1, rework: 1, score: 45 });
    expect(row("Fabi").sector).toMatchObject({ name: "Design" });
    // Caio: 2 peças, entregue com atraso
    expect(row("Caio").production).toMatchObject({ pieces: 2, onTime: 0, score: 20 });
    // Gil (atendimento): 100% das datas + 2×1 cobrança + 5×1 captação + 2×3 peças − 5×1 card parado = 108
    expect(row("Gil").account).toEqual({
      clientDatesMet: 1,
      clientDatesTotal: 1,
      clientDatesPct: 100,
      chases: 1,
      shoots: 1,
      pieces: 3,
      idleCards: 1,
      score: 108,
    });
    expect(row("Caio").account).toBeNull();
    expect(p.highlight.user.name).toBe("Fabi");
    expect(p.weights.production.perPiece).toBe(10);

    const design = (
      await gil.browser.get(`/api/v1/reports/productivity?${MONTH_Q}&sectorId=${row("Fabi").sector.id}`)
    ).json;
    expect(design.rows.map((r: { user: { name: string } }) => r.user.name)).toEqual(["Fabi"]);
    expect((await fabi.browser.get(`/api/v1/reports/productivity?${MONTH_Q}`)).status).toBe(403);
  });

  test("cada número abre os registros por trás dele", async () => {
    const pieces = (
      await gil.browser.get(
        `/api/v1/reports/productivity/drill?${MONTH_Q}&userId=${fabi.userId}&metric=pieces`,
      )
    ).json;
    expect(pieces.items.map((i: { value: number }) => i.value).sort()).toEqual([1, 3]);
    const hours = (
      await gil.browser.get(
        `/api/v1/reports/productivity/drill?${MONTH_Q}&userId=${fabi.userId}&metric=hours`,
      )
    ).json;
    expect(hours.items.reduce((a: number, i: { value: number }) => a + i.value, 0)).toBe(3);
    const idle = (
      await gil.browser.get(
        `/api/v1/reports/productivity/drill?${MONTH_Q}&userId=${gil.userId}&metric=idleCards`,
      )
    ).json;
    expect(idle.items).toEqual([expect.objectContaining({ taskId: t2, title: "Reels lançamento" })]);
    const dates = (
      await gil.browser.get(
        `/api/v1/reports/productivity/drill?${MONTH_Q}&userId=${gil.userId}&metric=clientDates`,
      )
    ).json;
    expect(dates.items).toEqual([expect.objectContaining({ taskId: t1, ok: true })]);
    // a própria pessoa vê o próprio detalhamento; o de outra, não
    expect(
      (
        await fabi.browser.get(
          `/api/v1/reports/productivity/drill?${MONTH_Q}&userId=${fabi.userId}&metric=rework`,
        )
      ).json.items,
    ).toHaveLength(1);
    expect(
      (
        await fabi.browser.get(
          `/api/v1/reports/productivity/drill?${MONTH_Q}&userId=${caio.userId}&metric=pieces`,
        )
      ).status,
    ).toBe(403);
  });

  test("minha produtividade", async () => {
    const m = (await fabi.browser.get(`/api/v1/reports/my-productivity?${MONTH_Q}`)).json;
    expect(m.me.production.pieces).toBe(4);
    expect(m.deliveries.totalPieces).toBe(4);
    expect(m.deliveries.byCategory).toEqual([expect.objectContaining({ slug: "artes", pieces: 4 })]);
  });
});

describe("contratado × entregue", () => {
  test("por cliente e categoria, com em andamento, a começar e avisos", async () => {
    const c = (await gil.browser.get(`/api/v1/reports/contracted-delivered?month=${month}`)).json;
    const cafeRow = c.clients.find((x: { client: { code: string } | null }) => x.client?.code === "CAFE");
    expect(cafeRow.cells.artes).toEqual({ contracted: 10, delivered: 3, inProgress: 0, toStart: 7 });
    expect(cafeRow.cells.videos).toEqual({ contracted: 4, delivered: 0, inProgress: 2, toStart: 2 });
    // a captação aberta conta em andamento (Captações não foi contratada: nada a começar)
    expect(cafeRow.cells.captacoes).toEqual({ contracted: 0, delivered: 0, inProgress: 1, toStart: 0 });
    expect(cafeRow.total).toEqual({ contracted: 14, delivered: 3, inProgress: 3, toStart: 9 });
    expect(c.clients.find((x: { client: unknown }) => x.client === null).total.delivered).toBe(1);
    expect(c.categories.at(-1)).toEqual({ slug: "outros", label: "Outros" });
    expect(c.warnings).toEqual([expect.objectContaining({ projectId: cafeProject })]);

    const only = (
      await gil.browser.get(`/api/v1/reports/contracted-delivered?month=${month}&clientId=${cafe}`)
    ).json;
    expect(only.clients).toHaveLength(1);
    // mês sem nada
    const empty = (await gil.browser.get("/api/v1/reports/contracted-delivered?month=2020-01")).json;
    expect(empty.all.total.delivered).toBe(0);
  });
});

describe("ajustes e financeiro", () => {
  test("ajustes por pessoa, motivo e categoria; retrabalho em % do tempo", async () => {
    const a = (await gil.browser.get(`/api/v1/reports/adjustments?${MONTH_Q}`)).json;
    expect(a).toMatchObject({ total: 1, internal: 1, client: 0 });
    expect(a.rework).toEqual({ reworkHours: 1, workedHours: 3, pct: 33.3 });
    expect(a.byPerson[0]).toMatchObject({ name: "Fabi", internal: 1, reworkHours: 1, workedHours: 3 });
    expect(a.byCategory).toEqual([{ label: "Artes", internal: 1, client: 0, total: 1 }]);
    expect(a.records[0]).toMatchObject({ kind: "internal", task: { id: t1 } });
  });

  test("financeiro: recebido, pagamentos e contratos em atraso", async () => {
    const c = await admin.post(`/api/v1/projects/${cafeProject}/contracts`, {
      modality: "parcelado",
      totalValueCents: 300_00,
      installmentsCount: 3,
      firstDueDate: ymd(new Date(Date.now() - 40 * 86_400_000)),
    });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const first = c.json.installments[0];
    await admin.post(`/api/v1/installments/${first.id}/pay`, {
      paidAt: today,
      paidAmountCents: 100_00,
      method: "pix",
    });
    const f = (await admin.get(`/api/v1/reports/financial?${MONTH_Q}`)).json;
    expect(f).toMatchObject({ receivedCents: 100_00, paymentsCount: 1 });
    expect(f.payments[0]).toMatchObject({
      source: "contrato",
      project: "Café | Mensal",
      client: { code: "CAFE" },
    });
    expect(f.overdueContracts).toEqual([expect.objectContaining({ installments: 1, amountCents: 100_00 })]);
    // gestor tem relatórios e financeiro; funcionário não
    expect((await gil.browser.get(`/api/v1/reports/financial?${MONTH_Q}`)).status).toBe(200);
    expect((await fabi.browser.get(`/api/v1/reports/financial?${MONTH_Q}`)).status).toBe(403);
  });
});

describe("exportação", () => {
  const get = (b: Browser, q: string) => b.raw(`/api/v1/reports/export?${q}`);

  test("CSV, XLSX e PDF com os mesmos números", async () => {
    const csv = await get(admin, `report=deliveries&format=csv&${MONTH_Q}`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toContain("entregas-realizadas.csv");
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM para o Excel
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("Data,Pessoa,Cliente,Tarefa,Tipo,Categoria,Peças,Observação");
    expect(text).toContain("CAFE - Café");

    const xlsx = await get(admin, `report=contracted-delivered&format=xlsx&month=${month}&lang=en`);
    expect(xlsx.headers.get("content-type")).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await xlsx.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toContain("All clients");
    const sheet = wb.getWorksheet("CAFE - Café")!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      "Category",
      "Contracted",
      "Delivered",
      "In progress",
      "To start",
    ]);
    expect(sheet.getRow(2).values).toEqual([undefined, "Artes", 10, 3, 0, 7]);

    for (const report of ["productivity", "adjustments", "financial"]) {
      const pdf = await get(admin, `report=${report}&format=pdf&${MONTH_Q}`);
      expect(pdf.status, report).toBe(200);
      const doc = await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    }
    expect((await get(fabi.browser, `report=my-productivity&format=csv&${MONTH_Q}`)).status).toBe(200);
    expect((await get(fabi.browser, `report=deliveries&format=csv&${MONTH_Q}`)).status).toBe(403);
  });
});

test("rotas de relatórios aparecem na documentação OpenAPI", async () => {
  const doc = await admin.get("/api/openapi.json");
  expect(doc.status).toBe(200);
  expect(Object.keys(doc.json.paths)).toEqual(
    expect.arrayContaining([
      "/api/v1/reports/productivity",
      "/api/v1/reports/contracted-delivered",
      "/api/v1/reports/export",
    ]),
  );
});
