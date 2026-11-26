import { cn } from "@recpm/ui";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Lock, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { date, daysUntil } from "../lib/format";
import { useEntitlements } from "../lib/plan-limits";

/**
 * Faixa no topo do app com o estado da assinatura, por prioridade:
 * somente leitura → pagamento em atraso → cota ≥ 80% → teste terminando.
 */
export function PlanBanner({ canManage }: { canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const { data: e } = useEntitlements();
  if (!e) return null;

  let tone: "danger" | "warning" | "info" | null = null;
  let text = "";
  if (e.readOnly) {
    tone = "danger";
    text = t("billing.banner.readOnly");
  } else if (e.status === "past_due") {
    tone = "warning";
    text = t("billing.banner.pastDue", { date: e.graceEndsAt ? date(e.graceEndsAt, i18n.language) : "" });
  } else if ((e.usage.tasksPercent ?? 0) >= 80) {
    tone = (e.usage.tasksPercent ?? 0) >= 100 ? "danger" : "warning";
    text =
      (e.usage.tasksPercent ?? 0) >= 100
        ? t("billing.banner.limitReached")
        : t("billing.banner.nearLimit", { pct: e.usage.tasksPercent });
  } else if (e.status === "trialing" && e.trialEndsAt) {
    const days = daysUntil(e.trialEndsAt);
    if (days <= 14) {
      tone = "info";
      text = t("billing.banner.trial", { count: days, plan: e.plan.name });
    }
  }
  if (!tone) return null;

  const Icon = tone === "danger" ? Lock : tone === "warning" ? AlertTriangle : Sparkles;
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm",
        tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "warning" && "border-warning/40 bg-warning/15",
        tone === "info" && "border-primary/20 bg-primary/10",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1">{text}</span>
      {canManage ? (
        <Link to="/assinatura" className="font-medium underline-offset-4 hover:underline">
          {t("billing.banner.cta")}
        </Link>
      ) : null}
    </div>
  );
}
