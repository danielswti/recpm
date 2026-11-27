/**
 * Dados de exemplo, criados pela própria API (as mesmas regras do app: RLS, cotas, auditoria).
 *
 *   demo   um workspace "Agência Demo" com equipe, clientes, projetos, tarefas em todas as
 *          colunas e um usuário do portal do cliente. Imprime os logins no fim.
 *   load   carga para o teste de desempenho (§9.10): 50 workspaces e 100 mil tarefas no total.
 *          Usuários, projetos e um card modelo vêm da API; as tarefas são copiadas em lote por SQL
 *          (papel recpm_platform) para não levar horas. Não use em produção.
 *
 * Uso: pnpm --filter @recpm/api seed demo [--email demo@exemplo.com] [--password ...]
 *      pnpm --filter @recpm/api seed load [--tenants 50] [--tasks 100000]
 * Na imagem de produção: docker compose run --rm api node dist/seed.js demo --email ...
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createDbs, schema } from "@recpm/db";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { parseEnv } from "../src/env";
import { createLogger } from "../src/lib/logger";
import { memoryMailer } from "../src/lib/mailer";
import { createRedis } from "../src/lib/redis";

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    password: { type: "string" },
    tenants: { type: "string", default: "50" },
    tasks: { type: "string", default: "100000" },
    members: { type: "string", default: "5" },
    sessions: { type: "string" },
    projects: { type: "string", default: "10" },
  },
});
const mode = positionals[0];
if (mode !== "demo" && mode !== "load") {
  console.error("Uso: seed demo|load [opções]");
  process.exit(1);
}

const env = parseEnv();
const dbs = createDbs(process.env);
const mailer = memoryMailer();
const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : undefined;
const app = createApp({ env, dbs, mailer, redis, logger: createLogger("warn"), push: null, live: null });
const ORIGIN = env.WEB_URL;
let ipSeq = 1;

/** Cliente HTTP em processo, com cookies (como um navegador). */
class Client {
  private jar = new Map<string, string>();
  // IP próprio por "pessoa": o limite por IP do login não se aplica ao script
  private ip = `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await app.request(`${env.API_URL}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        "x-forwarded-for": this.ip,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair!.indexOf("=");
      const v = pair!.slice(i + 1);
      if (v === "" || /max-age=0/i.test(sc)) this.jar.delete(pair!.slice(0, i));
      else this.jar.set(pair!.slice(0, i), v);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (res.status >= 400 && !(res.status === 302))
      throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return json as T;
  }
  cookie = () => [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  get = <T = any>(p: string) => this.req<T>("GET", p);
  post = <T = any>(p: string, b: unknown = {}) => this.req<T>("POST", p, b);
  patch = <T = any>(p: string, b: unknown = {}) => this.req<T>("PATCH", p, b);
}

const pick = <T>(xs: readonly T[], i: number) => xs[i % xs.length]!;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
const isoDay = (offset: number) => day(offset).toISOString().slice(0, 10);

async function signUp(name: string, email: string, password: string) {
  const c = new Client();
  await c.post("/api/auth/sign-up/email", { name, email, password, acceptTerms: true });
  // confirma o e-mail pelo link que a API "enviaria"
  const mail = mailer.outbox.findLast((m) => m.to === email);
  const link = mail?.text.match(/https?:\/\/\S+/)?.[0];
  if (link) {
    const u = new URL(link);
    await c.req("GET", u.pathname + u.search).catch(() => {});
  }
  await c.post("/api/auth/sign-in/email", { email, password });
  return c;
}

async function invite(
  admin: Client,
  tenantId: string,
  name: string,
  email: string,
  password: string,
  role: string,
  extra = {},
) {
  const c = await signUp(name, email, password);
  const inv = await admin.post("/api/auth/organization/invite-member", {
    email,
    role,
    organizationId: tenantId,
    ...extra,
  });
  await c.post("/api/auth/organization/accept-invitation", { invitationId: inv.id });
  await c.post("/api/auth/organization/set-active", { organizationId: tenantId });
  const me = await c.get("/api/v1/me");
  return { c, userId: me.user.id as string };
}

/** Plano pago sem provedor (para o seed não depender de Stripe/Asaas). */
async function setPlan(tenantId: string, slug: string) {
  const [plan] = await dbs.platformDb.select().from(schema.plans).where(eq(schema.plans.slug, slug));
  if (!plan) throw new Error(`plano ${slug} não existe`);
  await dbs.platformDb
    .update(schema.tenantSubscriptions)
    .set({
      planId: plan.id,
      status: "active",
      provider: "manual",
      trialEndsAt: null,
      currentPeriodEnd: day(30),
    })
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
}

const COLUMNS = [
  "demandas",
  "a_fazer",
  "executar_primeiro",
  "em_andamento",
  "ajustes",
  "aguardando_aprovacao",
  "enviar_cliente",
  "aguardando_cliente",
  "veicular",
  "concluido",
] as const;

