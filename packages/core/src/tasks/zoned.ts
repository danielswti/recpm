/** Datas no fuso do workspace sem biblioteca: Intl dá o deslocamento de cada instante. */

const parts = (d: Date, tz: string) => {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour),
    minute: Number(o.minute),
    second: Number(o.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday!),
  };
};

/** Data/hora "de parede" no fuso → instante UTC. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = parts(new Date(guess), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asUtc - guess;
  const first = new Date(guess - offset);
  // segunda passada cobre a virada de horário de verão
  const p2 = parts(first, tz);
  const off2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second) - first.getTime();
  return new Date(guess - off2);
}

/** Dia "de parede" de um instante no fuso. */
export const localDay = (d: Date, tz: string) => {
  const p = parts(d, tz);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday, hour: p.hour, minute: p.minute };
};

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Soma dias a uma data de calendário (y, m, d), devolvendo a nova data. */
export const addCalendarDays = (y: number, m: number, d: number, n: number) => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    weekday: t.getUTCDay(),
  };
};
