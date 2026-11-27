import { Button, cn, EmptyState, Input, Select, Skeleton } from "@recpm/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { CheckSquare, LayoutList, List, Plus, Search, SquareKanban } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import { useLookups } from "../../components/work/lookups";
import { TaskBoard } from "../../components/work/task-board";
import { TaskDrawer } from "../../components/work/task-drawer";
import { TaskFormDialog } from "../../components/work/task-form-dialog";
import { TaskList } from "../../components/work/task-list";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { tasksQuery } from "../../lib/work";

const VIEWS = ["list", "kanban", "compact"] as const;
const QUICK = ["overdue", "due24h", "waitingClient", "archiveRequested", "archived"] as const;

const searchSchema = z.object({
  view: z.enum(VIEWS).optional(),
  scope: z.enum(["mine", "team", "all"]).optional(),
  status: z.string().optional(),
  projectId: z.string().optional(),
  assigneeId: z.string().optional(),
  typeId: z.string().optional(),
  priority: z.enum(["baixa", "media", "alta"]).optional(),
  q: z.string().optional(),
  overdue: z.boolean().optional(),
  due24h: z.boolean().optional(),
  waitingClient: z.boolean().optional(),
  archiveRequested: z.boolean().optional(),
  archived: z.boolean().optional(),
  task: z.string().optional(),
});

export const Route = createFileRoute("/_app/tarefas")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("tasks.read")) throw redirect({ to: "/" });
  },
  component: Tasks,
});

function Tasks() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/tarefas" });
  const { data: me } = useQuery(meQuery);
  const perms = new Set(me?.tenant?.permissions ?? []);
  const lk = useLookups();
  const view = search.view ?? "list";
  const scope = search.scope ?? (perms.has("tasks.readAll") ? "all" : "mine");
  const [q, setQ] = useState(search.q ?? "");
  const [creating, setCreating] = useState(false);
  const { view: _v, task: _t, ...filters } = search;
  const list = useQuery({
    ...tasksQuery({ ...filters, scope, sort: view === "kanban" ? "board" : "deadline" }),
    placeholderData: keepPreviousData,
  });
  const open = (task: string) => void navigate({ search: (s) => ({ ...s, task }) });
  type S = z.infer<typeof searchSchema>;
  const setFilter = (patch: Partial<S>) => void navigate({ search: (s: S) => ({ ...s, ...patch }) });
  const active = QUICK.filter((k) => search[k]);

  return (
    <>
      <PageHeader
        title={t("tasks.title")}
        description={t("tasks.subtitle")}
        actions={
          perms.has("tasks.create") ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("tasks.new")}
            </Button>
          ) : null
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form
          className="relative min-w-64 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ q: q || undefined });
          }}
        >
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t("tasks.search")}
            aria-label={t("tasks.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </form>
        <div className="flex flex-wrap gap-2">
          <Select
            className="w-36"
            aria-label={t("tasks.scope.label")}
            value={scope}
            onChange={(e) => setFilter({ scope: e.target.value as "mine" })}
          >
            {(["mine", "team", "all"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`tasks.scope.${s}`)}
              </option>
            ))}
          </Select>
          <Select
            className="w-48"
            aria-label={t("tasks.fields.project")}
            value={search.projectId ?? ""}
            onChange={(e) => setFilter({ projectId: e.target.value || undefined })}
          >
            <option value="">{t("tasks.allProjects")}</option>
            {lk.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.client ? `${p.client.code} · ` : ""}
                {p.name}
              </option>
            ))}
          </Select>
          {view !== "kanban" && (
            <Select
              className="w-44"
              aria-label={t("tasks.fields.status")}
              value={search.status ?? ""}
              onChange={(e) => setFilter({ status: e.target.value || undefined })}
            >
              <option value="">{t("tasks.allStatuses")}</option>
              {lk.columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
          <Select
            className="w-44"
            aria-label={t("tasks.fields.assignee")}
            value={search.assigneeId ?? ""}
            onChange={(e) => setFilter({ assigneeId: e.target.value || undefined })}
          >
            <option value="">{t("tasks.anyone")}</option>
            {lk.people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            className="w-36"
            aria-label={t("tasks.fields.priority")}
            value={search.priority ?? ""}
            onChange={(e) => setFilter({ priority: (e.target.value || undefined) as "media" })}
          >
            <option value="">{t("tasks.anyPriority")}</option>
            {(["alta", "media", "baixa"] as const).map((p) => (
              <option key={p} value={p}>
                {t(`work.priority.${p}`)}
              </option>
            ))}
          </Select>
          {/* biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância */}
          <div className="flex rounded-md border p-0.5" role="group" aria-label={t("tasks.view")}>
            {VIEWS.map((v) => {
              const Icon = v === "list" ? List : v === "kanban" ? SquareKanban : LayoutList;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  title={t(`tasks.views.${v}`)}
                  className={cn(
                    "flex items-center gap-1.5 rounded px-2.5 py-1 text-sm",
                    view === v ? "bg-accent font-medium" : "text-muted-foreground",
                  )}
                  onClick={() => setFilter({ view: v === "list" ? undefined : v })}
                >
                  <Icon className="size-4" />
                  <span className="hidden sm:inline">{t(`tasks.views.${v}`)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância */}
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label={t("tasks.quickFilters")}>
        {QUICK.filter((k) => k !== "archiveRequested" || perms.has("tasks.archive")).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={!!search[k]}
            className={cn(
              "rounded-full border px-3 py-1 text-xs",
              search[k]
                ? "border-primary bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setFilter({ [k]: search[k] ? undefined : true })}
          >
            {t(`tasks.quick.${k}`)}
          </button>
        ))}
        {(active.length > 0 ||
          search.projectId ||
          search.assigneeId ||
          search.priority ||
          search.status ||
          search.q) && (
          <button
            type="button"
            className="px-2 text-xs text-muted-foreground underline"
            onClick={() => {
              setQ("");
              void navigate({ search: { view: search.view, scope: search.scope } });
            }}
          >
            {t("tasks.clearFilters")}
          </button>
        )}
      </div>

      {list.isPending ? (
        <Skeleton className="h-64" />
      ) : list.isError ? (
        <p className="text-destructive">{errorMessage(t, list.error)}</p>
      ) : view === "kanban" ? (
        <TaskBoard columns={lk.columns} tasks={list.data.data} onOpen={open} />
      ) : !list.data.data.length ? (
        <EmptyState
          icon={<CheckSquare className="size-6" />}
          title={t("tasks.empty")}
          description={t("tasks.emptyText")}
        />
      ) : (
        <>
          <TaskList
            tasks={list.data.data}
            onOpen={open}
            compact={view === "compact"}
            selectable
            canArchive={perms.has("tasks.archive")}
          />
          {list.data.total > list.data.data.length && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("tasks.showing", { shown: list.data.data.length, total: list.data.total })}
            </p>
          )}
        </>
      )}

      <TaskDrawer taskId={search.task ?? null} onClose={() => setFilter({ task: undefined })} />
      <TaskFormDialog
        open={creating}
        projectId={search.projectId}
        onClose={() => setCreating(false)}
        onCreated={open}
      />
    </>
  );
}
