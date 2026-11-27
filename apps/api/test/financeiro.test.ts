/**
 * Fase 7 — financeiro (contratos, parcelas, pagamentos, estornos, mensalidades, atrasos) e
 * assinatura eletrônica (pedido, links pessoais, assinar/recusar, PDF com certificado, verificação).
 */
import { createHash } from "node:crypto";
import { addMonthsYmd, runFinanceDaily, splitCents } from "@recpm/core";
import { PDFDocument } from "pdf-lib";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Storage } from "../src/lib/storage";
import { addMember, Browser, createWorkspace, setupApp, signUp, WEB } from "./helpers";

const objects = new Map<string, Uint8Array>();
const storage: Storage = {
  presignUpload: async (key) => ({ url: `https://bucket.test/${key}?sig=1`, headers: {} }),
  presignDownload: async (key) => `https://bucket.test/${key}?download=1`,
  head: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)!.byteLength } : null),
  get: async (key) => objects.get(key) ?? null,
  put: async (key, body) => {
    objects.set(key, body);
  },
};

const { app, mailer, urls, dbs } = setupApp({ storage });
const owner = new Pool({ connectionString: urls.owner });
afterAll(async () => {
  await owner.end();
  await app.live.close();
});

const admin = new Browser(app);
const stranger = new Browser(app);
let tenantId: string;
let gestor: { browser: Browser; userId: string };
let fabi: { browser: Browser; userId: string };
let clientId: string;
let projectId: string;

const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

beforeAll(async () => {
  await signUp(admin, "Ana");
  tenantId = (await createWorkspace(admin, "Agência Grana")).id;
  await signUp(stranger, "Estranho");
  await createWorkspace(stranger, "Outra");
  gestor = await addMember(app, admin, mailer, tenantId, "Gil", "gestor");
  fabi = await addMember(app, admin, mailer, tenantId, "Fabi", "funcionario");
  clientId = (await admin.post("/api/v1/clients", { code: "PAO", name: "Padaria" })).json.id;
  projectId = (
    await admin.post("/api/v1/projects", { name: "Padaria | Site", clientId, managerId: gestor.userId })
  ).json.id;
});

