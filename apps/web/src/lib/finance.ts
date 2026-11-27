import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "./api";

/** Financeiro (§6.6): visão geral, contratos do projeto, mensalidades e assinatura eletrônica. */
export const financeOverviewQuery = queryOptions({
  queryKey: ["finance", "overview"],
  queryFn: () => unwrap(api.finance.overview.$get({ query: {} })),
});
export const projectContractsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["finance", "contracts", projectId],
    queryFn: () => unwrap(api.projects[":id"].contracts.$get({ param: { id: projectId } })),
  });
export type SubscriptionFilter = "active" | "canceled" | "all";
export const subscriptionsQuery = (status: SubscriptionFilter) =>
  queryOptions({
    queryKey: ["finance", "subscriptions", status],
    queryFn: () => unwrap(api.finance.subscriptions.$get({ query: { status } })),
  });
export const subscriptionChargesQuery = (id: string) =>
  queryOptions({
    queryKey: ["finance", "subscriptions", id, "charges"],
    queryFn: () => unwrap(api.finance.subscriptions[":id"].installments.$get({ param: { id } })),
  });
export const projectSignaturesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["signatures", projectId],
    queryFn: () => unwrap(api.projects[":id"].signatures.$get({ param: { id: projectId } })),
  });

export type Contract = Awaited<
  ReturnType<NonNullable<ReturnType<typeof projectContractsQuery>["queryFn"]>>
>["data"][number];
export type Installment = Contract["installments"][number];
export type SignatureRequest = Awaited<
  ReturnType<NonNullable<ReturnType<typeof projectSignaturesQuery>["queryFn"]>>
>["data"][number];

/** "R$ 1.234,56" (ou "1234.56") → centavos. Vírgula manda quando aparece. */
export function parseMoney(s: string): number | null {
  const clean = s.replace(/[^\d.,-]/g, "");
  if (!clean) return null;
  // "1.500" e "1.234.567" são milhares (pt-BR); "1500.5" usa ponto como decimal.
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : /^-?\d{1,3}(\.\d{3})+$/.test(clean)
      ? clean.replace(/\./g, "")
      : clean;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
export const centsToInput = (cents: number, locale: string) =>
  new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  }).format(cents / 100);

export const brl = (cents: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "BRL" }).format(cents / 100);

export const todayYmd = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const INSTALLMENT_TONE = {
  pendente: "secondary",
  pago: "success",
  atrasado: "destructive",
  estornado: "outline",
} as const;
export const CONTRACT_TONE = { ativo: "default", concluido: "success", cancelado: "secondary" } as const;
export const SIGNATURE_TONE = {
  rascunho: "secondary",
  enviado: "default",
  assinado: "success",
  recusado: "destructive",
  cancelado: "outline",
} as const;
export const SIGNER_TONE = {
  pendente: "secondary",
  visualizou: "default",
  assinou: "success",
  recusou: "destructive",
} as const;

/** SHA-256 de um arquivo no navegador (para conferir na página de verificação). */
export async function sha256OfFile(file: File) {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Prévia da divisão em parcelas (mesma regra do servidor: centavos que sobram vão nas primeiras). */
export function splitPreview(totalCents: number, count: number) {
  const c = Math.max(totalCents > 0 ? 1 : 0, count);
  if (!c || totalCents <= 0) return { count: 0, first: 0, last: 0 };
  const base = Math.floor(totalCents / c);
  return { count: c, first: base + (totalCents - base * c ? 1 : 0), last: base };
}
