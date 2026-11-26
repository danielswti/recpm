import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Cliente do Better Auth (mesma origem, via proxy /api em dev e Caddy em produção).
 * Organizações do Better Auth = workspaces (tenants) do Rec PM.
 */
export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost:5173" : window.location.origin,
  basePath: "/api/auth",
  plugins: [organizationClient(), twoFactorClient()],
});

type BaError = { code?: string; message?: string; status?: number } | null | undefined;

/** Converte o retorno {data, error} do Better Auth em exceção (para usar com TanStack Query). */
export async function ba<T>(p: Promise<{ data: T; error: BaError } | { data: null; error: BaError }>) {
  const { data, error } = await p;
  if (error) throw new AuthError(error.code ?? "AUTH_ERROR", error.message ?? "", error.status ?? 400);
  return data as NonNullable<T>;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
