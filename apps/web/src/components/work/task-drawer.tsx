/**
 * Gaveta da tarefa: tudo da tarefa sem sair da tela (lista, Kanban, projeto).
 * Cada campo salva sozinho; mudar de coluna passa pelas regras do fluxo (aprovação, ajustes).
 */
import { plainToRichText, type RichTextDoc, type TaskInput } from "@recpm/shared";
import {
  Avatar,
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  Archive,
  Check,
  Copy,
  ExternalLink,
  FileUp,
  Link2,
  MoreHorizontal,
  Pencil,
  PhoneCall,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import {
  calendarDate,
  downloadUrl,
  fromLocalInput,
  type TaskDetail,
  taskFeedbackQuery,
  taskHistoryQuery,
  taskQuery,
  toLocalInput,
  uploadFile,
} from "../../lib/work";
import { ConfirmDialog, textareaClass } from "../confirm-dialog";
import { TaskDeliveries, TaskTime } from "../time/task-time";
import { TimerButton } from "../time/timer";
import { AdjustmentDialog } from "./adjustment-dialog";
import { useLookups } from "./lookups";
import { isEmptyDoc, RichTextInput, RichTextView } from "./rich-text";

export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!taskId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        closeLabel={t("common.close")}
        className="left-auto right-0 top-0 h-dvh w-full max-w-2xl translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none border-y-0 border-r-0 p-0 sm:w-[42rem]"
      >
        {taskId ? <DrawerBody id={taskId} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DrawerBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(taskQuery(id));
  const lk = useLookups({ projects: false });
  const me = useQuery(meQuery).data;
  const canTrack = !!me?.tenant?.permissions.includes("time.track");
  const [adjust, setAdjust] = useState<null | "move" | "reject">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [archiveReason, setArchiveReason] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["time"] });
  };
  const onErr = (e: unknown) => toast.error(errorMessage(t, e));

  const patch = useMutation({
    mutationFn: (json: Partial<TaskInput>) =>
      unwrap(api.tasks[":id"].$patch({ param: { id }, json: json as never })),
    onSuccess: (data) => {
      qc.setQueryData(taskQuery(id).queryKey, data);
      refresh();
    },
    onError: onErr,
  });
  const action = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: onErr,
  });

  if (q.isPending)
    return (
      <div className="grid gap-3 p-6">
        <DialogTitle className="sr-only">{t("tasks.loading")}</DialogTitle>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  if (q.isError)
    return (
      <div className="p-6">
        <DialogTitle>{t("tasks.notFound")}</DialogTitle>
        <p className="mt-2 text-sm text-destructive">{errorMessage(t, q.error)}</p>
      </div>
    );
  const task = q.data;
  const col = lk.columns.find((c) => c.key === task.statusKey);
  const editable = task.can.edit && !task.archived;

  const moveTo = (statusKey: string) => {
    if (statusKey === "ajustes") return setAdjust("move");
    action.mutate(() => unwrap(api.tasks[":id"].move.$post({ param: { id }, json: { statusKey } })));
  };

  return (
    <div className="grid gap-6 p-6">
      {/* Cabeçalho */}
      <div className="grid gap-3 pr-8">
        {task.project ? (
          <Link
            to="/projetos/$id"
            params={{ id: task.project.id }}
            className="truncate text-xs text-muted-foreground hover:underline"
            onClick={onClose}
          >
            {task.project.clientCode ? `${task.project.clientCode} · ` : ""}
            {task.project.name}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">{t("tasks.standalone")}</span>
        )}
        <TitleField task={task} disabled={!editable} onSave={(title) => patch.mutate({ title })} />
        <DialogDescription className="sr-only">{t("tasks.drawerHelp")}</DialogDescription>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t("tasks.fields.status")}
            className="h-8 w-auto"
            value={task.statusKey}
            disabled={!editable || action.isPending}
            onChange={(e) => moveTo(e.target.value)}
          >
            {lk.columns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.emoji ? `${c.emoji} ` : ""}
                {c.label}
              </option>
            ))}
          </Select>
          {canTrack && !task.archived && !task.completedAt && <TimerButton taskId={id} />}
          {col?.isApproval && task.can.approve && !task.archived && (
            <>
              <Button
                size="sm"
                onClick={() => action.mutate(() => unwrap(api.tasks[":id"].approve.$post({ param: { id } })))}
              >
                <Check /> {t("tasks.approve")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAdjust("reject")}>
                <X /> {t("tasks.reject")}
              </Button>
            </>
          )}
          {task.statusKey === "aguardando_cliente" && editable && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                action.mutate(async () => {
                  await unwrapVoid(api.tasks[":id"].chase.$post({ param: { id } }));
                  toast.success(t("tasks.chased"));
                })
              }
            >
              <PhoneCall /> {t("tasks.chase")}
            </Button>
          )}
          {task.archived && <Badge variant="secondary">{t("tasks.archivedBadge")}</Badge>}
          {task.overdue && <Badge variant="destructive">{t("tasks.overdue")}</Badge>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="ml-auto" aria-label={t("common.more")}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  action.mutate(async () => {
                    await unwrap(api.tasks[":id"].duplicate.$post({ param: { id } }));
                    toast.success(t("tasks.duplicated"));
                  })
                }
              >
                <Copy /> {t("tasks.duplicate")}
              </DropdownMenuItem>
              {task.can.archive ? (
                <DropdownMenuItem
                  onSelect={() =>
                    action.mutate(() =>
                      unwrapVoid(
                        api.tasks[":id"].archive.$post({ param: { id }, json: { archived: !task.archived } }),
                      ),
                    )
                  }
                >
                  <Archive /> {task.archived ? t("tasks.unarchive") : t("tasks.archive")}
                </DropdownMenuItem>
              ) : task.can.requestArchive && !task.archiveRequest && !task.archived ? (
                <DropdownMenuItem onSelect={() => setArchiveReason("")}>
                  <Archive /> {t("tasks.requestArchive")}
                </DropdownMenuItem>
              ) : null}
              {task.can.delete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={() => setConfirmDelete(true)}>
                    <Trash2 /> {t("common.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {task.archiveRequest && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <span>
              {t("tasks.archiveRequested", { name: task.archiveRequest.by?.name ?? "—" })}
              {task.archiveRequest.reason ? `: “${task.archiveRequest.reason}”` : ""}
            </span>
            {task.can.archive && (
              <span className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    action.mutate(() =>
                      unwrapVoid(
                        api.tasks[":id"]["archive-decision"].$post({
                          param: { id },
                          json: { approve: true },
                        }),
                      ),
                    )
                  }
                >
                  {t("tasks.archiveApprove")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    action.mutate(() =>
                      unwrapVoid(
                        api.tasks[":id"]["archive-decision"].$post({
                          param: { id },
                          json: { approve: false },
                        }),
                      ),
                    )
                  }
                >
                  {t("tasks.archiveDeny")}
                </Button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Campos */}
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] sm:grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("tasks.fields.assignee")}</dt>
        <dd>
          <Select
            aria-label={t("tasks.fields.assignee")}
            className="h-8"
            disabled={!editable}
            value={task.assigneeId ?? ""}
            onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })}
          >
            <option value="">—</option>
            {lk.people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </Select>
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.participants")}</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          {task.assignees.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-0.5 pr-2 text-xs"
            >
              <Avatar name={a.name} src={a.image} className="size-5" />
              {a.name}
              {editable && a.id !== task.assigneeId && (
                <button
                  type="button"
                  aria-label={t("tasks.removeParticipant", { name: a.name })}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    patch.mutate({
                      assignees: task.assignees
                        .filter((x) => x.id !== a.id)
                        .map((x) => ({ userId: x.id, roleId: x.roleId })),
                    })
                  }
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
          {editable && (
            <Select
              aria-label={t("tasks.addParticipant")}
              className="h-7 w-40 text-xs"
              value=""
              onChange={(e) =>
                e.target.value &&
                patch.mutate({
                  assignees: [
                    ...task.assignees.map((x) => ({ userId: x.id, roleId: x.roleId })),
                    { userId: e.target.value },
                  ],
                })
              }
            >
              <option value="">{t("tasks.addParticipant")}</option>
              {lk.people
                .filter((p) => !task.assignees.some((a) => a.id === p.userId))
                .map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                  </option>
                ))}
            </Select>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.approver")}</dt>
        <dd>
          <Select
            aria-label={t("tasks.fields.approver")}
            className="h-8"
            disabled={!editable}
            value={task.approver?.id ?? ""}
            onChange={(e) => patch.mutate({ approverId: e.target.value || null })}
          >
            <option value="">{t("tasks.approverDefault")}</option>
            {lk.people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </Select>
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.deadline")}</dt>
        <dd className="flex items-center gap-2">
          <Input
            aria-label={t("tasks.fields.deadline")}
            type="datetime-local"
            className="h-8"
            disabled={!editable}
            defaultValue={toLocalInput(task.deadline)}
            key={task.deadline ?? "none"}
            onBlur={(e) => {
              const iso = fromLocalInput(e.target.value);
              if (iso !== task.deadline) patch.mutate({ deadline: iso, deadlineHasTime: true });
            }}
          />
          {task.originalDeadline && task.deadline && task.originalDeadline !== task.deadline && (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {t("tasks.originalDeadline", {
                date: new Intl.DateTimeFormat(i18n.language).format(new Date(task.originalDeadline)),
              })}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.priority")}</dt>
        <dd>
          <Select
            aria-label={t("tasks.fields.priority")}
            className="h-8"
            disabled={!editable}
            value={task.priority}
            onChange={(e) => patch.mutate({ priority: e.target.value as "media" })}
          >
            {(["baixa", "media", "alta"] as const).map((p) => (
              <option key={p} value={p}>
                {t(`work.priority.${p}`)}
              </option>
            ))}
          </Select>
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.type")}</dt>
        <dd>
          <Select
            aria-label={t("tasks.fields.type")}
            className="h-8"
            disabled={!editable}
            value={task.taskTypeId ?? ""}
            onChange={(e) => patch.mutate({ taskTypeId: e.target.value || null })}
          >
            <option value="">—</option>
            {lk.types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </Select>
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.tags")}</dt>
        <dd className="flex flex-wrap gap-1">
          {lk.tags.map((g) => {
            const on = task.tagIds.includes(g.id);
            return (
              <button
                key={g.id}
                type="button"
                disabled={!editable}
                aria-pressed={on}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground",
                )}
                onClick={() =>
                  patch.mutate({
                    tagIds: on ? task.tagIds.filter((x) => x !== g.id) : [...task.tagIds, g.id],
                  })
                }
              >
                {g.label}
              </button>
            );
          })}
          {!lk.tags.length && <span className="text-xs text-muted-foreground">—</span>}
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.pieces")}</dt>
        <dd className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Input
            aria-label={t("tasks.fields.pieces")}
            type="number"
            min={0}
            className="h-8 w-20"
            disabled={!editable}
            defaultValue={task.pieceQuantity}
            key={`pq${task.pieceQuantity}`}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n !== task.pieceQuantity) patch.mutate({ pieceQuantity: n });
            }}
          />
          <span className="text-muted-foreground">{t("tasks.fields.estimatedHours")}</span>
          <Input
            aria-label={t("tasks.fields.estimatedHours")}
            type="number"
            min={0}
            step={0.25}
            className="h-8 w-20"
            disabled={!editable}
            defaultValue={task.estimatedHours ?? ""}
            key={`eh${task.estimatedHours}`}
            onBlur={(e) => {
              const n = e.target.value === "" ? null : Number(e.target.value);
              if (n !== task.estimatedHours) patch.mutate({ estimatedHours: n });
            }}
          />
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.driveLink")}</dt>
        <dd className="flex items-center gap-2">
          <Input
            aria-label={t("tasks.fields.driveLink")}
            type="url"
            className="h-8"
            placeholder="https://"
            disabled={!editable}
            defaultValue={task.driveLink ?? ""}
            key={task.driveLink ?? "nolink"}
            onBlur={(e) => {
              if ((e.target.value || null) !== task.driveLink)
                patch.mutate({ driveLink: e.target.value || null });
            }}
          />
          {task.driveLink && (
            <a
              href={task.driveLink}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t("tasks.openLink")}
            >
              <ExternalLink className="size-4" />
            </a>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("tasks.fields.visibleToClient")}</dt>
        <dd>
          <input
            type="checkbox"
            aria-label={t("tasks.fields.visibleToClient")}
            disabled={!editable}
            checked={task.visibleToClient}
            onChange={(e) => patch.mutate({ visibleToClient: e.target.checked })}
          />
        </dd>
        {task.recurrence && (
          <>
            <dt className="text-muted-foreground">{t("tasks.fields.recurrence")}</dt>
            <dd className="text-sm">
              {t(`work.recurrence.${task.recurrence}`)}
              {task.nextGenerationAt
                ? ` · ${t("tasks.nextGeneration", { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(new Date(task.nextGenerationAt)) })}`
                : ""}
            </dd>
          </>
        )}
        {task.clientDeliveryDate && (
          <>
            <dt className="text-muted-foreground">{t("tasks.fields.clientDelivery")}</dt>
            <dd>{calendarDate(task.clientDeliveryDate, i18n.language)}</dd>
          </>
        )}
      </dl>

      <Description task={task} editable={editable} onSave={(description) => patch.mutate({ description })} />
      <Checklist task={task} editable={editable} />
      <Attachments task={task} editable={editable} />
      <TaskDeliveries taskId={id} pieceQuantity={task.pieceQuantity} editable={editable} />
      <TaskTime taskId={id} meId={me?.user.id ?? ""} canTrack={canTrack} />

      {task.adjustments.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">{t("tasks.adjustments")}</h3>
          <ul className="grid gap-1.5 text-sm">
            {task.adjustments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                <Badge variant={a.kind === "client" ? "outline" : "secondary"}>
                  {t(`tasks.adjustment.kinds.${a.kind}`)}
                </Badge>
                <span className="font-medium">{a.reason}</span>
                {a.description && <span className="text-muted-foreground">— {a.description}</span>}
                <span className="ml-auto text-xs text-muted-foreground">
                  {a.resolvedAt ? t("tasks.resolved") : t("tasks.open")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Activity taskId={id} />

      <AdjustmentDialog
        open={!!adjust}
        title={adjust === "reject" ? t("tasks.rejectTitle") : t("tasks.adjustment.title")}
        forceClient={adjust === "move" && task.statusKey === "aguardando_cliente"}
        pending={action.isPending}
        onClose={() => setAdjust(null)}
        onConfirm={(adjustment) =>
          action.mutate(
            () =>
              adjust === "reject"
                ? unwrap(api.tasks[":id"].reject.$post({ param: { id }, json: adjustment }))
                : unwrap(
                    api.tasks[":id"].move.$post({
                      param: { id },
                      json: { statusKey: "ajustes", adjustment },
                    }),
                  ),
            { onSettled: () => setAdjust(null) },
          )
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        title={t("tasks.deleteTitle")}
        description={t("tasks.deleteText")}
        confirmLabel={t("common.delete")}
        pending={action.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          action.mutate(() => unwrapVoid(api.tasks[":id"].$delete({ param: { id } })), {
            onSuccess: () => {
              setConfirmDelete(false);
              onClose();
            },
          })
        }
      />
      <Dialog open={archiveReason !== null} onOpenChange={(o) => !o && setArchiveReason(null)}>
        <DialogContent closeLabel={t("common.cancel")}>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              action.mutate(
                async () => {
                  await unwrapVoid(
                    api.tasks[":id"]["archive-request"].$post({
                      param: { id },
                      json: { reason: archiveReason || undefined },
                    }),
                  );
                  toast.success(t("tasks.archiveRequestSent"));
                },
                { onSettled: () => setArchiveReason(null) },
              );
            }}
          >
            <DialogTitle>{t("tasks.requestArchive")}</DialogTitle>
            <DialogDescription>{t("tasks.requestArchiveHelp")}</DialogDescription>
            <textarea
              aria-label={t("tasks.archiveReason")}
              className={textareaClass}
              maxLength={1000}
              value={archiveReason ?? ""}
              onChange={(e) => setArchiveReason(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setArchiveReason(null)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={action.isPending}>
                {t("tasks.send")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TitleField({
  task,
  disabled,
  onSave,
}: {
  task: TaskDetail;
  disabled: boolean;
  onSave: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState(task.title);
  useEffect(() => setV(task.title), [task.title]);
  return (
    <DialogTitle asChild>
      <h2>
        <input
          aria-label={t("tasks.fields.title")}
          className="w-full rounded-md bg-transparent px-1 -mx-1 text-xl font-semibold outline-none hover:bg-accent/50 focus:bg-accent/50 disabled:hover:bg-transparent"
          value={v}
          maxLength={300}
          disabled={disabled}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => v.trim() && v !== task.title && onSave(v.trim())}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </h2>
    </DialogTitle>
  );
}

function Description({
  task,
  editable,
  onSave,
}: {
  task: TaskDetail;
  editable: boolean;
  onSave: (d: RichTextDoc | null) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [doc, setDoc] = useState<RichTextDoc | null>(task.description as RichTextDoc | null);
  const empty = isEmptyDoc(task.description as RichTextDoc | null);
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t("tasks.fields.description")}</h3>
        {editable && !editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDoc(task.description as RichTextDoc | null);
              setEditing(true);
            }}
          >
            <Pencil /> {t("common.edit")}
          </Button>
        )}
      </div>
      {editing ? (
        <div className="grid gap-2">
          <RichTextInput value={doc} onChange={setDoc} label={t("tasks.fields.description")} autoFocus />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onSave(isEmptyDoc(doc) ? null : doc);
                setEditing(false);
              }}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      ) : empty ? (
        <p className="text-sm text-muted-foreground">{t("tasks.noDescription")}</p>
      ) : (
        <RichTextView doc={task.description} />
      )}
    </section>
  );
}

