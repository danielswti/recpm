import type { Entitlements } from "@recpm/shared";
import { cn } from "@recpm/ui";
import { useTranslation } from "react-i18next";
import { date } from "../lib/format";

/** "X de Y tarefas neste ciclo", com barra que muda de cor em 80% e 100%. */
export function UsageMeter({ e, className }: { e: Entitlements; className?: string }) {
  const { t, i18n } = useTranslation();
  const limit = e.limits.tasksPerCycle;
  const pct = e.usage.tasksPercent ?? 0;
  const nf = new Intl.NumberFormat(i18n.language);
  return (
    <div className={cn("grid gap-2", className)}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">
          {limit === null
            ? t("billing.usageUnlimited", { used: nf.format(e.usage.tasksCreated) })
            : t("billing.usage", { used: nf.format(e.usage.tasksCreated), limit: nf.format(limit) })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("billing.cycleEnds", { date: date(e.currentPeriodEnd, i18n.language) })}
        </span>
      </div>
      {limit !== null && (
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t("billing.usageLabel")}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary",
            )}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>
      )}
    </div>
  );
}
