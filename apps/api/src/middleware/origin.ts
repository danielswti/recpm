/**
 * Proteção CSRF para rotas autenticadas por cookie: em métodos que alteram estado, o request
 * precisa vir de uma origem confiável (header Origin, ou Sec-Fetch-Site same-origin).
 * O middleware `csrf` do Hono só olha formulários; este cobre também JSON.
 */
import { createMiddleware } from "hono/factory";
import { AppError } from "../lib/errors";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export const requireTrustedOrigin = (allowed: string[]) => {
  const origins = new Set(allowed.map((o) => new URL(o).origin));
  return createMiddleware(async (c, next) => {
    // Chave de API (Bearer) não usa cookie: não há CSRF a proteger.
    const bearer = /^Bearer\s+pk_live_/i.test(c.req.header("authorization") ?? "");
    if (!SAFE.has(c.req.method) && !bearer) {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      const ok = origin ? origins.has(origin) : site === "same-origin";
      if (!ok) throw new AppError(403, "CSRF", "Origem do pedido não permitida.");
    }
    await next();
  });
};
