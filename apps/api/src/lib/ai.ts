/**
 * Assistente de IA do chat (§6.9): provedor compatível com OpenAI (/chat/completions com tools).
 * O tenant usa o próprio provedor (Configurações > IA, chave criptografada) ou o padrão da
 * plataforma (AI_*). As ferramentas rodam na transação do usuário, com as permissões dele:
 * a IA só enxerga o que a pessoa enxerga.
 */
import type { Actor } from "@recpm/core";
import { type AppTx, schema } from "@recpm/db";
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import type { Env } from "../env";
import { AppError } from "./errors";
import { decryptSecret, secretsKey } from "./secrets";

const s = schema;

export type AiConfig = { baseUrl: string; apiKey: string; model: string; name: string };
type ChatMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export async function aiConfig(tx: AppTx, env: Env): Promise<AiConfig> {
  const [st] = await tx.select({ ai: s.tenantSettings.ai }).from(s.tenantSettings);
  const [sec] = await tx.select({ key: s.tenantSecrets.aiApiKeyEnc }).from(s.tenantSecrets);
  if (!st?.ai.enabled)
    throw new AppError(409, "AI_DISABLED", "O assistente de IA está desligado nas Configurações.");
  const own = sec?.key ? decryptSecret(sec.key, secretsKey(env)) : null;
  const apiKey = own ?? env.AI_API_KEY;
  if (!apiKey)
    throw new AppError(409, "AI_NOT_CONFIGURED", "Configure a chave do provedor de IA nas Configurações.");
  return {
    baseUrl: (own ? st.ai.baseUrl : null) || env.AI_BASE_URL,
    apiKey,
    model: st.ai.model || env.AI_MODEL,
    name: st.ai.assistantName || "Assistente",
  };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_tasks",
      description: "Busca tarefas que a pessoa pode ver. Use para perguntas sobre tarefas, prazos e status.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Texto no título (opcional)" },
          overdue: { type: "boolean", description: "Só atrasadas" },
          mine: { type: "boolean", description: "Só as atribuídas à pessoa" },
          projectId: { type: "string", description: "Filtrar por projeto (id)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_projects",
      description: "Busca projetos que a pessoa pode ver, pelo nome ou cliente.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "project_summary",
      description:
        "Dados de um projeto para resumir: datas, status, tarefas por coluna, atrasadas e próximos prazos.",
      parameters: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    },
  },
] as const;

export type AiTools = {
  taskVisible: (a: Actor) => ReturnType<typeof and> | undefined;
  projectVisible: (a: Actor) => ReturnType<typeof and> | undefined;
};

