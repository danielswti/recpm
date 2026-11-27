import { plainToRichText, type RichTextDoc } from "@recpm/shared";
import {
  Avatar,
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Copy,
  Eye,
  EyeOff,
  FileUp,
  Folder,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog, textareaClass } from "../../components/confirm-dialog";
import { ProjectFormDialog } from "../../components/work/project-form-dialog";
import { isEmptyDoc, RichTextInput, RichTextView } from "../../components/work/rich-text";
import { TaskBoard } from "../../components/work/task-board";
import { TaskDrawer } from "../../components/work/task-drawer";
import { TaskFormDialog } from "../../components/work/task-form-dialog";
import { TaskList } from "../../components/work/task-list";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { taskTypesQuery } from "../../lib/catalogs";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/format";
import { workspaceQuery } from "../../lib/queries";
import {
  calendarDate,
  downloadUrl,
  PROJECT_STATUS_TONE,
  type Project,
  projectColumnsQuery,
  projectCommentsQuery,
  projectFilesQuery,
  projectQuery,
  tasksQuery,
  uploadFile,
} from "../../lib/work";

const TABS = ["tarefas", "visao-geral", "comentarios", "fases", "marcos", "arquivos"] as const;

export const Route = createFileRoute("/_app/projetos/$id")({
  validateSearch: z.object({
    tab: z.enum(TABS).optional(),
    view: z.enum(["board", "list"]).optional(),
    task: z.string().optional(),
  }),
  component: ProjectPage,
});

