/**
 * Próxima geração de uma tarefa recorrente (§6.3). Calculada no fuso do workspace:
 * - diaria: a cada `interval` dias, no horário `at`;
 * - semanal: nos dias `weekdays` (padrão: o dia da semana de hoje), a cada `interval` semanas;
 * - mensal: no dia `dayOfMonth` (meses curtos usam o último dia), a cada `interval` meses.
 * `until` (data, inclusive) encerra a série: devolve null.
 */
import { addCalendarDays, daysInMonth, localDay, zonedToUtc } from "./zoned";

export type Recurrence = "diaria" | "semanal" | "mensal";
export type Rule = {
  interval?: number;
  weekdays?: number[];
  dayOfMonth?: number;
  at?: string;
  until?: string;
  deadlineOffsetDays?: number;
};

export function nextOccurrence(
  kind: Recurrence,
  rule: Rule,
  after: Date,
  tz: string,
  anchor?: Date,
): Date | null {
  const interval = Math.max(1, rule.interval ?? 1);
  const [h, min] = (rule.at ?? "08:00").split(":").map(Number) as [number, number];
  const start = localDay(after, tz);
  const base = localDay(anchor ?? after, tz);
  const until = rule.until ? rule.until : null;
  const at = (y: number, m: number, d: number) => zonedToUtc(y, m, d, h, min, tz);
  const fmt = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const done = (y: number, m: number, d: number) => until !== null && fmt(y, m, d) > until;

  // Procura dia a dia (no máximo ~2 anos) o primeiro candidato estritamente depois de `after`.
  for (let i = 0; i <= 800; i++) {
    const c = addCalendarDays(start.year, start.month, start.day, i);
    if (done(c.year, c.month, c.day)) return null;
    const when = at(c.year, c.month, c.day);
    if (when <= after) continue;
    const daysFromBase = Math.round(
      (Date.UTC(c.year, c.month - 1, c.day) - Date.UTC(base.year, base.month - 1, base.day)) / 86_400_000,
    );
    if (kind === "diaria") {
      if (daysFromBase % interval === 0) return when;
    } else if (kind === "semanal") {
      const days = rule.weekdays?.length ? rule.weekdays : [base.weekday];
      const week = Math.floor((daysFromBase + base.weekday) / 7);
      if (days.includes(c.weekday) && week % interval === 0) return when;
    } else {
      const months = (c.year - base.year) * 12 + (c.month - base.month);
      const want = Math.min(rule.dayOfMonth ?? base.day, daysInMonth(c.year, c.month));
      if (c.day === want && months % interval === 0) return when;
    }
  }
  return null;
}
