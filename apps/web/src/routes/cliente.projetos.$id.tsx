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
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Circle, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Conversation, PortalTaskRow, Progress } from "../components/portal/parts";
import { api, unwrap } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { portalProjectQuery } from "../lib/portal";

export const Route = createFileRoute("/cliente/projetos/$id")({ component: PortalProjectPage });

function PortalProjectPage() {
  const { id } = Route.useParams();
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(portalProjectQuery(id));
  const [creating, setCreating] = useState(false);
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" });
  const comment = useMutation({
    mutationFn: (body: string) =>
      unwrap(api.portal.projects[":id"].comments.$post({ param: { id }, json: { body } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["portal", "project", id] }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  if (q.isPending) return <Skeleton className="mt-4 h-64" />;
  if (q.isError) return <p className="mt-4 text-destructive">{errorMessage(t, q.error)}</p>;
  const { project: p, milestones, tasks, comments } = q.data;
  const open = tasks.filter((x) => !x.isDone);
  const done = tasks.filter((x) => x.isDone);
  return (
    <div className="grid gap-6">
      <Link
        to="/cliente"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeft className="size-4" /> {t("portal.nav.home")}
      </Link>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
          <Badge variant="outline">{t(`projects.status.${p.status}`)}</Badge>
        </div>
        {p.publicSummary && <p className="whitespace-pre-wrap text-muted-foreground">{p.publicSummary}</p>}
        <div className="max-w-md">
          <Progress done={p.progress.done} total={p.progress.total} />
        </div>
        {p.clientDeliveryDate && (
          <p className="text-sm text-muted-foreground">
            {t("portal.project.delivery", { date: df.format(new Date(p.clientDeliveryDate)) })}
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="grid min-w-0 content-start gap-6">
          <section className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">{t("portal.project.tasks")}</h2>
              <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                <Plus /> {t("portal.project.newTask")}
              </Button>
            </div>
            {open.length ? (
              <Card className="divide-y">
                {open.map((x) => (
                  <PortalTaskRow key={x.id} task={x} />
                ))}
              </Card>
            ) : (
              <p className="text-sm text-muted-foreground">{t("portal.project.noOpenTasks")}</p>
            )}
            {done.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  {t("portal.project.doneTasks", { count: done.length })}
                </summary>
                <Card className="mt-2 divide-y">
                  {done.map((x) => (
                    <PortalTaskRow key={x.id} task={x} />
                  ))}
                </Card>
              </details>
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
          <h2 className="font-semibold">{t("portal.project.milestones")}</h2>
          {milestones.length ? (
            <Card className="p-4">
              <ol className="grid gap-3">
                {milestones.map((m) => (
                  <li key={m.id} className="flex items-start gap-2 text-sm">
                    {m.done ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="grid">
                      <span className={m.done ? "text-muted-foreground line-through" : "font-medium"}>
                        {m.title}
                      </span>
                      <span className="text-xs text-muted-foreground">{df.format(new Date(m.date))}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">{t("portal.project.noMilestones")}</p>
          )}
        </aside>
      </div>
      <NewTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        projectId={id}
        types={q.data.taskTypes}
      />
    </div>
  );
}

function NewTaskDialog({
  open,
  onClose,
  projectId,
  types,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  types: { id: string; label: string }[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("");
  const [date, setDate] = useState("");
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.portal.projects[":id"].tasks.$post({
          param: { id: projectId },
          json: {
            title: title.trim(),
            description: description.trim() || null,
            taskTypeId: type || null,
            clientDeliveryDate: date || null,
          },
        }),
      ),
    onSuccess: (r) => {
      toast.success(t("portal.project.taskCreated"));
      void qc.invalidateQueries({ queryKey: ["portal"] });
      onClose();
      setTitle("");
      setDescription("");
      setType("");
      setDate("");
      void navigate({ to: "/cliente/tarefas/$id", params: { id: r.id } });
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
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("portal.project.newTask")}</DialogTitle>
            <DialogDescription>{t("portal.project.newTaskHelp")}</DialogDescription>
          </DialogHeader>
          <Field id="pt-title" label={t("portal.fields.title")}>
            <Input
              id="pt-title"
              required
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field id="pt-desc" label={t("portal.fields.description")}>
            <textarea
              id="pt-desc"
              className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm"
              maxLength={5000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {types.length > 0 && (
              <Field id="pt-type" label={t("portal.fields.type")}>
                <Select id="pt-type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">{t("common.choose")}</option>
                  {types.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field id="pt-date" label={t("portal.fields.desiredDate")}>
              <Input id="pt-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending || !title.trim()}>
              {t("portal.project.createTask")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
