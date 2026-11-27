/** Ordem dos cards: chaves fracionárias (inserir entre dois cards = 1 UPDATE). */
import { generateKeyBetween } from "fractional-indexing";

export const rankBetween = (before: string | null | undefined, after: string | null | undefined) =>
  generateKeyBetween(before ?? null, after ?? null);
