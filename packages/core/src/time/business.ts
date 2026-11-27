/**
 * Horas úteis (§6.3): o tempo só conta dentro da agenda da pessoa (intervalos por dia da semana,
 * no fuso dela), fora de feriados e folgas. Sem dependências: o fuso vem do Intl (ver zoned.ts).
 */
import { addCalendarDays, localDay, zonedToUtc } from "../tasks/zoned";

export type WeekSchedule = {
  /** 0 = domingo … 6 = sábado; intervalos "HH:mm". */
  days: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, { start: string; end: string }[]>>;
};

export type WorkCalendar = {
  schedule: WeekSchedule;
  tz: string;
  /** Dias sem expediente: "YYYY-MM-DD". */
  daysOff: ReadonlySet<string>;
  /** Folgas que se repetem todo ano: "MM-DD". */
  yearlyDaysOff: ReadonlySet<string>;
};

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { h: h ?? 0, m: m ?? 0 };
};

/** Limite de segurança: um timer esquecido por mais de ~1 ano não trava o servidor. */
const MAX_DAYS = 400;

/** Milissegundos úteis entre dois instantes. */
export function businessMsBetween(start: Date, end: Date, cal: WorkCalendar): number {
  if (end <= start) return 0;
  const a = start.getTime();
  const b = end.getTime();
  let cur = localDay(start, cal.tz);
  const last = localDay(end, cal.tz);
  const lastKey = dayKey(last.year, last.month, last.day);
  let total = 0;
  for (let i = 0; i < MAX_DAYS; i++) {
    const key = dayKey(cur.year, cur.month, cur.day);
    const off = cal.daysOff.has(key) || cal.yearlyDaysOff.has(key.slice(5));
    if (!off) {
      for (const iv of cal.schedule.days[cur.weekday as 0] ?? []) {
        const s = hm(iv.start);
        const e = hm(iv.end);
        const from = zonedToUtc(cur.year, cur.month, cur.day, s.h, s.m, cal.tz).getTime();
        const to = zonedToUtc(cur.year, cur.month, cur.day, e.h, e.m, cal.tz).getTime();
        const overlap = Math.min(to, b) - Math.max(from, a);
        if (overlap > 0) total += overlap;
      }
    }
    if (key === lastKey) break;
    const n = addCalendarDays(cur.year, cur.month, cur.day, 1);
    cur = { ...n, hour: 0, minute: 0 };
  }
  return total;
}

/** O instante está dentro do expediente? (para mostrar "fora do horário" no timer). */
export function isWithinBusinessHours(at: Date, cal: WorkCalendar): boolean {
  return businessMsBetween(new Date(at.getTime() - 1), new Date(at.getTime() + 1), cal) > 0;
}