async function runTool(tx: AppTx, actor: Actor, vis: AiTools, name: string, args: Record<string, unknown>) {
  const like = (v: unknown) =>
    typeof v === "string" && v.trim() ? `%${v.trim().replace(/[%_\\]/g, "\\$&")}%` : null;
  if (name === "search_tasks") {
    const q = like(args.query);
    const rows = await tx
      .select({
        id: s.tasks.id,
        title: s.tasks.title,
        status: s.tasks.statusKey,
        deadline: s.tasks.deadline,
        completedAt: s.tasks.completedAt,
        project: s.projects.name,
        assignee: s.users.name,
      })
      .from(s.tasks)
      .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
      .leftJoin(s.users, eq(s.users.id, s.tasks.assigneeId))
      .where(
        and(
          isNull(s.tasks.deletedAt),
          eq(s.tasks.archived, false),
          vis.taskVisible(actor),
          q ? ilike(s.tasks.title, q) : undefined,
          args.overdue ? and(isNull(s.tasks.completedAt), sql`${s.tasks.deadline} < now()`) : undefined,
          args.mine ? eq(s.tasks.assigneeId, actor.userId!) : undefined,
          typeof args.projectId === "string" && /^[0-9a-f-]{36}$/.test(args.projectId)
            ? eq(s.tasks.projectId, args.projectId)
            : undefined,
        ),
      )
      .orderBy(asc(s.tasks.deadline))
      .limit(25);
    return rows;
  }
  if (name === "search_projects") {
    const q = like(args.query);
    return tx
      .select({ id: s.projects.id, name: s.projects.name, status: s.projects.status, client: s.clients.name })
      .from(s.projects)
      .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
      .where(
        and(
          isNull(s.projects.deletedAt),
          vis.projectVisible(actor),
          q ? sql`(${s.projects.name} ilike ${q} or ${s.clients.name} ilike ${q})` : undefined,
        ),
      )
      .orderBy(desc(s.projects.updatedAt))
      .limit(20);
  }
  if (name === "project_summary") {
    const id = String(args.projectId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) return { error: "projectId inválido" };
    const [p] = await tx
      .select({ p: s.projects, client: s.clients.name })
      .from(s.projects)
      .leftJoin(s.clients, eq(s.clients.id, s.projects.clientId))
      .where(and(eq(s.projects.id, id), isNull(s.projects.deletedAt), vis.projectVisible(actor)));
    if (!p) return { error: "Projeto não encontrado ou sem acesso." };
    const byStatus = await tx
      .select({ status: s.tasks.statusKey, n: sql<number>`count(*)::int` })
      .from(s.tasks)
      .where(and(eq(s.tasks.projectId, id), isNull(s.tasks.deletedAt), eq(s.tasks.archived, false)))
      .groupBy(s.tasks.statusKey);
    const next = await tx
      .select({ title: s.tasks.title, deadline: s.tasks.deadline, status: s.tasks.statusKey })
      .from(s.tasks)
      .where(
        and(
          eq(s.tasks.projectId, id),
          isNull(s.tasks.deletedAt),
          isNull(s.tasks.completedAt),
          sql`${s.tasks.deadline} IS NOT NULL`,
        ),
      )
      .orderBy(asc(s.tasks.deadline))
      .limit(10);
    return {
      name: p.p.name,
      client: p.client,
      status: p.p.status,
      startDate: p.p.startDate,
      deliveryDeadline: p.p.deliveryDeadline,
      waitingClient: p.p.waitingClient,
      tasksByStatus: byStatus,
      upcomingDeadlines: next,
    };
  }
  return { error: `ferramenta desconhecida: ${name}` };
}

/**
 * Gera a resposta do assistente para a conversa (até 4 rodadas de ferramentas).
 * Devolve o texto e o registro das chamadas de ferramenta (guardado em messages.tool_calls).
 */
export async function assistantReply(opts: {
  /** Abre uma transação curta do usuário para cada ferramenta (não segura conexão durante a IA). */
  withTx: <T>(fn: (tx: AppTx) => Promise<T>) => Promise<T>;
  actor: Actor;
  config: AiConfig;
  history: { role: "user" | "assistant"; content: string }[];
  tools: AiTools;
  fetchFn: typeof fetch;
  today: string;
}): Promise<{ content: string; toolCalls: { name: string; args: unknown }[] }> {
  const { config } = opts;
  const messages: ChatMsg[] = [
    {
      role: "system",
      content: `Você é ${config.name}, assistente do Rec PM, um sistema de gestão de projetos de uma agência criativa. Responda em português do Brasil, de forma curta e prática. Hoje é ${opts.today}. Use as ferramentas para consultar tarefas e projetos; elas só mostram o que esta pessoa (${opts.actor.name ?? "usuário"}) pode ver. Nunca invente dados. Para rascunhar um briefing, use os dados do projeto e escreva em tópicos: objetivo, público, entregáveis, prazos, referências e pontos em aberto.`,
    },
    ...opts.history.map((m) => ({ role: m.role, content: m.content }) as ChatMsg),
  ];
  const log: { name: string; args: unknown }[] = [];
  for (let round = 0; round < 5; round++) {
    const res = await opts.fetchFn(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools: round < 4 ? TOOLS : undefined,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AppError(
        502,
        "AI_PROVIDER_ERROR",
        `O provedor de IA respondeu ${res.status}. ${text.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new AppError(502, "AI_PROVIDER_ERROR", "Resposta vazia do provedor de IA.");
    if (msg.tool_calls?.length) {
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {}
        log.push({ name: call.function.name, args });
        const result = await opts.withTx((tx) =>
          runTool(tx, opts.actor, opts.tools, call.function.name, args),
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 20_000),
        });
      }
      continue;
    }
    return { content: (msg.content ?? "").trim() || "…", toolCalls: log };
  }
  return { content: "Não consegui concluir a consulta. Tente reformular a pergunta.", toolCalls: log };
}