function Checklist({ task, editable }: { task: TaskDetail; editable: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const id = task.id;
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const done = task.items.filter((i) => i.done).length;
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {t("tasks.checklist")}
        {task.items.length > 0 && (
          <span className="text-xs font-normal text-muted-foreground">
            {done}/{task.items.length}
          </span>
        )}
      </h3>
      {task.items.length > 0 && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full bg-success" style={{ width: `${(done / task.items.length) * 100}%` }} />
        </div>
      )}
      <ul className="grid gap-1">
        {task.items.map((i) => (
          <li key={i.id} className="group flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={i.done}
              disabled={!editable}
              aria-label={i.text}
              onChange={(e) =>
                run.mutate(() =>
                  unwrapVoid(
                    api.tasks[":id"].checklist[":subId"].$patch({
                      param: { id, subId: i.id },
                      json: { done: e.target.checked },
                    }),
                  ),
                )
              }
            />
            <span className={cn("flex-1", i.done && "text-muted-foreground line-through")}>{i.text}</span>
            {editable && (
              <button
                type="button"
                className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                aria-label={t("tasks.removeItem", { item: i.text })}
                onClick={() =>
                  run.mutate(() =>
                    unwrapVoid(api.tasks[":id"].checklist[":subId"].$delete({ param: { id, subId: i.id } })),
                  )
                }
              >
                <X className="size-3.5 text-muted-foreground" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            run.mutate(() => unwrap(api.tasks[":id"].checklist.$post({ param: { id }, json: { text: v } })), {
              onSuccess: () => setText(""),
            });
          }}
        >
          <Input
            className="h-8"
            placeholder={t("tasks.addItem")}
            aria-label={t("tasks.addItem")}
            value={text}
            maxLength={300}
            onChange={(e) => setText(e.target.value)}
          />
          <Button size="sm" variant="outline" type="submit" aria-label={t("tasks.addItem")}>
            <Plus />
          </Button>
        </form>
      )}
    </section>
  );
}

