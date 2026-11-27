/**
 * Documentação da API pública (§6.13): esquema de autenticação e os exemplos pedidos na spec.
 * Os mesmos exemplos rodam nos testes (`api-publica.test.ts`), então o que está escrito funciona.
 */
export type ApiExample = {
  id: string;
  title: string;
  method: "GET" | "POST";
  /** Caminho com marcadores `{NOME}`, trocados pelos ids reais. */
  path: string;
  body?: Record<string, unknown>;
  note?: string;
};

export const API_EXAMPLES: ApiExample[] = [
  {
    id: "standalone-task",
    title: "Criar uma tarefa avulsa (sem projeto)",
    method: "POST",
    path: "/api/v1/tasks",
    body: { title: "Revisar textos do site", priority: "alta", deadline: "2030-01-15T18:00:00-03:00" },
  },
  {
    id: "project-task",
    title: "Criar uma tarefa num projeto",
    method: "POST",
    path: "/api/v1/tasks",
    body: { title: "Post de lançamento", projectId: "{PROJECT_ID}", pieceQuantity: 3 },
    note: "O id do projeto aparece em GET /api/v1/projects. A tarefa conta na cota do plano.",
  },
  {
    id: "pending-installments",
    title: "Listar parcelas pendentes e atrasadas",
    method: "GET",
    path: "/api/v1/installments?status=pendente,atrasado",
  },
  {
    id: "pay-installment",
    title: "Marcar uma parcela como paga",
    method: "POST",
    path: "/api/v1/installments/{INSTALLMENT_ID}/pay",
    body: { paidAt: "2030-01-10", paidAmountCents: 150000, method: "pix" },
  },
];

const curl = (base: string, e: ApiExample) =>
  [
    `curl -X ${e.method} '${base}${e.path}'`,
    "  -H 'Authorization: Bearer pk_live_SEU_PREFIXO_SEU_SEGREDO'",
    ...(e.body ? ["  -H 'Content-Type: application/json'", `  -d '${JSON.stringify(e.body)}'`] : []),
  ].join(" \\\n");

export const apiDescription = (base: string) =>
  [
    "API REST do Rec PM. Todas as rotas ficam em `/api/v1`.",
    "",
    "## Autenticação",
    "Crie a chave em **Configurações › Chaves de API** (admin). Ela aparece uma única vez, no formato `pk_live_…`.",
    "Envie em todo pedido: `Authorization: Bearer pk_live_…`. A chave tem as mesmas permissões de quem a criou.",
    "A API pública faz parte dos planos Profissional e Enterprise.",
    "",
    "## Limites",
    "120 pedidos por minuto por chave. As respostas trazem `X-RateLimit-Limit`, `X-RateLimit-Remaining` e `X-RateLimit-Reset`; acima do limite, `429` com `Retry-After`.",
    "",
    "## Erros",
    'Corpo `{ "error": { "code": "…", "message": "…" } }`. `401` chave inválida, `402` cota ou recurso fora do plano, `403` sem permissão, `404` não encontrado, `429` limite.',
    "",
    "## Exemplos",
    ...API_EXAMPLES.flatMap((e) => [
      `### ${e.title}`,
      ...(e.note ? [e.note, ""] : []),
      "```bash",
      curl(base, e),
      "```",
      "",
    ]),
    "## Webhooks",
    "Em **Configurações › Webhooks** (plano Enterprise) cadastre uma URL e os eventos: `task.created`, `task.status_changed`, `task.completed`, `project.created`, `installment.paid`.",
    "Cada entrega é um POST JSON `{ id, event, createdAt, tenantId, data }` com os cabeçalhos `X-RecPM-Event`, `X-RecPM-Delivery` e `X-RecPM-Signature: t=<unix>,v1=<hex>`.",
    "A assinatura é HMAC-SHA256 do texto `<t>.<corpo>` com o segredo do webhook. Responda 2xx em até 10 s; senão tentamos de novo (1 min, 5 min, 30 min, 2 h, 6 h, 24 h).",
  ].join("\n");