describe("núcleo", () => {
  test("divide centavos e soma meses mantendo o dia", () => {
    expect(splitCents(1000, 3)).toEqual([334, 333, 333]);
    expect(splitCents(1000, 3).reduce((a, b) => a + b)).toBe(1000);
    expect(addMonthsYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsYmd("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonthsYmd("2026-02-28", 1, 31)).toBe("2026-03-31");
  });
});

describe("contratos e parcelas", () => {
  let contractId: string;

  test("cria contrato parcelado com parcelas mensais e permissões", async () => {
    const first = addMonthsYmd(today(), -1); // a 1ª já venceu
    const r = await gestor.browser.post(`/api/v1/projects/${projectId}/contracts`, {
      modality: "parcelado",
      totalValueCents: 1_000_00,
      installmentsCount: 3,
      firstDueDate: first,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    contractId = r.json.id;
    expect(r.json.installments.map((i: { amountCents: number }) => i.amountCents)).toEqual([
      33334, 33333, 33333,
    ]);
    expect(r.json.installments.map((i: { dueDate: string }) => i.dueDate)).toEqual([
      first,
      addMonthsYmd(first, 1),
      addMonthsYmd(first, 2),
    ]);
    expect(r.json.installments[0].status).toBe("atrasado");
    expect(r.json.remainingCents).toBe(1_000_00);

    // funcionário não vê o financeiro; outro workspace não vê o contrato
    expect((await fabi.browser.get(`/api/v1/projects/${projectId}/contracts`)).status).toBe(403);
    expect((await fabi.browser.get("/api/v1/finance/overview")).status).toBe(403);
    expect((await stranger.get(`/api/v1/projects/${projectId}/contracts`)).json.data).toHaveLength(0);
  });

  test("pagar, estornar e recalcular quando as condições mudam", async () => {
    const list = (await admin.get(`/api/v1/projects/${projectId}/contracts`)).json.data[0];
    const [p1, p2] = list.installments;
    const pay = await admin.post(`/api/v1/installments/${p1.id}/pay`, {
      paidAt: today(),
      paidAmountCents: p1.amountCents,
      method: "pix",
    });
    expect(pay.status, JSON.stringify(pay.json)).toBe(200);
    expect(pay.json).toMatchObject({ status: "pago", method: "pix" });
    expect(
      (
        await admin.post(`/api/v1/installments/${p1.id}/pay`, {
          paidAt: today(),
          paidAmountCents: 1,
          method: "pix",
        })
      ).status,
    ).toBe(409);

    // novo total: o que falta (R$ 1.200 − pago) vira 2 parcelas
    const up = await admin.patch(`/api/v1/contracts/${contractId}`, { totalValueCents: 1_200_00 });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    const open = up.json.installments.filter((i: { status: string }) => i.status !== "pago");
    expect(open).toHaveLength(2);
    expect(open.reduce((a: number, i: { amountCents: number }) => a + i.amountCents, 0)).toBe(
      1_200_00 - p1.amountCents,
    );
    expect(up.json.paidCents).toBe(p1.amountCents);

    // estorno: volta a ser devido e entra no recálculo
    const rev = await admin.post(`/api/v1/installments/${p1.id}/reverse`);
    expect(rev.json.status).toBe("estornado");
    const after = (await admin.get(`/api/v1/projects/${projectId}/contracts`)).json.data[0];
    expect(after.paidCents).toBe(0);
    expect(after.remainingCents).toBe(1_200_00);
    expect(p2).toBeDefined();
  });

  test("quitar tudo conclui o contrato; cancelar tira as parcelas em aberto", async () => {
    let c = (await admin.get(`/api/v1/projects/${projectId}/contracts`)).json.data[0];
    for (const i of c.installments.filter(
      (x: { status: string }) => x.status === "pendente" || x.status === "atrasado",
    ))
      await admin.post(`/api/v1/installments/${i.id}/pay`, {
        paidAt: today(),
        paidAmountCents: i.amountCents,
        method: "boleto",
      });
    c = (await admin.get(`/api/v1/projects/${projectId}/contracts`)).json.data[0];
    expect(c.status).toBe("concluido");
    expect(c.remainingCents).toBe(0);
    expect((await admin.del(`/api/v1/contracts/${c.id}`)).status).toBe(409);

    const other = await admin.post(`/api/v1/projects/${projectId}/contracts`, {
      modality: "parcelado",
      totalValueCents: 300_00,
      installmentsCount: 3,
      firstDueDate: addMonthsYmd(today(), 1),
    });
    const canceled = await admin.post(`/api/v1/contracts/${other.json.id}/status`, { status: "cancelado" });
    expect(canceled.json).toMatchObject({ status: "cancelado", installments: [] });
    const back = await admin.post(`/api/v1/contracts/${other.json.id}/status`, { status: "ativo" });
    expect(back.json.installments).toHaveLength(3);
    expect((await admin.del(`/api/v1/contracts/${other.json.id}`)).status).toBe(204);
  });

  test("contrato de mensalidade entra no MRR", async () => {
    const r = await admin.post(`/api/v1/projects/${projectId}/contracts`, {
      modality: "mensalidade",
      totalValueCents: 12 * 500_00,
      installmentsCount: 12,
      firstDueDate: addMonthsYmd(today(), 0),
    });
    expect(r.status).toBe(201);
    const subs = await admin.get("/api/v1/finance/subscriptions");
    const linked = subs.json.data.find((x: { contractId: string | null }) => x.contractId === r.json.id);
    expect(linked).toMatchObject({ amountCents: 500_00, status: "ativa", client: { code: "PAO" } });
    // mensalidade de contrato não se cancela por fora
    expect(
      (await admin.post(`/api/v1/finance/subscriptions/${linked.id}/status`, { status: "cancelada" })).status,
    ).toBe(409);
    await admin.post(`/api/v1/contracts/${r.json.id}/status`, { status: "cancelado" });
    const after = await admin.get("/api/v1/finance/subscriptions?status=all");
    expect(after.json.data.find((x: { id: string }) => x.id === linked.id).status).toBe("cancelada");
  });
});

describe("mensalidades e rotina diária", () => {
  test("mensalidade avulsa gera cobranças mensais, conta no MRR e cancela as futuras", async () => {
    const start = addMonthsYmd(today(), -2);
    const r = await gestor.browser.post("/api/v1/finance/subscriptions", {
      clientId,
      amountCents: 250_00,
      dayOfMonth: Number(start.slice(8, 10)),
      startedAt: start,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const inst = (await admin.get(`/api/v1/finance/subscriptions/${r.json.id}/installments`)).json.data;
    // dois meses atrás, o mês passado, este e (talvez) o próximo dentro de 35 dias
    expect(inst.length).toBeGreaterThanOrEqual(3);
    expect(inst.filter((i: { status: string }) => i.status === "atrasado").length).toBeGreaterThanOrEqual(2);
    // rodar de novo não duplica
    await runFinanceDaily(dbs);
    expect(
      (await admin.get(`/api/v1/finance/subscriptions/${r.json.id}/installments`)).json.data,
    ).toHaveLength(inst.length);

    const sub = await admin.get("/api/v1/finance/subscriptions");
    expect(sub.json.kpis.mrrCents).toBeGreaterThanOrEqual(250_00);
    expect(sub.json.data.find((x: { id: string }) => x.id === r.json.id).upToDate).toBe(false);

    await admin.post(`/api/v1/finance/subscriptions/${r.json.id}/status`, { status: "cancelada" });
    const left = (await admin.get(`/api/v1/finance/subscriptions/${r.json.id}/installments`)).json.data;
    expect(left.every((i: { dueDate: string }) => i.dueDate <= today())).toBe(true);
  });

  test("rotina marca parcelas vencidas e avisa admin e gestor uma vez", async () => {
    await owner.query(
      "update installments set status = 'pendente' where tenant_id = $1 and status = 'atrasado'",
      [tenantId],
    );
    await owner.query("delete from notifications where tenant_id = $1 and type = 'parcela_atrasada'", [
      tenantId,
    ]);
    const r = await runFinanceDaily(dbs);
    expect(r.overdue).toBeGreaterThanOrEqual(1);
    const n = await owner.query(
      "select user_id from notifications where tenant_id = $1 and type = 'parcela_atrasada'",
      [tenantId],
    );
    expect(n.rows.length).toBe(2); // admin e gestor
    await runFinanceDaily(dbs);
    expect(
      (
        await owner.query("select 1 from notifications where tenant_id = $1 and type = 'parcela_atrasada'", [
          tenantId,
        ])
      ).rows.length,
    ).toBe(2);
  });

  test("visão geral bate com as parcelas", async () => {
    const o = await gestor.browser.get("/api/v1/finance/overview");
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const sums = (
      await owner.query(
        `select coalesce(sum(amount_cents) filter (where status = 'atrasado'), 0)::bigint as overdue,
                coalesce(sum(amount_cents) filter (where status = 'pendente'), 0)::bigint as pending
           from installments where tenant_id = $1`,
        [tenantId],
      )
    ).rows[0];
    expect(o.json.kpis.overdueCents).toBe(Number(sums.overdue));
    expect(o.json.kpis.pendingCents).toBe(Number(sums.pending));
    expect(o.json.kpis.receivedCents).toBeGreaterThan(0);
    expect(o.json.contracts.length).toBeGreaterThanOrEqual(2);
    expect((await stranger.get("/api/v1/finance/overview")).json.kpis.receivedCents).toBe(0);
  });
});

describe("assinatura eletrônica", () => {
  let fileId: string;
  let originalHash: string;
  let requestId: string;
  const linkOf = (email: string) => {
    const m = mailer.outbox.findLast((x) => x.to === email && x.subject.includes("pediu sua assinatura"));
    return m!.text.match(/\/assinar\/([\w-]+)/)![1]!;
  };
  const pub = new Browser(app);

  beforeAll(async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText("Contrato de prestação de serviços");
    const bytes = await doc.save();
    originalHash = createHash("sha256").update(bytes).digest("hex");
    const up = await admin.post("/api/v1/files/uploads", {
      name: "contrato.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
    });
    fileId = up.json.fileId;
    const key = new URL(up.json.uploadUrl).pathname.slice(1);
    objects.set(key, bytes);
    expect((await admin.post(`/api/v1/files/${fileId}/complete`)).status).toBe(200);
  });

  test("cria, envia links pessoais e só a equipe do projeto vê", async () => {
    const r = await admin.post("/api/v1/signatures", {
      projectId,
      title: "Contrato do site",
      documentFileId: fileId,
      signers: [
        { name: "Paula Padeira", email: "paula@padaria.test" },
        { name: "Gil", email: "gil@agencia.test" },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    requestId = r.json.id;
    expect(r.json).toMatchObject({ status: "rascunho", documentSha256: originalHash });
    expect(r.json.verificationCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await fabi.browser.post(`/api/v1/signatures/${requestId}/send`)).status).toBe(403);

    const sent = await admin.post(`/api/v1/signatures/${requestId}/send`);
    expect(sent.json.status).toBe("enviado");
    expect(linkOf("paula@padaria.test")).toBeTruthy();
    expect((await admin.post(`/api/v1/signatures/${requestId}/send`)).status).toBe(409);
    expect((await stranger.get(`/api/v1/projects/${projectId}/signatures`)).status).toBe(404);
    const list = await gestor.browser.get(`/api/v1/projects/${projectId}/signatures`);
    expect(list.json.data[0].signers.map((x: { status: string }) => x.status)).toEqual([
      "pendente",
      "pendente",
    ]);
  });

  test("o signatário vê, assina digitando o nome e o último gera o PDF com certificado", async () => {
    const paula = linkOf("paula@padaria.test");
    const v = await pub.get(`/api/v1/public/sign/${paula}`);
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json).toMatchObject({
      workspace: "Agência Grana",
      title: "Contrato do site",
      me: { status: "visualizou" },
    });
    expect((await pub.get("/api/v1/public/sign/token-que-nao-existe-123456")).status).toBe(404);

    expect(
      (await pub.post(`/api/v1/public/sign/${paula}/sign`, { typedName: "Outra Pessoa", agree: true }))
        .status,
    ).toBe(400);
    const s1 = await pub.req(
      "POST",
      `/api/v1/public/sign/${paula}/sign`,
      { typedName: "paula padeira", agree: true },
      {
        "x-forwarded-for": "203.0.113.7",
        "user-agent": "TesteBrowser/1.0",
      },
    );
    expect(s1.status, JSON.stringify(s1.json)).toBe(200);
    expect(s1.json.me.status).toBe("assinou");
    expect(s1.json.status).toBe("enviado");
    expect(
      (await pub.post(`/api/v1/public/sign/${paula}/sign`, { typedName: "Paula Padeira", agree: true }))
        .status,
    ).toBe(409);

    // reenviar troca o link
    const gilSigner = (await admin.get(`/api/v1/projects/${projectId}/signatures`)).json.data[0].signers.find(
      (x: { email: string }) => x.email === "gil@agencia.test",
    );
    const oldGil = linkOf("gil@agencia.test");
    expect((await admin.post(`/api/v1/signatures/${requestId}/signers/${gilSigner.id}/resend`)).status).toBe(
      204,
    );
    const gil = linkOf("gil@agencia.test");
    expect(gil).not.toBe(oldGil);
    expect((await pub.get(`/api/v1/public/sign/${oldGil}`)).status).toBe(404);

    const s2 = await pub.post(`/api/v1/public/sign/${gil}/sign`, { typedName: "Gil", agree: true });
    expect(s2.json.status).toBe("assinado");
    expect(s2.json.signedSha256).toMatch(/^[0-9a-f]{64}$/);

    const req = (await admin.get(`/api/v1/projects/${projectId}/signatures`)).json.data[0];
    expect(req).toMatchObject({ status: "assinado", signedFileId: expect.any(String) });
    const signedKey = (await owner.query("select storage_key from files where id = $1", [req.signedFileId]))
      .rows[0].storage_key;
    const signed = objects.get(signedKey)!;
    expect(createHash("sha256").update(signed).digest("hex")).toBe(req.signedSha256);
    const pdf = await PDFDocument.load(signed);
    expect(pdf.getPageCount()).toBe(2); // original + certificado
    const ip = (await owner.query("select host(ip) as ip from signers where email = 'paula@padaria.test'"))
      .rows[0].ip;
    expect(ip).toBe("203.0.113.7");
    // o criador é avisado
    expect(
      (
        await owner.query(
          "select 1 from notifications where tenant_id = $1 and type = 'assinatura_concluida'",
          [tenantId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      mailer.outbox.some((m) => m.to === "paula@padaria.test" && m.subject.includes("assinado por todos")),
    ).toBe(true);
  });

  test("página pública de verificação pelo código", async () => {
    const req = (await admin.get(`/api/v1/projects/${projectId}/signatures`)).json.data[0];
    const v = await pub.get(`/api/v1/public/verify/${req.verificationCode.replace(/-/g, "").toLowerCase()}`);
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json).toMatchObject({
      status: "assinado",
      documentSha256: originalHash,
      signedSha256: req.signedSha256,
    });
    expect(v.json.signers[0].email).toMatch(/^pa•+@padaria\.test$/);
    expect((await pub.get("/api/v1/public/verify/AAAA-BBBB-CCCC")).status).toBe(404);
  });

  test("recusa encerra o pedido e avisa quem pediu; só PDF é aceito", async () => {
    const r = await admin.post("/api/v1/signatures", {
      projectId,
      title: "Aditivo",
      documentFileId: fileId,
      signers: [{ name: "Paula Padeira", email: "paula@padaria.test" }],
    });
    await admin.post(`/api/v1/signatures/${r.json.id}/send`);
    const t = linkOf("paula@padaria.test");
    const ref = await pub.post(`/api/v1/public/sign/${t}/refuse`, { reason: "Valor diferente do combinado" });
    expect(ref.json).toMatchObject({ status: "recusado", me: { status: "recusou" } });
    expect(
      (await pub.post(`/api/v1/public/sign/${t}/sign`, { typedName: "Paula Padeira", agree: true })).status,
    ).toBe(409);
    expect(
      (
        await owner.query(
          "select 1 from notifications where tenant_id = $1 and type = 'assinatura_recusada'",
          [tenantId],
        )
      ).rows,
    ).toHaveLength(1);

    const img = await admin.post("/api/v1/files/uploads", {
      name: "foto.png",
      mimeType: "image/png",
      sizeBytes: 10,
    });
    objects.set(new URL(img.json.uploadUrl).pathname.slice(1), new Uint8Array(10));
    await admin.post(`/api/v1/files/${img.json.fileId}/complete`);
    expect(
      (
        await admin.post("/api/v1/signatures", {
          projectId,
          title: "x",
          documentFileId: img.json.fileId,
          signers: [{ name: "Paula", email: "p@x.test" }],
        })
      ).status,
    ).toBe(400);
    expect(WEB).toBeTruthy();
  });
});