function Attachments({ task, editable }: { task: TaskDetail; editable: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState<string | null>(null);
  const id = task.id;
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", id] }),
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t("tasks.attachments")}</h3>
        {editable && (
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setLink("")}>
              <Link2 /> {t("files.addLink")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
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
                    await unwrap(api.tasks[":id"].attachments.$post({ param: { id }, json: { fileId } }));
                  });
              }}
            />
          </span>
        )}
      </div>
      {link !== null && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate(
              () => unwrap(api.tasks[":id"].attachments.$post({ param: { id }, json: { url: link } })),
              {
                onSuccess: () => setLink(null),
              },
            );
          }}
        >
          <Input
            className="h-8"
            type="url"
            required
            autoFocus
            placeholder="https://"
            aria-label={t("files.linkUrl")}
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <Button size="sm" type="submit">
            {t("common.add")}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setLink(null)}>
            {t("common.cancel")}
          </Button>
        </form>
      )}
      {task.attachments.length ? (
        <ul className="grid gap-1 text-sm">
          {task.attachments.map((a) => (
            <li key={a.id} className="group flex items-center gap-2">
              {a.url ? (
                <Link2 className="size-4 text-muted-foreground" />
              ) : (
                <FileUp className="size-4 text-muted-foreground" />
              )}
              <a
                className="truncate hover:underline"
                href={a.url ?? (a.fileId ? downloadUrl(a.fileId) : "#")}
                target="_blank"
                rel="noreferrer noopener"
              >
                {a.name}
              </a>
              {a.scanStatus && a.scanStatus !== "clean" && (
                <Badge variant="secondary">{t(`files.scan.${a.scanStatus}`)}</Badge>
              )}
              {editable && (
                <button
                  type="button"
                  className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={t("files.remove", { name: a.name })}
                  onClick={() =>
                    run.mutate(() =>
                      unwrapVoid(
                        api.tasks[":id"].attachments[":subId"].$delete({ param: { id, subId: a.id } }),
                      ),
                    )
                  }
                >
                  <Trash2 className="size-3.5 text-muted-foreground" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("files.none")}</p>
      )}
    </section>
  );
}

function Activity({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"comments" | "history">("comments");
  const feedback = useQuery({ ...taskFeedbackQuery(taskId), enabled: tab === "comments" });
  const history = useQuery({ ...taskHistoryQuery(taskId), enabled: tab === "history" });
  const [text, setText] = useState("");
  const when = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.tasks[":id"].feedback.$post({
          param: { id: taskId },
          json: { body: plainToRichText(text.trim()) },
        }),
      ),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: taskFeedbackQuery(taskId).queryKey });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  return (
    <section className="grid gap-3">
      <div role="tablist" className="flex gap-4 border-b text-sm">
        {(["comments", "history"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={cn(
              "-mb-px border-b-2 px-1 pb-2",
              tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground",
            )}
            onClick={() => setTab(k)}
          >
            {t(`tasks.tabs.${k}`)}
          </button>
        ))}
      </div>
      {tab === "comments" ? (
        <div className="grid gap-3">
          {feedback.data?.data.map((f) => (
            <div key={f.id} className="flex gap-2">
              <Avatar name={f.author?.name ?? "?"} src={f.author?.image} className="size-7" />
              <div className="grid flex-1 gap-0.5">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{f.author?.name ?? "—"}</span> ·{" "}
                  {when(f.createdAt)}
                  {f.visibleToClient ? ` · ${t("tasks.visibleToClientShort")}` : ""}
                </p>
                <RichTextView doc={f.body} />
              </div>
            </div>
          ))}
          {feedback.data && !feedback.data.data.length && (
            <p className="text-sm text-muted-foreground">{t("tasks.noComments")}</p>
          )}
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send.mutate();
            }}
          >
            <textarea
              aria-label={t("tasks.writeComment")}
              placeholder={t("tasks.writeComment")}
              className={textareaClass}
              value={text}
              maxLength={5000}
              onChange={(e) => setText(e.target.value)}
            />
            <Button
              size="sm"
              type="submit"
              className="justify-self-end"
              disabled={!text.trim() || send.isPending}
            >
              {t("tasks.send")}
            </Button>
          </form>
        </div>
      ) : (
        <ol className="grid gap-2 text-sm">
          {history.data?.data.map((h) => (
            <li key={h.id} className="flex gap-2">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">{when(h.createdAt)}</span>
              <span>
                <span className="font-medium">{h.actorName ?? t("tasks.system")}</span>{" "}
                {historyText(t, h.action, h.details as Record<string, unknown> | null)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function historyText(t: TFunction, action: string, d: Record<string, unknown> | null) {
  if (action === "status_change")
    return t("tasks.history.status_change", {
      from: String(d?.fromLabel ?? ""),
      to: String(d?.toLabel ?? ""),
    });
  if (action === "update") {
    const fields = Object.keys(d ?? {})
      .map((k) => t(`tasks.fieldNames.${k}`, { defaultValue: k }))
      .join(", ");
    return t("tasks.history.update", { fields });
  }
  if (action === "create") return t("tasks.history.create", { to: String(d?.toLabel ?? "") });
  return t(`tasks.history.${action}`, {
    defaultValue: action,
    name: String(d?.name ?? ""),
    quantity: String(d?.quantity ?? ""),
  });
}
