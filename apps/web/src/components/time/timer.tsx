/** Botão "Estou nessa" (na tarefa) e o timer em andamento (no cabeçalho do app). */
import { Button, cn } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Pause, Play, Timer } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentTimerQuery, formatDuration, useTicking, useTimer } from "../../lib/time";

export function TimerButton({ taskId, disabled }: { taskId: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const cur = useQuery(currentTimerQuery);
  const { start, stop, pending } = useTimer();
  const mine = cur.data?.task.id === taskId;
  const elapsed = useTicking(mine ? cur.data?.businessMs : null, mine);
  if (mine)
    return (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => stop.mutate()}>
        <Pause /> {t("time.stop")}
        {elapsed != null && (
          <span className="tabular-nums text-muted-foreground">
            {formatDuration(elapsed, { seconds: true })}
          </span>
        )}
      </Button>
    );
  return (
    <Button size="sm" disabled={disabled || pending || cur.isPending} onClick={() => start.mutate(taskId)}>
      <Play /> {t("time.start")}
    </Button>
  );
}

/** Pílula no cabeçalho: tarefa atual + tempo útil, clicar abre a tarefa. */
export function CurrentTimer() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cur = useQuery(currentTimerQuery);
  const { stop, pending } = useTimer();
  const elapsed = useTicking(cur.data?.businessMs, !!cur.data);
  if (!cur.data) return null;
  const task = cur.data.task;
  return (
    <div
      className="flex min-w-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-3 pr-1 text-sm"
      role="status"
    >
      <Timer className="size-4 shrink-0 text-primary" aria-hidden />
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 text-left hover:underline"
        title={task.title}
        onClick={() => void navigate({ to: "/tarefas", search: { task: task.id } })}
      >
        <span className="hidden max-w-48 truncate sm:inline">{task.title}</span>
        <span className={cn("font-medium tabular-nums text-primary")}>
          {elapsed != null ? formatDuration(elapsed, { seconds: true }) : "…"}
        </span>
      </button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 rounded-full"
        aria-label={t("time.stopTask", { title: task.title })}
        disabled={pending}
        onClick={() => stop.mutate()}
      >
        <Pause className="size-3.5" />
      </Button>
    </div>
  );
}
