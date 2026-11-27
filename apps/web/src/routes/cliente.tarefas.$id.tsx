import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  MessageSquareWarning,
  Paperclip,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "../components/confirm-dialog";
import { Conversation } from "../components/portal/parts";
import { api, unwrap, unwrapVoid } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { portalTaskQuery } from "../lib/portal";

export const Route = createFileRoute("/cliente/tarefas/$id")({ component: PortalTaskPage });

function PortalTaskPage() {
  const { id } = Route.useParams();
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery(portalTaskQuery(id));
  const [changes, setChanges] = useState(false);
  const [removing, setRemoving] = useState(false);
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["portal"] });
  const comment = useMutation({
    mutationFn: (body: string) =>
      unwrap(api.portal.tasks[":id"].comments.$post({ param: { id }, json: { body } })),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const approve = useMutation({
    mutationFn: () => unwrap(api.portal.tasks[":id"].approve.$post({ param: { id } })),
    onSuccess: () => {
      toast.success(t("portal.task.approved"));
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const del = useMutation({
    mutationFn: () => unwrapVoid(api.portal.tasks[":id"].$delete({ param: { id } })),
    onSuccess: () => {
      toast.success(t("portal.task.deleted"));
      void refresh();
      if (project) void navigate({ to: "/cliente/projetos/$id", params: { id: project.id } });
      else void navigate({ to: "/cliente" });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  if (q.isPending) return <Skeleton className="mt-4 h-64" />;
  if (q.isError) return <p className="mt-4 text-destructive">{errorMessage(t, q.error)}</p>;
  const { task, attachments, comments, reasons } = q.data;
  const project = task.project;
  return (
    <div className="grid gap-6">
      {project ? (
        <Link
          to="/cliente/projetos/$id"
          params={{ id: project.id }}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="size-4" /> {project.name}
        </Link>
      ) : (
        <Link
          to="/cliente"
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="size-4" /> {t("portal.nav.home")}
        </Link>
      )}
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">{task.title}</h1>
          <Badge variant={task.awaitingClient ? "default" : "outline"}>
            {task.awaitingClient ? t("portal.task.awaitingYou") : task.statusLabel}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {[
            task.taskType,
            task.clientDeliveryDate &&
              t("portal.task.delivery", { date: df.format(new Date(task.clientDeliveryDate)) }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {task.awaitingClient && (
        <Card className="grid gap-3 border-primary/40 bg-primary/5 p-4">
          <p className="text-sm font-medium">{t("portal.task.reviewPrompt")}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={approve.isPending} onClick={() => approve.mutate()}>
              <Check /> {t("portal.task.approve")}
            </Button>
            <Button variant="outline" onClick={() => setChanges(true)}>
              <MessageSquareWarning /> {t("portal.task.requestChanges")}
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="grid min-w-0 content-start gap-6">
          <section className="grid gap-2">
            <h2 className="font-semibold">{t("portal.fields.description")}</h2>
            {task.description ? (
              <p className="whitespace-pre-wrap break-words text-sm">{task.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("portal.task.noDescription")}</p>
            )}
          </section>
          <section className="grid gap-3">
            <h2 className="font-semibold">{t("portal.conversation.title")}</h2>
            <Conversation
              comments={comments}
              pending={comment.isPending}
              onSend={(b) => comment.mutateAsync(b)}
            />
          </section>
        </div>
        <aside className="grid content-start gap-3">
          <h2 className="font-semibold">{t("portal.task.files")}</h2>
          {attachments.length ? (
            <Card className="divide-y">
              {attachments.map((a) => (
                <a
                  key={a.id}
                  href={a.fileId ? `/api/v1/portal/files/${a.fileId}/download` : (a.url ?? "#")}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50"
                >
                  <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {a.fileId ? (
                    <Download className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
                  )}
                </a>
              ))}
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">{t("portal.task.noFiles")}</p>
          )}
          {task.createdByMe && (
            <Button
              variant="ghost"
              className="justify-start text-destructive"
              onClick={() => setRemoving(true)}
            >
              <Trash2 /> {t("portal.task.delete")}
            </Button>
          )}
        </aside>
      </div>

      <ChangesDialog open={changes} onClose={() => setChanges(false)} taskId={id} reasons={reasons} />
      <ConfirmDialog
        open={removing}
        title={t("portal.task.deleteTitle")}
        description={t("portal.task.deleteText", { title: task.title })}
        confirmLabel={t("common.delete")}
        pending={del.isPending}
        onClose={() => setRemoving(false)}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}

function ChangesDialog({
  open,
  onClose,
  taskId,
  reasons,
}: {
  open: boolean;
  onClose: () => void;
  taskId: string;
  reasons: { id: string; label: string }[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.portal.tasks[":id"]["request-changes"].$post({
          param: { id: taskId },
          json: { reasonId: reason || null, description: text.trim() },
        }),
      ),
    onSuccess: () => {
      toast.success(t("portal.task.changesSent"));
      void qc.invalidateQueries({ queryKey: ["portal"] });
      setText("");
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("portal.task.requestChanges")}</DialogTitle>
            <DialogDescription>{t("portal.task.changesHelp")}</DialogDescription>
          </DialogHeader>
          {reasons.length > 1 && (
            <Field id="ch-reason" label={t("portal.task.reason")}>
              <Select id="ch-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">{t("common.choose")}</option>
                {reasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field id="ch-text" label={t("portal.task.whatToChange")}>
            <textarea
              id="ch-text"
              required
              className="min-h-28 rounded-md border bg-background px-3 py-2 text-sm"
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={send.isPending || !text.trim()}>
              {t("portal.task.sendChanges")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
