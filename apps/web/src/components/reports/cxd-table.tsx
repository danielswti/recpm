/** Tabela do contratado × entregue de um cliente (ou de todos): categorias × números do mês. */
import { useTranslation } from "react-i18next";
import type { contractedDeliveredQuery } from "../../lib/reports";

type Data = Awaited<ReturnType<NonNullable<ReturnType<typeof contractedDeliveredQuery>["queryFn"]>>>;
type Cells = Data["all"]["cells"];
type Total = Data["all"]["total"];

export function CxdTable({
  categories,
  cells,
  total,
  print = false,
}: {
  categories: Data["categories"];
  cells: Cells;
  total: Total;
  print?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const n = (v: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(v);
  const rows = categories.filter((c) => {
    const x = cells[c.slug]!;
    return x.contracted || x.delivered || x.inProgress;
  });
  const pct = (x: Total) =>
    x.contracted ? Math.min(100, Math.round((x.delivered / x.contracted) * 100)) : null;
  return (
    <table className={`w-full text-sm ${print ? "" : "min-w-[560px]"}`}>
      <thead className="border-b text-left text-xs text-muted-foreground">
        <tr>
          <th className="px-4 py-2 font-medium">{t("reports.category")}</th>
          <th className="px-3 py-2 text-right font-medium">{t("reports.cxd.contracted")}</th>
          <th className="px-3 py-2 text-right font-medium">{t("reports.cxd.delivered")}</th>
          <th className="px-3 py-2 text-right font-medium">{t("reports.cxd.inProgress")}</th>
          <th className="px-3 py-2 text-right font-medium">{t("reports.cxd.toStart")}</th>
          <th className={`w-32 px-4 py-2 font-medium ${print ? "hidden sm:table-cell" : ""}`}>
            <span className="sr-only">{t("reports.cxd.progress")}</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="px-4 py-3 text-muted-foreground">
              {t("reports.cxd.nothing")}
            </td>
          </tr>
        )}
        {[
          ...rows.map((c) => ({
            key: c.slug,
            label: c.slug === "outros" ? t("reports.others") : c.label,
            x: cells[c.slug]!,
          })),
          { key: "__total", label: t("reports.total"), x: total },
        ].map(({ key, label, x }) => {
          const p = pct(x);
          const isTotal = key === "__total";
          return (
            <tr key={key} className={isTotal ? "font-semibold" : undefined}>
              <td className="px-4 py-2">{label}</td>
              <td className="px-3 py-2 text-right tabular-nums">{x.contracted ? n(x.contracted) : "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{x.delivered}</td>
              <td className="px-3 py-2 text-right tabular-nums">{x.inProgress}</td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${x.toStart ? "text-amber-700 dark:text-amber-400" : ""}`}
              >
                {n(x.toStart)}
              </td>
              <td className={`px-4 py-2 ${print ? "hidden sm:table-cell" : ""}`}>
                {p !== null && (
                  <span className="flex items-center gap-2" title={t("reports.cxd.pct", { pct: p })}>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted print:border">
                      <span
                        className={`block h-full rounded-full ${p >= 100 ? "bg-success" : "bg-primary"}`}
                        style={{ width: `${p}%` }}
                      />
                    </span>
                    <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{p}%</span>
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
