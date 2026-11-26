import type { AppType } from "@recpm/api/app-type";
import { hc } from "hono/client";

/** Cliente RPC tipado da API (/api/v1). Cookies de sessão vão junto (mesma origem). */
export const api = hc<AppType>("/", { init: { credentials: "include" } }).api.v1;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type RpcResponse = { ok: boolean; status: number; json(): Promise<unknown> };
type Success<R extends RpcResponse> = Exclude<Awaited<ReturnType<R["json"]>>, { error: unknown }>;

/** Desembrulha a resposta do cliente RPC: devolve o JSON de sucesso (tipado) ou lança ApiError. */
export async function unwrap<R extends RpcResponse>(res: Promise<R>): Promise<Success<R>> {
  const r = await res;
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new ApiError(r.status, body.error?.code ?? "HTTP_ERROR", body.error?.message ?? "Erro");
  }
  return (await r.json()) as Success<R>;
}
