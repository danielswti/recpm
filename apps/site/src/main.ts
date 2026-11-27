import { FALLBACK_PLANS, FEATURE_LABELS, type Plan, TAGLINES } from "./plans";

// ── links para o app: em produção o app fica em app.<domínio>; em dev, no Vite do app ──
const appOrigin = (() => {
  const { protocol, hostname, port } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return `${protocol}//${hostname}:5173`;
  return `${protocol}//app.${hostname.replace(/^www\./, "")}${port ? `:${port}` : ""}`;
})();
for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-app-link]"))
  a.href = `${appOrigin}${a.dataset.appLink}`;

for (const el of document.querySelectorAll("[data-year]")) el.textContent = String(new Date().getFullYear());

// ── aviso de cookies (só cookies essenciais; guardamos que a pessoa já viu) ──
const KEY = "recpm-cookies-ok";
const banner = document.querySelector<HTMLElement>("[data-cookie-banner]");
const seen = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
if (banner && !seen()) banner.hidden = false;
document.querySelector("[data-cookie-ok]")?.addEventListener("click", () => {
  try {
    localStorage.setItem(KEY, "1");
  } catch {}
  if (banner) banner.hidden = true;
});
document.querySelector("[data-cookie-settings]")?.addEventListener("click", () => {
  if (banner) banner.hidden = false;
});

// ── planos ──
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("pt-BR");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const tasks = (p: Plan) =>
  p.limits.tasksPerCycle === null
    ? "Tarefas ilimitadas"
    : `${num.format(p.limits.tasksPerCycle)} tarefas por mês`;
const users = (p: Plan) =>
  p.limits.maxUsers === null ? "Usuários ilimitados" : `Até ${p.limits.maxUsers} usuários`;
const storage = (p: Plan) =>
  p.limits.storageGb >= 1000
    ? `${num.format(p.limits.storageGb / 1000)} TB de arquivos`
    : `${p.limits.storageGb} GB de arquivos`;
const price = (p: Plan) =>
  p.priceMonthlyCents === 0
    ? `<span class="text-3xl font-bold">Grátis</span>`
    : `${p.priceIsStartingAt ? `<span class="text-sm text-slate-500">a partir de </span>` : ""}<span class="text-3xl font-bold">${brl.format(p.priceMonthlyCents / 100)}</span><span class="text-sm text-slate-500">/mês</span>`;

function card(p: Plan) {
  const featured = p.slug === "profissional";
  const feats = FEATURE_LABELS.filter(([k]) => p.features[k]).map(([, l]) => l);
  const cta = p.priceMonthlyCents === 0 ? "Começar grátis" : `Testar ${p.trialDays || 14} dias grátis`;
  return `<article class="relative grid content-start gap-4 rounded-2xl border ${featured ? "border-brand shadow-lg shadow-brand/10" : "border-slate-200"} bg-white p-6">
    ${featured ? `<p class="absolute -top-3 left-6 rounded-full bg-brand px-3 py-0.5 text-xs font-semibold text-white">Mais escolhido</p>` : ""}
    <div><h3 class="text-lg font-semibold">${esc(p.name)}</h3><p class="mt-1 text-sm text-slate-600">${esc(TAGLINES[p.slug] ?? "")}</p></div>
    <p>${price(p)}</p>
    <a href="${appOrigin}/cadastro" class="${featured ? "btn-primary" : "btn-ghost"}">${cta}</a>
    <ul class="grid gap-2 text-sm text-slate-700">
      <li>✓ ${tasks(p)}</li><li>✓ ${users(p)}</li><li>✓ ${storage(p)}</li>
      ${feats.map((l) => `<li>✓ ${esc(l)}</li>`).join("")}
    </ul>
  </article>`;
}

function compare(table: HTMLTableElement, plans: Plan[]) {
  const yes = `<span aria-label="Incluído" class="text-brand">✓</span>`;
  const no = `<span aria-label="Não incluído" class="text-slate-300">—</span>`;
  const rows: [string, (p: Plan) => string][] = [
    [
      "Preço mensal",
      (p) =>
        p.priceMonthlyCents === 0
          ? "Grátis"
          : `${p.priceIsStartingAt ? "a partir de " : ""}${brl.format(p.priceMonthlyCents / 100)}`,
    ],
    [
      "Tarefas por mês",
      (p) => (p.limits.tasksPerCycle === null ? "Ilimitadas" : num.format(p.limits.tasksPerCycle)),
    ],
    ["Usuários da equipe", (p) => (p.limits.maxUsers === null ? "Ilimitados" : String(p.limits.maxUsers))],
    ["Armazenamento", (p) => storage(p).replace(" de arquivos", "")],
    ["Projetos, Kanban, tempo, calendário e chat", () => yes],
    ["Relatórios, produtividade e financeiro", () => yes],
    ["Exportação dos dados", () => yes],
    ...FEATURE_LABELS.map(([k, l]): [string, (p: Plan) => string] => [l, (p) => (p.features[k] ? yes : no)]),
  ];
  table.innerHTML = `${table.querySelector("caption")?.outerHTML ?? ""}
    <thead class="bg-slate-50 text-left"><tr><th scope="col" class="px-4 py-3 font-medium">Recurso</th>${plans.map((p) => `<th scope="col" class="px-4 py-3 font-semibold">${esc(p.name)}</th>`).join("")}</tr></thead>
    <tbody class="divide-y divide-slate-100">${rows
      .map(
        ([label, fn]) =>
          `<tr><th scope="row" class="px-4 py-3 text-left font-normal text-slate-700">${esc(label)}</th>${plans.map((p) => `<td class="px-4 py-3">${fn(p)}</td>`).join("")}</tr>`,
      )
      .join("")}</tbody>`;
}

function render(plans: Plan[]) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-plans]"))
    el.innerHTML = plans.map(card).join("");
  const t = document.querySelector<HTMLTableElement>("[data-compare]");
  if (t) compare(t, plans);
}

if (document.querySelector("[data-plans], [data-compare]")) {
  render(FALLBACK_PLANS);
  fetch("/api/v1/public/plans")
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { data: Plan[] } | null) => {
      if (j?.data?.length) render(j.data);
    })
    .catch(() => {});
}
