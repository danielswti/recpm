import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { meQuery } from "./queries";

/** Só para visitantes (login, cadastro…): quem já está logado vai para o app. */
export async function guestOnly(qc: QueryClient) {
  const me = await qc.fetchQuery(meQuery);
  if (me) throw redirect({ to: "/" });
}

/** Exige sessão; devolve o usuário. Sem sessão → login, voltando para `href` depois. */
export async function requireUser(qc: QueryClient, href: string) {
  const me = await qc.fetchQuery(meQuery);
  if (!me) throw redirect({ to: "/entrar", search: { redirect: href } });
  return me;
}

/** Só aceita caminhos internos como destino pós-login (evita open redirect). */
export const safeRedirect = (r: unknown) =>
  typeof r === "string" && r.startsWith("/") && !r.startsWith("//") ? r : "/";
