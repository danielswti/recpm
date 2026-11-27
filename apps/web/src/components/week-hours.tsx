/** Editor da semana de trabalho: até 4 intervalos por dia (perfil do membro e padrão do workspace). */
import { Button, Input } from "@recpm/ui";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export type Interval = { start: string; end: string };
export type Week = Record<string, Interval[]>;
export const DAYS = ["1", "2", "3", "4", "5", "6", "0"] as const;
export const DEFAULT_WEEK: Week = Object.fromEntries(
  DAYS.map((d) => [
    d,
    d === "0" || d === "6"
      ? []
      : [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "18:00" },
        ],
  ]),
);

export function WeekHoursEditor({ value: week, onChange }: { value: Week; onChange: (w: Week) => void }) {
  const { t } = useTranslation();
  const setDay = (d: string, list: Interval[]) => onChange({ ...week, [d]: list });
  return (
    <div className="grid gap-2">
      {DAYS.map((d) => {
        const list = week[d] ?? [];
        return (
          <div key={d} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-16 font-medium">{t(`members.hours.days.${d}`)}</span>
            {list.length === 0 && <span className="text-muted-foreground">{t("members.hours.off")}</span>}
            {list.map((iv, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: intervalos não têm id; a posição é a identidade
              <span key={`${d}-${i}`} className="flex items-center gap-1">
                <Input
                  type="time"
                  aria-label={t("members.hours.start", { day: t(`members.hours.days.${d}`) })}
                  className="h-8 w-[104px]"
                  value={iv.start}
                  onChange={(e) =>
                    setDay(
                      d,
                      list.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)),
                    )
                  }
                />
                –
                <Input
                  type="time"
                  aria-label={t("members.hours.end", { day: t(`members.hours.days.${d}`) })}
                  className="h-8 w-[104px]"
                  value={iv.end}
                  onChange={(e) =>
                    setDay(
                      d,
                      list.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("members.hours.remove")}
                  onClick={() =>
                    setDay(
                      d,
                      list.filter((_, j) => j !== i),
                    )
                  }
                >
                  <X />
                </Button>
              </span>
            ))}
            {list.length < 4 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => setDay(d, [...list, { start: "09:00", end: "18:00" }])}
              >
                <Plus /> {t("members.hours.add")}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