function ProjectPage() {
  const { t, i18n } = useTranslation();
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/projetos/$id" });
  const qc = useQueryClient();
  const q = useQuery(projectQuery(id));
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tab = search.tab ?? "tarefas";

  const openChat = useMutation({
    mutationFn: () => unwrap(api.chat.projects[":id"].$post({ param: { id } })),
    onSuccess: (c) => void navigate({ to: "/chat", search: { c: c.id } }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const action = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  if (q.isPending)
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-64" />
      </div>
    );
  if (q.isError)
    return (
      <EmptyState
        title={t("projects.notFound")}
        description={errorMessage(t, q.error)}
        action={
          <Button asChild variant="outline">
            <Link to="/projetos">{t("projects.backToList")}</Link>
          </Button>
        }
      />
    );
  const p = q.data;
  const pct = p.tasks.total ? Math.round((p.tasks.done / p.tasks.total) * 100) : 0;

  return (
    <>
      <div className="mb-6 grid gap-3">
        <Link
          to="/projetos"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="size-4" /> {t("projects.title")}
        </Link>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">
              {p.client ? (
                <Link to="/clientes/$id" params={{ id: p.client.id }} className="hover:underline">
                  <span className="font-mono">{p.client.code}</span> · {p.client.name}
                </Link>
              ) : (
                t("projects.internal")
              )}
              {p.type ? ` · ${p.type.label}` : ""}
              {` · ${t(`projects.modality.${p.modality}`)}`}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
          </div>
          <Badge variant={PROJECT_STATUS_TONE[p.status]} className="mt-1">
            {t(`projects.status.${p.status}`)}
          </Badge>
          {p.archived && (
            <Badge variant="secondary" className="mt-1">
              {t("projects.archived")}
            </Badge>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={openChat.isPending}
              onClick={() => openChat.mutate()}
              title={t("chat.projectChat")}
            >
              <MessageCircle /> <span className="max-sm:sr-only">{t("chat.projectChat")}</span>
            </Button>
            {p.canManage && (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil /> {t("common.edit")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" aria-label={t("common.more")}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setDuplicating(true)}>
                      <Copy /> {t("projects.duplicate")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        action.mutate(() =>
                          unwrapVoid(
                            api.projects[":id"].archive.$post({
                              param: { id },
                              json: { archived: !p.archived },
                            }),
                          ),
                        )
                      }
                    >
                      <Archive /> {p.archived ? t("projects.unarchive") : t("projects.archive")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onSelect={() => setConfirmDelete(true)}>
                      <Trash2 /> {t("common.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <span className="block h-full bg-primary" style={{ width: `${pct}%` }} />
            </span>
            {t("projects.taskProgress", { done: p.tasks.done, total: p.tasks.total })}
          </span>
          {p.tasks.overdue > 0 && (
            <span className="font-medium text-destructive">
              {t("projects.overdueCount", { count: p.tasks.overdue })}
            </span>
          )}
          {p.startDate && (
            <span>{t("projects.startsOn", { date: calendarDate(p.startDate, i18n.language) })}</span>
          )}
          {p.deliveryDeadline && (
            <span>{t("projects.dueOn", { date: calendarDate(p.deliveryDeadline, i18n.language) })}</span>
          )}
          {p.manager && (
            <span className="flex items-center gap-1.5">
              <Avatar name={p.manager.name} src={p.manager.image} className="size-5" />
              {p.manager.name}
            </span>
          )}
        </div>
      </div>

      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b">
        {TABS.map((k) => (
          <Link
            key={k}
            role="tab"
            aria-selected={tab === k}
            to="/projetos/$id"
            params={{ id }}
            search={{ tab: k === "tarefas" ? undefined : k, view: search.view }}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 pb-2 text-sm",
              tab === k
                ? "border-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`projects.tabs.${k}`)}
          </Link>
        ))}
      </div>

      {tab === "tarefas" && <TasksTab project={p} view={search.view ?? "board"} />}
      {tab === "visao-geral" && <OverviewTab project={p} />}
      {tab === "comentarios" && <CommentsTab projectId={id} />}
      {tab === "fases" && <PhasesTab project={p} />}
      {tab === "marcos" && <MilestonesTab project={p} />}
      {tab === "arquivos" && <FilesTab projectId={id} />}

      <TaskDrawer
        taskId={search.task ?? null}
        onClose={() => void navigate({ search: (s) => ({ ...s, task: undefined }) })}
      />
      <ProjectFormDialog open={editing} project={p} onClose={() => setEditing(false)} />
      <DuplicateDialog open={duplicating} project={p} onClose={() => setDuplicating(false)} />
      <ConfirmDialog
        open={confirmDelete}
        title={t("projects.deleteTitle")}
        description={t("projects.deleteText")}
        confirmLabel={t("common.delete")}
        pending={action.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          action.mutate(() => unwrapVoid(api.projects[":id"].$delete({ param: { id } })), {
            onSuccess: () => void navigate({ to: "/projetos" }),
          })
        }
      />
    </>
  );
}

function TasksTab({ project, view }: { project: Project; view: "board" | "list" }) {
  const { t } = useTranslation();
  const navigate = useNavigate({ from: "/projetos/$id" });
  const [creating, setCreating] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const tasks = useQuery(
    tasksQuery({ projectId: project.id, sort: view === "board" ? "board" : "deadline" }),
  );
  const columns = useQuery(projectColumnsQuery(project.id));
  const open = (task: string) => void navigate({ search: (s) => ({ ...s, task }) });
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância */}
        <div className="flex rounded-md border p-0.5" role="group" aria-label={t("tasks.view")}>
          {(["board", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={cn(
                "rounded px-2.5 py-1 text-sm",
                view === v ? "bg-accent font-medium" : "text-muted-foreground",
              )}
              onClick={() =>
                void navigate({ search: (s) => ({ ...s, view: v === "board" ? undefined : v }) })
              }
            >
              {t(`tasks.views.${v === "board" ? "kanban" : "list"}`)}
            </button>
          ))}
        </div>
        {project.canManage && view === "board" && (
          <Button variant="ghost" size="sm" onClick={() => setConfiguring(true)}>
            <Settings2 /> {t("projects.columns")}
          </Button>
        )}
        <Button className="ml-auto" onClick={() => setCreating(true)}>
          <Plus /> {t("tasks.new")}
        </Button>
      </div>
      {tasks.isPending || columns.isPending ? (
        <Skeleton className="h-64" />
      ) : tasks.isError ? (
        <p className="text-destructive">{errorMessage(t, tasks.error)}</p>
      ) : view === "board" ? (
        <TaskBoard
          columns={columns.data?.data ?? []}
          tasks={tasks.data.data}
          showProject={false}
          onOpen={open}
        />
      ) : (
        <TaskList tasks={tasks.data.data} onOpen={open} showProject={false} />
      )}
      <TaskFormDialog
        open={creating}
        projectId={project.id}
        onClose={() => setCreating(false)}
        onCreated={open}
      />
      {configuring && columns.data && (
        <ColumnsDialog
          projectId={project.id}
          columns={columns.data.data}
          onClose={() => setConfiguring(false)}
        />
      )}
    </div>
  );
}

function ColumnsDialog({
  projectId,
  columns,
  onClose,
}: {
  projectId: string;
  columns: { key: string; label: string; labelOverride: string | null; visible: boolean }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [rows, setRows] = useState(columns.map((c) => ({ ...c, labelOverride: c.labelOverride ?? "" })));
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.projects[":id"].columns.$put({
          param: { id: projectId },
          json: {
            columns: rows.map((r) => ({
              key: r.key,
              visible: r.visible,
              labelOverride: r.labelOverride || null,
            })),
          },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: projectColumnsQuery(projectId).queryKey });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t("projects.columnsTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("projects.columnsHelp")}</p>
        <ul className="grid gap-2">
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center gap-2">
              <button
                type="button"
                aria-label={r.visible ? t("projects.hideColumn") : t("projects.showColumn")}
                aria-pressed={r.visible}
                onClick={() => setRows((s) => s.map((x, j) => (j === i ? { ...x, visible: !x.visible } : x)))}
              >
                {r.visible ? <Eye className="size-4" /> : <EyeOff className="size-4 text-muted-foreground" />}
              </button>
              <Input
                className="h-8"
                aria-label={t("projects.columnLabel", { name: columns[i]!.label })}
                placeholder={columns[i]!.labelOverride ? "" : columns[i]!.label}
                value={r.labelOverride}
                onChange={(e) =>
                  setRows((s) => s.map((x, j) => (j === i ? { ...x, labelOverride: e.target.value } : x)))
                }
              />
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OverviewTab({ project: p }: { project: Project }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const ws = useQuery(workspaceQuery);
  const types = useQuery(taskTypesQuery);
  const [editingDesc, setEditingDesc] = useState(false);
  const [doc, setDoc] = useState<RichTextDoc | null>(null);
  const [items, setItems] = useState<
    null | { taskTypeId: string; quantityPerPeriod: number; formats: string }[]
  >(null);
  const save = useMutation({
    mutationFn: (json: Record<string, unknown>) =>
      unwrap(api.projects[":id"].$patch({ param: { id: p.id }, json: json as never })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const currency = (ws.data as { currency?: string } | undefined)?.currency ?? "BRL";
  const dates: [string, string | null][] = [
    ["startDate", p.startDate],
    ["firstDeliveryDate", p.firstDeliveryDate],
    ["feedbackDeadline", p.feedbackDeadline],
    ["deliveryDeadline", p.deliveryDeadline],
    ["clientDeliveryDate", p.clientDeliveryDate],
    ["supportStart", p.supportStart],
    ["supportEnd", p.supportEnd],
    ["contractEnd", p.contractEnd],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="grid content-start gap-4">
        <Card className="grid gap-3 p-4">
          <div className="flex items-center">
            <h2 className="font-semibold">{t("projects.fields.description")}</h2>
            {p.canManage && !editingDesc && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  setDoc(p.description as RichTextDoc | null);
                  setEditingDesc(true);
                }}
              >
                <Pencil /> {t("common.edit")}
              </Button>
            )}
          </div>
          {editingDesc ? (
            <div className="grid gap-2">
              <RichTextInput
                value={doc}
                onChange={setDoc}
                label={t("projects.fields.description")}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    save.mutate(
                      { description: isEmptyDoc(doc) ? null : doc },
                      { onSuccess: () => setEditingDesc(false) },
                    )
                  }
                >
                  {t("common.save")}
                </Button>
              </div>
            </div>
          ) : isEmptyDoc(p.description as RichTextDoc | null) ? (
            <p className="text-sm text-muted-foreground">{t("projects.noDescription")}</p>
          ) : (
            <RichTextView doc={p.description} />
          )}
        </Card>

        <Card className="grid gap-3 p-4">
          <div className="flex items-center">
            <div>
              <h2 className="font-semibold">{t("projects.contract")}</h2>
              <p className="text-xs text-muted-foreground">{t("projects.contractHelp")}</p>
            </div>
            {p.canManage && !items && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() =>
                  setItems(
                    p.contractItems.map((c) => ({
                      taskTypeId: c.taskTypeId,
                      quantityPerPeriod: c.quantityPerPeriod,
                      formats: c.formats.join(", "),
                    })),
                  )
                }
              >
                <Pencil /> {t("common.edit")}
              </Button>
            )}
          </div>
          {items ? (
            <div className="grid gap-2">
              {items.map((it, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: linhas editáveis sem id
                <div key={i} className="grid grid-cols-[1fr_5rem_1fr_auto] gap-2">
                  <Select
                    aria-label={t("projects.contractType")}
                    className="h-8"
                    value={it.taskTypeId}
                    onChange={(e) =>
                      setItems((s) => s!.map((x, j) => (j === i ? { ...x, taskTypeId: e.target.value } : x)))
                    }
                  >
                    <option value="">{t("common.choose")}</option>
                    {types.data?.data
                      .filter((x) => x.active && x.sellable)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                  </Select>
                  <Input
                    aria-label={t("projects.contractQty")}
                    className="h-8"
                    type="number"
                    min={1}
                    value={it.quantityPerPeriod}
                    onChange={(e) =>
                      setItems((s) =>
                        s!.map((x, j) => (j === i ? { ...x, quantityPerPeriod: Number(e.target.value) } : x)),
                      )
                    }
                  />
                  <Input
                    aria-label={t("projects.contractFormats")}
                    className="h-8"
                    placeholder={t("projects.contractFormatsPh")}
                    value={it.formats}
                    onChange={(e) =>
                      setItems((s) => s!.map((x, j) => (j === i ? { ...x, formats: e.target.value } : x)))
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("common.remove")}
                    onClick={() => setItems((s) => s!.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setItems((s) => [...s!, { taskTypeId: "", quantityPerPeriod: 1, formats: "" }])
                  }
                >
                  <Plus /> {t("projects.addContractItem")}
                </Button>
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setItems(null)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={items.some((x) => !x.taskTypeId || x.quantityPerPeriod < 1)}
                    onClick={() =>
                      save.mutate(
                        {
                          contractItems: items.map((x) => ({
                            taskTypeId: x.taskTypeId,
                            quantityPerPeriod: x.quantityPerPeriod,
                            formats: x.formats
                              .split(",")
                              .map((f) => f.trim())
                              .filter(Boolean),
                          })),
                        },
                        { onSuccess: () => setItems(null) },
                      )
                    }
                  >
                    {t("common.save")}
                  </Button>
                </span>
              </div>
            </div>
          ) : p.contractItems.length ? (
            <ul className="grid gap-2">
              {p.contractItems.map((c) => {
                const pct = Math.min(100, Math.round((c.delivered / c.quantityPerPeriod) * 100));
                return (
                  <li key={c.id} className="grid gap-1 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.taskTypeLabel}</span>
                      {c.formats.length > 0 && (
                        <span className="text-xs text-muted-foreground">{c.formats.join(", ")}</span>
                      )}
                      <span className="ml-auto tabular-nums">
                        {c.delivered}/{c.quantityPerPeriod}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div
                        className={cn("h-full", pct >= 100 ? "bg-success" : "bg-primary")}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("projects.noContract")}</p>
          )}
        </Card>
      </div>

      <div className="grid content-start gap-4">
        <Card className="grid gap-2 p-4 text-sm">
          <h2 className="font-semibold">{t("projects.dates")}</h2>
          <dl className="grid grid-cols-2 gap-y-1.5">
            {dates
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{t(`projects.fields.${k}`)}</dt>
                  <dd className="text-right">{calendarDate(v, i18n.language)}</dd>
                </div>
              ))}
          </dl>
          {!dates.some(([, v]) => v) && <p className="text-muted-foreground">—</p>}
          {p.valueCents != null && (
            <p className="mt-2 flex justify-between border-t pt-2">
              <span className="text-muted-foreground">{t("projects.fields.value")}</span>
              <span className="font-medium">{money(p.valueCents, currency, i18n.language)}</span>
            </p>
          )}
          {p.recurringValueCents != null && (
            <p className="flex justify-between">
              <span className="text-muted-foreground">{t("projects.fields.recurringValue")}</span>
              <span className="font-medium">{money(p.recurringValueCents, currency, i18n.language)}</span>
            </p>
          )}
        </Card>
        <Card className="grid gap-2 p-4 text-sm">
          <h2 className="font-semibold">{t("projects.team")}</h2>
          {!p.members.length && <p className="text-muted-foreground">{t("projects.noTeam")}</p>}
          <ul className="grid gap-2">
            {p.members.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <Avatar name={m.name} src={m.image} className="size-7" />
                <span className="flex-1">{m.name}</span>
                {m.id === p.manager?.id ? (
                  <Badge variant="secondary">{t("projects.fields.manager")}</Badge>
                ) : m.roleName ? (
                  <span className="text-xs text-muted-foreground">{m.roleName}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function CommentsTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(projectCommentsQuery(projectId));
  const [text, setText] = useState("");
  const [visible, setVisible] = useState(false);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectCommentsQuery(projectId).queryKey }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const when = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  return (
    <div className="grid max-w-3xl gap-4">
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          run.mutate(
            () =>
              unwrap(
                api.projects[":id"].comments.$post({
                  param: { id: projectId },
                  json: { body: plainToRichText(text.trim()), visibleToClient: visible },
                }),
              ),
            {
              onSuccess: () => {
                setText("");
                setVisible(false);
              },
            },
          );
        }}
      >
        <textarea
          aria-label={t("projects.writeComment")}
          placeholder={t("projects.writeComment")}
          className={textareaClass}
          maxLength={5000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
            {t("projects.visibleToClient")}
          </label>
          <Button type="submit" size="sm" className="ml-auto" disabled={!text.trim() || run.isPending}>
            {t("projects.comment")}
          </Button>
        </div>
      </form>
      {q.data?.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("projects.noComments")}</p>
      )}
      <ul className="grid gap-3">
        {q.data?.data.map((c) => (
          <li key={c.id} className="flex gap-3 rounded-lg border p-3">
            <Avatar name={c.author?.name ?? "?"} src={c.author?.image} className="size-8" />
            <div className="grid flex-1 gap-1">
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{c.author?.name ?? "—"}</span>
                {when(c.createdAt)}
                {c.editedAt && ` · ${t("projects.edited")}`}
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
                    c.visibleToClient ? "bg-primary/10 text-primary" : "bg-muted",
                  )}
                  disabled={!c.mine}
                  aria-label={c.visibleToClient ? t("projects.hideFromClient") : t("projects.showToClient")}
                  onClick={() =>
                    run.mutate(() =>
                      unwrapVoid(
                        api.projects[":id"].comments[":subId"].$patch({
                          param: { id: projectId, subId: c.id },
                          json: { visibleToClient: !c.visibleToClient },
                        }),
                      ),
                    )
                  }
                >
                  {c.visibleToClient ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                  {c.visibleToClient ? t("projects.clientSees") : t("projects.internalOnly")}
                </button>
                {c.mine && (
                  <button
                    type="button"
                    className="ml-auto text-muted-foreground hover:text-destructive"
                    aria-label={t("common.delete")}
                    onClick={() =>
                      run.mutate(() =>
                        unwrapVoid(
                          api.projects[":id"].comments[":subId"].$delete({
                            param: { id: projectId, subId: c.id },
                          }),
                        ),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </p>
              <RichTextView doc={c.body} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PhasesTab({ project: p }: { project: Project }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectQuery(p.id).queryKey }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <div className="grid max-w-3xl gap-3">
      {p.phases.length === 0 && <p className="text-sm text-muted-foreground">{t("projects.noPhases")}</p>}
      <ul className="grid gap-2">
        {p.phases.map((ph) => {
          const pct = ph.total ? Math.round((ph.done / ph.total) * 100) : 0;
          return (
            <li key={ph.id} className="grid gap-2 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!p.canManage}
                  aria-label={ph.completedAt ? t("projects.reopenPhase") : t("projects.completePhase")}
                  onClick={() =>
                    run.mutate(() =>
                      unwrapVoid(
                        api.projects[":id"].phases[":subId"].$patch({
                          param: { id: p.id, subId: ph.id },
                          json: { completed: !ph.completedAt },
                        }),
                      ),
                    )
                  }
                >
                  {ph.completedAt ? (
                    <CheckCircle2 className="size-5 text-success" />
                  ) : (
                    <Circle className="size-5 text-muted-foreground" />
                  )}
                </button>
                <span className={cn("font-medium", ph.completedAt && "text-muted-foreground line-through")}>
                  {ph.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[ph.startDate, ph.endDate]
                    .filter(Boolean)
                    .map((d) => calendarDate(d, i18n.language))
                    .join(" → ")}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {t("projects.taskProgress", { done: ph.done, total: ph.total })}
                </span>
                {p.canManage && (
                  <button
                    type="button"
                    aria-label={t("common.delete")}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      run.mutate(() =>
                        unwrapVoid(
                          api.projects[":id"].phases[":subId"].$delete({ param: { id: p.id, subId: ph.id } }),
                        ),
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      {p.canManage && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            run.mutate(
              () =>
                unwrap(
                  api.projects[":id"].phases.$post({ param: { id: p.id }, json: { name: name.trim() } }),
                ),
              { onSuccess: () => setName("") },
            );
          }}
        >
          <Input
            placeholder={t("projects.newPhase")}
            aria-label={t("projects.newPhase")}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" variant="outline">
            <Plus /> {t("common.add")}
          </Button>
        </form>
      )}
    </div>
  );
}

function MilestonesTab({ project: p }: { project: Project }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectQuery(p.id).queryKey }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <div className="grid max-w-3xl gap-4">
      {p.milestones.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("projects.noMilestones")}</p>
      ) : (
        <ol className="relative grid gap-3 border-l pl-5">
          {p.milestones.map((m) => (
            <li key={m.id} className="relative flex items-center gap-2 text-sm">
              <span
                className={cn(
                  "absolute -left-[1.6rem] size-3 rounded-full border-2 border-background",
                  m.completed ? "bg-success" : "bg-muted-foreground/40",
                )}
                aria-hidden
              />
              <span className="w-24 shrink-0 tabular-nums text-muted-foreground">
                {calendarDate(m.date, i18n.language)}
              </span>
              <span className={cn("font-medium", m.completed && "text-muted-foreground")}>
                {m.kind === "custom" ? m.title : t(`projects.milestones.${m.kind}`)}
              </span>
              {m.kind !== "custom" && <Badge variant="secondary">{t("projects.fromDates")}</Badge>}
              {m.kind === "custom" && p.canManage && (
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    aria-label={m.completed ? t("projects.reopenMilestone") : t("projects.completeMilestone")}
                    onClick={() =>
                      run.mutate(() =>
                        unwrapVoid(
                          api.projects[":id"].milestones[":subId"].$patch({
                            param: { id: p.id, subId: m.id },
                            json: { completed: !m.completed },
                          }),
                        ),
                      )
                    }
                  >
                    {m.completed ? (
                      <CheckCircle2 className="size-4 text-success" />
                    ) : (
                      <Circle className="size-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={t("common.delete")}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      run.mutate(() =>
                        unwrapVoid(
                          api.projects[":id"].milestones[":subId"].$delete({
                            param: { id: p.id, subId: m.id },
                          }),
                        ),
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {p.canManage && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !date) return;
            run.mutate(
              () =>
                unwrap(
                  api.projects[":id"].milestones.$post({
                    param: { id: p.id },
                    json: { title: title.trim(), date },
                  }),
                ),
              {
                onSuccess: () => {
                  setTitle("");
                  setDate("");
                },
              },
            );
          }}
        >
          <Input
            className="flex-1"
            placeholder={t("projects.newMilestone")}
            aria-label={t("projects.newMilestone")}
            value={title}
            maxLength={160}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Input
            type="date"
            className="w-44"
            aria-label={t("projects.milestoneDate")}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Button type="submit" variant="outline">
            <Plus /> {t("common.add")}
          </Button>
        </form>
      )}
    </div>
  );
}

function FilesTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(projectFilesQuery(projectId));
  const [folder, setFolder] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; name: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectFilesQuery(projectId).queryKey }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const folders = q.data?.folders.filter((f) => f.parentId === folder) ?? [];
  const files = q.data?.attachments.filter((a) => a.folderId === folder) ?? [];
  const current = q.data?.folders.find((f) => f.id === folder);
  const size = (n: number) =>
    n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

  return (
    <div className="grid max-w-4xl gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label={t("files.path")} className="flex items-center gap-1 text-sm">
          <button type="button" className="hover:underline" onClick={() => setFolder(null)}>
            {t("files.root")}
          </button>
          {current && (
            <>
              <span className="text-muted-foreground">/</span>
              <span className="font-medium">{current.name}</span>
            </>
          )}
        </nav>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setNewFolder("")}>
            <Folder /> {t("files.newFolder")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLink({ url: "", name: "" })}>
            <Link2 /> {t("files.addLink")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={run.isPending}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp /> {t("files.upload")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f)
                run.mutate(async () => {
                  const fileId = await uploadFile(f);
                  await unwrap(
                    api.projects[":id"].attachments.$post({
                      param: { id: projectId },
                      json: { fileId, folderId: folder },
                    }),
                  );
                });
            }}
          />
        </span>
      </div>
      {newFolder !== null && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newFolder.trim())
              run.mutate(
                () =>
                  unwrap(
                    api.projects[":id"].folders.$post({
                      param: { id: projectId },
                      json: { name: newFolder.trim(), parentId: folder },
                    }),
                  ),
                { onSuccess: () => setNewFolder(null) },
              );
          }}
        >
          <Input
            autoFocus
            aria-label={t("files.folderName")}
            placeholder={t("files.folderName")}
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
          />
          <Button type="submit">{t("common.add")}</Button>
          <Button type="button" variant="ghost" onClick={() => setNewFolder(null)}>
            {t("common.cancel")}
          </Button>
        </form>
      )}
      {link && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate(
              () =>
                unwrap(
                  api.projects[":id"].attachments.$post({
                    param: { id: projectId },
                    json: { url: link.url, name: link.name || undefined, folderId: folder },
                  }),
                ),
              { onSuccess: () => setLink(null) },
            );
          }}
        >
          <Input
            autoFocus
            required
            type="url"
            className="flex-1"
            placeholder="https://"
            aria-label={t("files.linkUrl")}
            value={link.url}
            onChange={(e) => setLink({ ...link, url: e.target.value })}
          />
          <Input
            className="w-56"
            placeholder={t("files.linkName")}
            aria-label={t("files.linkName")}
            value={link.name}
            onChange={(e) => setLink({ ...link, name: e.target.value })}
          />
          <Button type="submit">{t("common.add")}</Button>
          <Button type="button" variant="ghost" onClick={() => setLink(null)}>
            {t("common.cancel")}
          </Button>
        </form>
      )}
      {q.isPending ? (
        <Skeleton className="h-32" />
      ) : !folders.length && !files.length ? (
        <EmptyState
          icon={<Folder className="size-6" />}
          title={t("files.none")}
          description={t("files.noneText")}
        />
      ) : (
        <Card className="divide-y">
          {folders.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <Folder className="size-4 text-primary" />
              <button type="button" className="font-medium hover:underline" onClick={() => setFolder(f.id)}>
                {f.name}
              </button>
              {f.visibleToClient && <Badge variant="outline">{t("projects.clientSees")}</Badge>}
              <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-destructive"
                aria-label={t("files.removeFolder", { name: f.name })}
                onClick={() =>
                  run.mutate(() =>
                    unwrapVoid(
                      api.projects[":id"].folders[":subId"].$delete({
                        param: { id: projectId, subId: f.id },
                      }),
                    ),
                  )
                }
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          {files.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              {a.url ? (
                <Link2 className="size-4 text-muted-foreground" />
              ) : (
                <FileUp className="size-4 text-muted-foreground" />
              )}
              <a
                className="truncate hover:underline"
                href={a.url ?? (a.file ? downloadUrl(a.file.id) : "#")}
                target="_blank"
                rel="noreferrer noopener"
              >
                {a.name}
              </a>
              {a.file && <span className="text-xs text-muted-foreground">{size(a.file.sizeBytes)}</span>}
              {a.file && a.file.scanStatus !== "clean" && (
                <Badge variant="secondary">{t(`files.scan.${a.file.scanStatus}`)}</Badge>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {a.createdBy?.name} · {new Intl.DateTimeFormat(i18n.language).format(new Date(a.createdAt))}
              </span>
              <button
                type="button"
                aria-label={a.visibleToClient ? t("projects.hideFromClient") : t("projects.showToClient")}
                className={a.visibleToClient ? "text-primary" : "text-muted-foreground"}
                onClick={() =>
                  run.mutate(() =>
                    unwrapVoid(
                      api.projects[":id"].attachments[":subId"].$patch({
                        param: { id: projectId, subId: a.id },
                        json: { visibleToClient: !a.visibleToClient },
                      }),
                    ),
                  )
                }
              >
                {a.visibleToClient ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                aria-label={t("files.remove", { name: a.name })}
                onClick={() =>
                  run.mutate(() =>
                    unwrapVoid(
                      api.projects[":id"].attachments[":subId"].$delete({
                        param: { id: projectId, subId: a.id },
                      }),
                    ),
                  )
                }
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function DuplicateDialog({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(`${project.name} (cópia)`);
  const [includeTasks, setIncludeTasks] = useState(false);
  const [shiftDays, setShiftDays] = useState(project.modality === "mensal" ? 30 : 0);
  const dup = useMutation({
    mutationFn: () =>
      unwrap(
        api.projects[":id"].duplicate.$post({
          param: { id: project.id },
          json: { name, includeTasks, shiftDays },
        }),
      ),
    onSuccess: (r) => {
      toast.success(t("projects.duplicated", { count: r.tasksCopied }));
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["entitlements"] });
      onClose();
      void navigate({ to: "/projetos/$id", params: { id: r.id } });
    },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            dup.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("projects.duplicate")}</DialogTitle>
          </DialogHeader>
          <Field id="dup-name" label={t("projects.fields.name")}>
            <Input
              id="dup-name"
              required
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field id="dup-shift" label={t("projects.shiftDays")} hint={t("projects.shiftDaysHint")}>
            <Input
              id="dup-shift"
              type="number"
              value={shiftDays}
              onChange={(e) => setShiftDays(Number(e.target.value) || 0)}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={includeTasks}
              onChange={(e) => setIncludeTasks(e.target.checked)}
            />
            <span>
              {t("projects.includeTasks", { count: project.tasks.total })}
              <span className="block text-xs text-muted-foreground">{t("projects.includeTasksHint")}</span>
            </span>
          </label>
          {dup.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(t, dup.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={dup.isPending}>
              {t("projects.duplicate")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
