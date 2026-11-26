/** Soma meses de calendário mantendo o dia (31/01 + 1 mês = 28 ou 29/02). Em UTC. */
export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
