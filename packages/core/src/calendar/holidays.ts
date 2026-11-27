/**
 * Feriados nacionais (BrasilAPI). Cache GLOBAL em public_holidays (uma busca por ano, plataforma)
 * e cópia em calendar_events de cada tenant que ligou a importação (dia não útil: o "Estou nessa"
 * não conta tempo nesses dias). externalRef "BR-AAAA-MM-DD" evita duplicar.
 */
import { type AppDb, type AppTx, schema, withTenant } from "@recpm/db";
import { and, between, eq, inArray, sql } from "drizzle-orm";

const s = schema;
export type Holiday = { date: string; name: string };
export type HolidayFetch = (year: number) => Promise<Holiday[]>;

export const brasilApiHolidays =
  (f: typeof fetch = fetch): HolidayFetch =>
  async (year) => {
    const res = await f(`https://brasilapi.com.br/api/feriados/v1/${year}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`BrasilAPI respondeu ${res.status}`);
    const rows = (await res.json()) as { date: string; name: string; type?: string }[];
    return rows
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && (!r.type || r.type === "national"))
      .map((r) => ({ date: r.date, name: r.name }));
  };

/** Feriados do ano, do cache da plataforma (busca na API só na primeira vez). */
export async function nationalHolidays(platformDb: AppDb, year: number, fetchHolidays: HolidayFetch) {
  const range = between(s.publicHolidays.date, `${year}-01-01`, `${year}-12-31`);
  const cached = await platformDb
    .select({ date: s.publicHolidays.date, name: s.publicHolidays.name })
    .from(s.publicHolidays)
    .where(and(range, eq(s.publicHolidays.scope, "national")));
  if (cached.length) return cached.map((r) => ({ date: String(r.date), name: r.name }));
  const fresh = await fetchHolidays(year);
  if (fresh.length)
    await platformDb
      .insert(s.publicHolidays)
      .values(fresh.map((h) => ({ date: h.date, name: h.name, scope: "national" })))
      .onConflictDoNothing();
  return fresh;
}

/** Copia os feriados para a agenda do tenant (só os que ainda não estão lá). */
export async function copyHolidaysToTenant(tx: AppTx, tenantId: string, holidays: Holiday[]) {
  if (!holidays.length) return 0;
  const refs = holidays.map((h) => `BR-${h.date}`);
  const have = new Set(
    (
      await tx
        .select({ ref: s.calendarEvents.externalRef })
        .from(s.calendarEvents)
        .where(inArray(s.calendarEvents.externalRef, refs))
    ).map((r) => r.ref),
  );
  const missing = holidays.filter((h) => !have.has(`BR-${h.date}`));
  if (missing.length)
    await tx.insert(s.calendarEvents).values(
      missing.map((h) => ({
        tenantId,
        title: h.name,
        date: h.date,
        type: "feriado" as const,
        source: "feriado_api" as const,
        externalRef: `BR-${h.date}`,
        isDayOff: true,
      })),
    );
  return missing.length;
}

/** Remove os feriados importados (quando o tenant desliga a importação). */
export async function removeImportedHolidays(tx: AppTx) {
  await tx.delete(s.calendarEvents).where(eq(s.calendarEvents.source, "feriado_api"));
}

/**
 * Job diário do worker: para cada tenant com a importação ligada, garante o ano atual e o próximo.
 * Falha da API externa não derruba o job: tenta de novo no dia seguinte.
 */
export async function runHolidayImport(
  dbs: { platformDb: AppDb; appDb: AppDb },
  fetchHolidays: HolidayFetch,
  now = new Date(),
) {
  const tenants = await dbs.platformDb
    .select({ tenantId: s.tenantSettings.tenantId })
    .from(s.tenantSettings)
    .innerJoin(s.tenants, eq(s.tenants.id, s.tenantSettings.tenantId))
    .where(
      and(
        sql`coalesce((${s.tenantSettings.operation}->'holidayImport'->>'national')::boolean, true)`,
        sql`${s.tenants.status} <> 'suspended'`,
      ),
    );
  const y = now.getUTCFullYear();
  const byYear = new Map<number, Holiday[]>();
  for (const year of [y, y + 1]) {
    try {
      byYear.set(year, await nationalHolidays(dbs.platformDb, year, fetchHolidays));
    } catch {
      byYear.set(year, []);
    }
  }
  const all = [...byYear.values()].flat();
  let added = 0;
  for (const { tenantId } of tenants)
    added += await withTenant(dbs.appDb, { tenantId, actor: "system" }, (tx) =>
      copyHolidaysToTenant(tx, tenantId, all),
    );
  return { tenants: tenants.length, added };
}
