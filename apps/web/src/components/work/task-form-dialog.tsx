/** Nova tarefa: o essencial; o resto se completa na gaveta. Consome 1 da cota do plano. */
import { RECURRENCES } from "@recpm/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
} from "@recpm/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { fromLocalInput } from "../../lib/work";
import { useLookups } from "./lookups";

export function TaskFormDialog({
  open,
  projectId,
  defaultStatus,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId?: string;
  defaultStatus?: string;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const lk = useLookups();
  const empty = {
    title: "",
    projectId: projectId ?? "",
    taskTypeId: "",
    assigneeId: "",
    approverId: "",
    deadline: "",
    priority: "media" as "baixa" | "media" | "alta",
    statusKey: defaultStatus ?? "",
    recurrence: "" as "" | (typeof RECURRENCES)[number],
  };
  const [v, setV] = useState(empty);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reinicia ao abrir
  useEffect(() => {
    if (open) setV(empty);
  }, [open]);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.tasks.$post({
          json: {
            title: v.title,
            projectId: v.projectId || null,
            taskTypeId: v.taskTypeId || null,
            assigneeId: v.assigneeId || null,
            approverId: v.approverId || null,
            deadline: fromLocalInput(v.deadline),
            deadlineHasTime: !!v.deadline && !v.deadline.endsWith("T00:00"),
            priority: v.priority,
            statusKey: v.statusKey || undefined,
            recurrence: v.recurrence || null,
            recurrenceRule: v.recurrence ? { interval: 1 } : null,
          },
        }),
      ),
    onSuccess: (task) => {
      toast.success(t("tasks.created"));
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["entitlements"] });
      onClose();
      onCreated?.(task.id);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")} className="max-w-xl">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (v.title.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("tasks.new")}</DialogTitle>
          </DialogHeader>
          <Field id="tf-title" label={t("tasks.fields.title")}>
            <Input id="tf-title" required autoFocus maxLength={300} value={v.title} onChange={set("title")} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {!projectId && (
              <Field id="tf-project" label={t("tasks.fields.project")}>
                <Select id="tf-project" value={v.projectId} onChange={set("projectId")}>
                  <option value="">{t("tasks.standalone")}</option>
                  {lk.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.client ? `${p.client.code} · ` : ""}
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field id="tf-type" label={t("tasks.fields.type")}>
              <Select id="tf-type" value={v.taskTypeId} onChange={set("taskTypeId")}>
                <option value="">—</option>
                {lk.types.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="tf-assignee" label={t("tasks.fields.assignee")}>
              <Select id="tf-assignee" value={v.assigneeId} onChange={set("assigneeId")}>
                <option value="">—</option>
                {lk.people.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="tf-approver" label={t("tasks.fields.approver")}>
              <Select id="tf-approver" value={v.approverId} onChange={set("approverId")}>
                <option value="">—</option>
                {lk.people.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="tf-deadline" label={t("tasks.fields.deadline")}>
              <Input id="tf-deadline" type="datetime-local" value={v.deadline} onChange={set("deadline")} />
            </Field>
            <Field id="tf-priority" label={t("tasks.fields.priority")}>
              <Select id="tf-priority" value={v.priority} onChange={set("priority")}>
                {(["baixa", "media", "alta"] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`work.priority.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="tf-status" label={t("tasks.fields.status")}>
              <Select id="tf-status" value={v.statusKey} onChange={set("statusKey")}>
                <option value="">{t("tasks.defaultColumn")}</option>
                {lk.columns
                  .filter((c) => c.key !== "ajustes")
                  .map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field id="tf-rec" label={t("tasks.fields.recurrence")}>
              <Select id="tf-rec" value={v.recurrence} onChange={set("recurrence")}>
                <option value="">{t("work.recurrence.none")}</option>
                {RECURRENCES.map((r) => (
                  <option key={r} value={r}>
                    {t(`work.recurrence.${r}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(t, create.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending || !v.title.trim()}>
              {t("tasks.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
