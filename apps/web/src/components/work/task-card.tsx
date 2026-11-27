import { Avatar, cn } from "@recpm/ui";
import { AlertTriangle, CheckSquare, Clock, Repeat, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PRIORITY_DOT, shortDeadline, type TaskItem } from "../../lib/work";

/** Card do Kanban (e da visão compacta). */
export function TaskCard({
  task,
  showProject = true,
  onOpen,
  dragging,
}: {
  task: TaskItem;
  showProject?: boolean;
  onOpen?: (id: string) => void;
  dragging?: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div
      className={cn(
        "grid gap-2 rounded-lg border bg-card p-3 text-left text-sm shadow-xs",
        dragging && "rotate-1 shadow-lg ring-2 ring-primary/40",
      )}
    >
      {showProject && task.project && (
        <p className="truncate text-xs text-muted-foreground">
          {task.project.clientCode ? <span className="font-mono">{task.project.clientCode}</span> : null}
          {task.project.clientCode ? " · " : ""}
          {task.project.name}
        </p>
      )}
      <button
        type="button"
        className="text-left font-medium leading-snug hover:underline focus-visible:underline"
        onClick={() => onOpen?.(task.id)}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span
          className={cn("mr-1.5 inline-block size-2 rounded-full align-middle", PRIORITY_DOT[task.priority])}
          title={t(`work.priority.${task.priority}`)}
        >
          <span className="sr-only">{t(`work.priority.${task.priority}`)}</span>
        </span>
        {task.title}
      </button>
      {(task.taskType || task.tags.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {task.taskType && (
            <span
              className="rounded px-1.5 py-0.5 text-[11px] font-medium"
              style={{
                background: `${task.taskType.color ?? "#64748b"}22`,
                color: task.taskType.color ?? undefined,
              }}
            >
              {task.taskType.label}
            </span>
          )}
          {task.tags.map((g) => (
            <span key={g.id} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
              {g.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {task.deadline && (
          <span
            className={cn("inline-flex items-center gap-1", task.overdue && "font-medium text-destructive")}
          >
            {task.overdue ? <AlertTriangle className="size-3.5" /> : <Clock className="size-3.5" />}
            {shortDeadline(task.deadline, task.deadlineHasTime, i18n.language)}
          </span>
        )}
        {task.checklist.total > 0 && (
          <span className="inline-flex items-center gap-1">
            <CheckSquare className="size-3.5" />
            {task.checklist.done}/{task.checklist.total}
          </span>
        )}
        {task.openAdjustments > 0 && (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <Wrench className="size-3.5" />
            {task.openAdjustments}
          </span>
        )}
        {task.recurrence && (
          <Repeat className="size-3.5" aria-label={t(`work.recurrence.${task.recurrence}`)} />
        )}
        <span className="ml-auto flex items-center -space-x-1.5">
          {task.assignee && (
            <Avatar name={task.assignee.name} src={task.assignee.image} className="size-6 ring-2 ring-card" />
          )}
          {task.participantCount > 1 && (
            <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] ring-2 ring-card">
              +{task.participantCount - 1}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