async function demo() {
  const suffix = randomBytes(2).toString("hex");
  const email = opt.email ?? `demo+${suffix}@recpm.test`;
  const password = opt.password ?? `Demo-${randomBytes(6).toString("base64url")}`;
  const domain = email.split("@")[1];
  const local = email.split("@")[0]!.split("+")[0];
  const alias = (who: string) => `${local}+${who}-${suffix}@${domain}`;

  const ana = await signUp("Ana Souza", email, password);
  const ws = await ana.post("/api/v1/workspaces", { name: "Agência Demo", slug: `demo-${suffix}` });
  await setPlan(ws.id, "profissional");

  const gil = await invite(ana, ws.id, "Gil Martins", alias("gestor"), password, "gestor");
  const fabi = await invite(ana, ws.id, "Fabi Lima", alias("design"), password, "funcionario");
  const caio = await invite(ana, ws.id, "Caio Rocha", alias("social"), password, "funcionario");
  const team = [gil.userId, fabi.userId, caio.userId];

  const clients = [];
  for (const [code, name] of [
    ["CAFE", "Café Aroma"],
    ["VERDE", "Mercado Verde"],
    ["FIT", "Studio Fit"],
  ] as const)
    clients.push(
      await ana.post("/api/v1/clients", { code, name, email: `contato@${code.toLowerCase()}.test` }),
    );

  const types = (await ana.get("/api/v1/catalogs/task-types")).data as { id: string; label: string }[];
  const reasons = (await ana.get("/api/v1/catalogs/adjustment-reasons")).data as { id: string }[];
  const projectSpecs = [
    { name: "Redes sociais (mensal)", client: 0, modality: "mensal", periodicity: "mensal" },
    { name: "Lançamento do cardápio de inverno", client: 0, modality: "avulso" },
    { name: "Identidade visual", client: 1, modality: "avulso" },
    { name: "Campanha de matrículas", client: 2, modality: "avulso" },
  ];
  const titles = [
    "Post carrossel: novidades da semana",
    "Reels: bastidores",
    "Stories: enquete",
    "Arte para anúncio",
    "Roteiro de vídeo",
    "Revisão de textos do site",
    "Fotos do produto",
    "Relatório mensal",
  ];
  let n = 0;
  const tasks: { id: string; title: string }[] = [];
  for (const [pi, p] of projectSpecs.entries()) {
    const project = await ana.post("/api/v1/projects", {
      name: p.name,
      clientId: clients[p.client].id,
      modality: p.modality,
      ...(p.periodicity ? { periodicity: p.periodicity } : {}),
      startDate: isoDay(-20),
      deliveryDeadline: isoDay(30 + pi * 10),
      clientDeliveryDate: isoDay(35 + pi * 10),
      publicSummary: "Projeto de demonstração do Rec PM.",
    });
    for (let i = 0; i < 7; i++, n++) {
      const statusKey = pick(COLUMNS, n);
      const t = await ana.post("/api/v1/tasks", {
        title: pick(titles, n + pi),
        projectId: project.id,
        assigneeId: pick(team, n),
        taskTypeId: types.length ? pick(types, n).id : null,
        deadline: day((n % 15) - 4).toISOString(),
        priority: pick(["baixa", "media", "alta"] as const, n),
        visibleToClient: n % 2 === 0,
        estimatedHours: 1 + (n % 4),
      });
      if (statusKey !== "demandas" && statusKey !== t.statusKey)
        await ana
          .post(`/api/v1/tasks/${t.id}/move`, {
            statusKey,
            ...(statusKey === "ajustes" && reasons[0]
              ? {
                  adjustment: {
                    reasonId: reasons[0].id,
                    kind: "client",
                    description: "Trocar a foto principal.",
                  },
                }
              : {}),
          })
          .catch((e) => console.warn(`  (card em ${t.statusKey}: ${(e as Error).message.slice(0, 100)})`));
      tasks.push(t);
    }
  }

  const portal = await invite(ana, ws.id, "Carla (Café Aroma)", alias("cliente"), password, "cliente", {
    clientId: clients[0].id,
  }).catch((e) => {
    console.warn(`(portal do cliente não criado: ${(e as Error).message.slice(0, 120)})`);
    return null;
  });

  console.log("\n✔ Workspace de demonstração criado: Agência Demo");
  console.log(`  Senha de todos: ${password}`);
  console.log(`  admin     ${email}`);
  console.log(`  gestor    ${alias("gestor")}`);
  console.log(`  equipe    ${alias("design")}, ${alias("social")}`);
  if (portal) console.log(`  cliente   ${alias("cliente")} (portal: /cliente)`);
}

