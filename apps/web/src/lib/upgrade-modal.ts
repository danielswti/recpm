import { create } from "zustand";
import { ApiError } from "./api";
import { AuthError } from "./auth-client";

export const LIMIT_CODES = [
  "PLAN_TASK_LIMIT_REACHED",
  "PLAN_USER_LIMIT_REACHED",
  "FEATURE_NOT_IN_PLAN",
] as const;
export type LimitCode = (typeof LIMIT_CODES)[number];

/** Modal de upgrade: aberto por qualquer erro de limite do plano vindo da API (ver main.tsx). */
export const useUpgradeModal = create<{
  code: LimitCode | null;
  open: (c: LimitCode) => void;
  close: () => void;
}>((set) => ({ code: null, open: (code) => set({ code }), close: () => set({ code: null }) }));

export function limitCodeOf(e: unknown): LimitCode | null {
  const code = e instanceof ApiError || e instanceof AuthError ? e.code : null;
  return LIMIT_CODES.includes(code as LimitCode) ? (code as LimitCode) : null;
}
