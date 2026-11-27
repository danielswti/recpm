/** Lista de tarefas (detalhada ou compacta), com seleção e ações em massa. */
import { Avatar, Badge, Button, Card, cn, Input, Select } from "@recpm/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckSquare, Repeat, Wrench } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { fromLocalInput, PRIORITY_DOT, shortDeadline, type TaskItem } from "../../lib/work";
import { useLookups } from "./lookups";

export function TaskList({
  tasks,
  onOpen,
  showProject = true,
  compact,
  selectable,
  canArchive,
}: {
  tasks: TaskItem[];
  onOpen: (id: string) => void;
  showProject?: boolean;
  compact?: boolean;
  selectable?: boolean;
  canArchive?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lk = useLookups({ projects: false });
  const label = (key: string) => lk.columns.find((c) => c.key === key)?.label ?? key;
  const color = (key: string) => lk.columns.find((c) => c.key === key)?.color ?? "#94a3b8";
  const [sel, setSel] = useState<Set<string>>(new Set());
  const all = tasks.length > 0 && tasks.every((x) => sel.has(x.id));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div className="grid gap-2">
      {selectable && sel.size > 0 && (
        <BulkBar ids={[...sel]} canArchive={!!canArchive} onDone={() => setSel(new Set())} />
      )}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              {selectable && (
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={t("tasks.selectAll")}
                    checked={all}
                    onChange={() => setSel(all ? new Set() : new Set(tasks.map((x) => x.id)))}
                  />
                </th>
              )}
              <th className="px-3 py-2 font-medium">{t("tasks.fields.title")}</th>
              {showProject && !compact && (
                <th className="px-3 py-2 font-medium">{t("tasks.fields.project")}</th>
              )}
              <th className="px-3 py-2 font-medium">{t("tasks.fields.status")}</th>
              {!compact && <th className="px-3 py-2 font-medium">{t("tasks.fields.assignee")}</th>}
              <th className="px-3 py-2 font-medium">{t("tasks.fields.deadline")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {tasks.map((task) => (
              <tr key={task.id} className={cn("hover:bg-accent/40", sel.has(task.id) && "bg-primary/5")}>
                {selectable && (
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={t("tasks.select", { title: task.title })}
                      checked={sel.has(task.id)}
                      onChange={() => toggle(task.id)}
                    />
                  </td>
                )}
                <td className={cn("px-3", compact ? "py-1.5" : "py-2.5")}>
                  <button
                    type="button"
                    className="flex items-center gap-2 text-left font-medium hover:underline"
                    onClick={() => onOpen(task.id)}
                  >
                    <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_DOT[task.priority])}>
                      <span className="sr-only">{t(`work.priority.${task.priority}`)}</span>
                    </span>
                    <span className={cn(task.completedAt && "text-muted-foreground line-through")}>
                      {task.title}
                    </span>
                  </button>
                  {!compact && (
                    <span className="mt-1 flex flex-wrap items-center gap-2 pl-4 text-xs text-muted-foreground">
                      {task.taskType && <span>{task.taskType.label}</span>}
                      {task.checklist.total > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <CheckSquare className="size-3" />
                          {task.checklist.done}/{task.checklist.total}
                        </span>
                      )}
                      {task.openAdjustments > 0 && (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          <Wrench className="size-3" />
                          {task.openAdjustments}
                        </span>
                      )}
                      {task.recurrence && <Repeat className="size-3" />}
                      {task.archiveRequestAt && (
                        <Badge variant="outline">{t("tasks.archiveRequestedShort")}</Badge>
                      )}
                      {task.tags.map((g) => (
                        <span key={g.id} className="rounded bg-muted px-1">
                          {g.name}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                {showProject && !compact && (
                  <td className="max-w-56 truncate px-3 py-2 text-muted-foreground">
                    {task.project ? (
                      <>
                        {task.project.clientCode && (
                          <span className="font-mono text-xs">{task.project.clientCode} · </span>
                        )}
                        {task.project.name}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                )}
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ background: color(task.statusKey) }}
                      aria-hidden
                    />
                    {label(task.statusKey)}
                  </span>
                </td>
                {!compact && (
                  <td className="px-3 py-2">
                    {task.assignee ? (
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <Avatar name={task.assignee.name} src={task.assignee.image} className="size-6" />
                        {task.assignee.name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                )}
                <td
                  className={cn(
                    "whitespace-nowrap px-3 py-2",
                    task.overdue ? "font-medium text-destructive" : "text-muted-foreground",
                  )}
                >
                  {task.deadline ? (
                    <span className="inline-flex items-center gap-1">
                      {task.overdue && <AlertTriangle className="size-3.5" />}
                      {shortDeadline(task.deadline, task.deadlineHasTime, i18n.language)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function BulkBar({ ids, canArchive, onDone }: { ids: string[]; canArchive: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const lk = useLookups({ projects: false });
  const [deadline, setDeadline] = useState("");
  const bulk = useMutation({
    mutationFn: (json: {
      action: "move" | "assign" | "deadline" | "archive" | "priority";
      statusKey?: string;
      assigneeId?: string | null;
      deadline?: string | null;
      priority?: "baixa" | "media" | "alta";
    }) => unwrap(api.tasks.bulk.$post({ json: { ids, ...json } })),
    onSuccess: (r) => {
      if (r.failed.length) toast.warning(t("tasks.bulkPartial", { ok: r.updated, failed: r.failed.length }));
      else toast.success(t("tasks.bulkDone", { count: r.updated }));
      onDone();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
  return (
    <div
      role="toolbar"
      aria-label={t("tasks.bulkActions")}
      className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-popover p-2 text-sm shadow-sm"
    >
      <span className="px-2 font-medium">{t("tasks.selected", { count: ids.length })}</span>
      <Select
        className="h-8 w-44"
        aria-label={t("tasks.bulkMove")}
        value=""
        onChange={(e) => e.target.value && bulk.mutate({ action: "move", statusKey: e.target.value })}
      >
        <option value="">{t("tasks.bulkMove")}</option>
        {lk.columns
          .filter((c) => c.key !== "ajustes")
          .map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
      </Select>
      <Select
        className="h-8 w-44"
        aria-label={t("tasks.bulkAssign")}
        value=""
        onChange={(e) =>
          e.target.value &&
          bulk.mutate({ action: "assign", assigneeId: e.target.value === "-" ? null : e.target.value })
        }
      >
        <option value="">{t("tasks.bulkAssign")}</option>
        <option value="-">{t("tasks.unassigned")}</option>
        {lk.people.map((p) => (
          <option key={p.userId} value={p.userId}>
            {p.name}
          </option>
        ))}
      </Select>
      <Select
        className="h-8 w-36"
        aria-label={t("tasks.bulkPriority")}
        value=""
        onChange={(e) =>
          e.target.value && bulk.mutate({ action: "priority", priority: e.target.value as "media" })
        }
      >
        <option value="">{t("tasks.bulkPriority")}</option>
        {(["baixa", "media", "alta"] as const).map((p) => (
          <option key={p} value={p}>
            {t(`work.priority.${p}`)}
          </option>
        ))}
      </Select>
      <span className="flex items-center gap-1">
        <Input
          type="datetime-local"
          className="h-8 w-48"
          aria-label={t("tasks.bulkDeadline")}
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!deadline}
          onClick={() => bulk.mutate({ action: "deadline", deadline: fromLocalInput(deadline) })}
        >
          {t("tasks.bulkDeadline")}
        </Button>
      </span>
      {canArchive && (
        <Button size="sm" variant="outline" onClick={() => bulk.mutate({ action: "archive" })}>
          {t("tasks.archive")}
        </Button>
      )}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onDone}>
        {t("tasks.clearSelection")}
      </Button>
    </div>
  );
}