async function load() {
  const nTenants = Number(opt.tenants);
  const perTenant = Math.ceil(Number(opt.tasks) / nTenants);
  const nMembers = Number(opt.members);
  const nProjects = Number(opt.projects);
  const run = randomBytes(2).toString("hex");
  const password = "carga-recpm-123";
  const started = Date.now();
  const users: string[] = [];
  const sessions: { cookie: string; projects: string[] }[] = [];
  for (let t = 0; t < nTenants; t++) {
    const email = `carga-${run}-${t}-admin@recpm.test`;
    const admin = await signUp(`Admin ${t}`, email, password);
    users.push(email);
    const ws = await admin.post("/api/v1/workspaces", {
      name: `Carga ${run} ${t}`,
      slug: `carga-${run}-${t}`,
    });
    await setPlan(ws.id, "enterprise");
    const members: string[] = [(await admin.get("/api/v1/me")).user.id];
    const memberClients: Client[] = [admin];
    for (let m = 0; m < nMembers; m++) {
      const e = `carga-${run}-${t}-m${m}@recpm.test`;
      const mem = await invite(
        admin,
        ws.id,
        `Pessoa ${t}.${m}`,
        e,
        password,
        m === 0 ? "gestor" : "funcionario",
      );
      members.push(mem.userId);
      memberClients.push(mem.c);
      users.push(e);
    }
    const client = await admin.post("/api/v1/clients", { code: `C${t}`, name: `Cliente ${t}` });
    const projects: string[] = [];
    for (let p = 0; p < nProjects; p++)
      projects.push((await admin.post("/api/v1/projects", { name: `Projeto ${p}`, clientId: client.id })).id);
    const model = await admin.post("/api/v1/tasks", {
      title: "Modelo",
      projectId: projects[0],
      assigneeId: members[0],
    });

    // Cópias em lote do card modelo: coluna, projeto, responsável, prazo e prioridade variam
    await dbs.platformDb.transaction(async (tx) => {
      await tx.execute(sql`
        WITH g AS (
          SELECT i, gen_random_uuid() AS id FROM generate_series(1, ${perTenant}) AS i
        ), ins AS (
          INSERT INTO tasks (id, tenant_id, project_id, title, status_key, status_since, rank, assignee_id,
                             created_by_id, source, deadline, priority, visible_to_client, estimated_hours,
                             completed_at, created_at, updated_at)
          SELECT g.id, m.tenant_id,
                 (${sql.raw(`ARRAY['${projects.join("','")}']::uuid[]`)})[1 + g.i % ${projects.length}],
                 'Tarefa ' || g.i,
                 (${sql.raw(`ARRAY['${COLUMNS.join("','")}']`)})[1 + g.i % ${COLUMNS.length}],
                 now() - (g.i % 30) * interval '1 day',
                 'a' || to_char(g.i, 'FM00000') || 'V',
                 (${sql.raw(`ARRAY['${members.join("','")}']::uuid[]`)})[1 + g.i % ${members.length}],
                 m.created_by_id, 'ui',
                 now() + ((g.i % 90) - 45) * interval '1 day',
                 (ARRAY['baixa','media','alta']::priority[])[1 + g.i % 3],
                 g.i % 3 = 0, 1 + g.i % 5,
                 CASE WHEN g.i % ${COLUMNS.length} = ${COLUMNS.length - 1} THEN now() - (g.i % 20) * interval '1 day' END,
                 now() - (g.i % 60) * interval '1 day', now()
          FROM g, tasks m WHERE m.id = ${model.id}
          RETURNING id, tenant_id, assignee_id
        )
        INSERT INTO task_assignees (tenant_id, task_id, user_id) SELECT tenant_id, id, assignee_id FROM ins
      `);
    });
    for (const mc of memberClients) sessions.push({ cookie: mc.cookie(), projects });
    process.stdout.write(`\r  workspaces: ${t + 1}/${nTenants}`);
  }
  await dbs.platformDb.execute(sql`ANALYZE tasks; ANALYZE task_assignees; ANALYZE projects`);
  const n = (
    (await dbs.platformDb.execute(sql`SELECT count(*)::int AS n FROM tasks`)).rows[0] as { n: number }
  ).n;
  console.log(
    `\n✔ Carga pronta em ${Math.round((Date.now() - started) / 1000)} s: ${nTenants} workspaces, ${n} tarefas no banco.`,
  );
  console.log(
    `  Logins (senha ${password}): carga-${run}-<0..${nTenants - 1}>-admin@recpm.test e -m<0..${nMembers - 1}>`,
  );
  if (opt.sessions) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(opt.sessions, JSON.stringify(sessions));
    console.log(`  ${sessions.length} sessões salvas em ${opt.sessions} (para o k6)`);
  }
}

try {
  await (mode === "demo" ? demo() : load());
} finally {
  redis?.disconnect();
  await Promise.all([dbs.appDb, dbs.authDb, dbs.platformDb].map((d) => (d as any).$client?.end?.()));
}
process.exit(0);
