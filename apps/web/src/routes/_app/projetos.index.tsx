import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { PROJECT_STATUSES, type ProjectStatus } from "@recpm/shared";
import { Avatar, Badge, Button, Card, cn, EmptyState, Input, Select, Skeleton } from "@recpm/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarRange,
  FolderKanban,
  LayoutGrid,
  Plus,
  Search,
  SquareKanban,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import { ProjectFormDialog } from "../../components/work/project-form-dialog";
import { api, unwrap } from "../../lib/api";
import { clientsQuery } from "../../lib/clients";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { calendarDate, PROJECT_STATUS_TONE, type ProjectSummary, projectsQuery } from "../../lib/work";

const VIEWS = ["cards", "status", "timeline"] as const;

export const Route = createFileRoute("/_app/projetos/")({
  validateSearch: z.object({
    view: z.enum(VIEWS).optional(),
    q: z.string().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    clientId: z.string().optional(),
    archived: z.boolean().optional(),
  }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("projects.read")) throw redirect({ to: "/" });
  },
  component: Projects,
});

function Projects() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/projetos/" });
  const { data: me } = useQuery(meQuery);
  const canManage = !!me?.tenant?.permissions.includes("projects.manage");
  const view = search.view ?? "cards";
  const [q, setQ] = useState(search.q ?? "");
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    ...projectsQuery({
      q: search.q,
      status: view === "status" ? undefined : search.status,
      clientId: search.clientId,
      archived: search.archived,
    }),
    placeholderData: keepPreviousData,
  });
  const clients = useQuery(clientsQuery({ status: "all" }));

  return (
    <>
      <PageHeader
        title={t("projects.title")}
        description={t("projects.subtitle")}
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("projects.new")}
            </Button>
          ) : null
        }
      />
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
        <form
          className="relative flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void navigate({ search: (s) => ({ ...s, q: q || undefined }) });
          }}
        >
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t("projects.search")}
            aria-label={t("projects.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </form>
        <div className="flex flex-wrap gap-2">
          {view !== "status" && (
            <Select
              className="w-44"
              aria-label={t("projects.fields.status")}
              value={search.status ?? ""}
              onChange={(e) =>
                void navigate({
                  search: (s) => ({ ...s, status: (e.target.value || undefined) as ProjectStatus }),
                })
              }
            >
              <option value="">{t("projects.allStatuses")}</option>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`projects.status.${s}`)}
                </option>
              ))}
            </Select>
          )}
          <Select
            className="w-48"
            aria-label={t("projects.fields.client")}
            value={search.clientId ?? ""}
            onChange={(e) =>
              void navigate({ search: (s) => ({ ...s, clientId: e.target.value || undefined }) })
            }
          >
            <option value="">{t("projects.allClients")}</option>
            {clients.data?.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 px-1 text-sm">
            <input
              type="checkbox"
              checked={!!search.archived}
              onChange={(e) =>
                void navigate({ search: (s) => ({ ...s, archived: e.target.checked || undefined }) })
              }
            />
            {t("projects.showArchived")}
          </label>
          {/* biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância */}
          <div className="flex rounded-md border p-0.5" role="group" aria-label={t("projects.view")}>
            {VIEWS.map((v) => {
              const Icon = v === "cards" ? LayoutGrid : v === "status" ? SquareKanban : CalendarRange;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  title={t(`projects.views.${v}`)}
                  className={cn(
                    "flex items-center gap-1.5 rounded px-2.5 py-1 text-sm",
                    view === v ? "bg-accent font-medium" : "text-muted-foreground",
                  )}
                  onClick={() =>
                    void navigate({ search: (s) => ({ ...s, view: v === "cards" ? undefined : v }) })
                  }
                >
                  <Icon className="size-4" />
                  <span className="hidden sm:inline">{t(`projects.views.${v}`)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {list.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : list.isError ? (
        <p className="text-destructive">{errorMessage(t, list.error)}</p>
      ) : !list.data.data.length ? (
        <EmptyState
          icon={<FolderKanban className="size-6" />}
          title={search.q || search.status || search.clientId ? t("projects.noResults") : t("projects.empty")}
          description={t("projects.emptyText")}
          action={
            canManage ? (
              <Button onClick={() => setCreating(true)}>
                <Plus /> {t("projects.new")}
              </Button>
            ) : null
          }
        />
      ) : view === "cards" ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.data.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      ) : view === "status" ? (
        <StatusBoard projects={list.data.data} canManage={canManage} />
      ) : (
        <Timeline projects={list.data.data} />
      )}

      <ProjectFormDialog
        open={creating}
        defaultClientId={search.clientId}
        onClose={() => setCreating(false)}
        onSaved={(id) => void navigate({ to: "/projetos/$id", params: { id } })}
      />
    </>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="grid gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProjectCard({ p, compact }: { p: ProjectSummary; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  return (
    <Link to="/projetos/$id" params={{ id: p.id }} className="rounded-xl focus-visible:outline-2">
      <Card
        className={cn(
          "grid h-full gap-3 p-4 transition-colors hover:border-primary/50",
          compact && "gap-2 p-3",
        )}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted-foreground">
              {p.client ? (
                <>
                  <span className="font-mono">{p.client.code}</span> · {p.client.name}
                </>
              ) : (
                t("projects.internal")
              )}
            </p>
            <h3 className="truncate font-semibold">{p.name}</h3>
          </div>
          {!compact && (
            <Badge variant={PROJECT_STATUS_TONE[p.status]}>{t(`projects.status.${p.status}`)}</Badge>
          )}
        </div>
        {!compact && (p.type || p.tags.length > 0 || p.waitingClient) && (
          <div className="flex flex-wrap gap-1">
            {p.waitingClient && <Badge variant="outline">{t("projects.waitingClient")}</Badge>}
            {p.type && <Badge variant="secondary">{p.type.label}</Badge>}
            {p.tags.map((g) => (
              <span
                key={g.id}
                className="rounded px-1.5 py-0.5 text-[11px]"
                style={{ background: `${g.color ?? "#64748b"}22` }}
              >
                {g.name}
              </span>
            ))}
          </div>
        )}
        <Progress done={p.tasks.done} total={p.tasks.total} />
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{t("projects.taskProgress", { done: p.tasks.done, total: p.tasks.total })}</span>
          {p.tasks.overdue > 0 && (
            <span className="inline-flex items-center gap-1 font-medium text-destructive">
              <AlertTriangle className="size-3.5" />
              {t("projects.overdueCount", { count: p.tasks.overdue })}
            </span>
          )}
          {p.deliveryDeadline && (
            <span className="ml-auto">{calendarDate(p.deliveryDeadline, i18n.language)}</span>
          )}
          {p.manager && <Avatar name={p.manager.name} src={p.manager.image} className="size-6" />}
        </div>
      </Card>
    </Link>
  );
}

/** Kanban de projetos por status: arrastar muda o status. */
function StatusBoard({ projects, canManage }: { projects: ProjectSummary[]; canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const change = useMutation({
    mutationFn: (v: { id: string; status: ProjectStatus }) =>
      unwrap(api.projects[":id"].$patch({ param: { id: v.id }, json: { status: v.status } })),
    onError: (e) => toast.error(errorMessage(t, e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const onEnd = (e: DragEndEvent) => {
    const to = e.over?.id as ProjectStatus | undefined;
    const p = projects.find((x) => x.id === e.active.id);
    if (to && p && p.status !== to) change.mutate({ id: p.id, status: to });
  };
  return (
    <DndContext sensors={sensors} onDragEnd={onEnd}>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {PROJECT_STATUSES.map((s) => {
          const items = projects.filter((p) => p.status === s);
          return (
            <StatusLane key={s} status={s} count={items.length} label={t(`projects.status.${s}`)}>
              {items.map((p) => (
                <DraggableProject key={p.id} p={p} disabled={!canManage} />
              ))}
            </StatusLane>
          );
        })}
      </div>
    </DndContext>
  );
}

function StatusLane({
  status,
  label,
  count,
  children,
}: {
  status: string;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section
      aria-label={label}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl border bg-muted/40",
        isOver && "border-primary/60 bg-primary/5",
      )}
    >
      <header className="flex items-center px-3 py-2.5">
        <h3 className="text-sm font-semibold">{label}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{count}</span>
      </header>
      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">
        {children}
      </div>
    </section>
  );
}

function DraggableProject({ p, disabled }: { p: ProjectSummary; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: p.id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      className={cn("touch-none", !disabled && "cursor-grab", isDragging && "z-10 opacity-80")}
      {...attributes}
      {...listeners}
    >
      <ProjectCard p={p} compact />
    </div>
  );
}

/** Linha do tempo: barras do início à entrega, por mês. */
function Timeline({ projects }: { projects: ProjectSummary[] }) {
  const { t, i18n } = useTranslation();
  const dated = projects.filter((p) => p.startDate || p.deliveryDeadline);
  const undated = projects.length - dated.length;
  if (!dated.length)
    return <EmptyState title={t("projects.timelineEmpty")} description={t("projects.timelineEmptyText")} />;
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const starts = dated.map((p) => day(p.startDate ?? p.deliveryDeadline!));
  const ends = dated.map((p) => day(p.deliveryDeadline ?? p.startDate!));
  const min = new Date(Math.min(...starts));
  const max = new Date(Math.max(...ends));
  const from = Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1);
  const to = Date.UTC(max.getUTCFullYear(), max.getUTCMonth() + 1, 1);
  const span = to - from;
  const months: { label: string; left: number; width: number }[] = [];
  for (let m = new Date(from); m.getTime() < to; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const a = m.getTime();
    const b = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1);
    months.push({
      label: new Intl.DateTimeFormat(i18n.language, {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      }).format(m),
      left: ((a - from) / span) * 100,
      width: ((b - a) / span) * 100,
    });
  }
  const today = ((Date.now() - from) / span) * 100;
  return (
    <Card className="overflow-x-auto p-4">
      <div className="min-w-[48rem]">
        <div className="relative ml-56 h-6 border-b text-xs text-muted-foreground">
          {months.map((m) => (
            <span
              key={m.left}
              className="absolute top-0 border-l pl-1"
              style={{ left: `${m.left}%`, width: `${m.width}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <ul className="grid gap-1.5 pt-2">
          {dated.map((p, i) => {
            const a = starts[i]!;
            const b = Math.max(ends[i]!, a) + 86_400_000;
            const pct = p.tasks.total ? (p.tasks.done / p.tasks.total) * 100 : 0;
            return (
              <li key={p.id} className="flex items-center">
                <Link
                  to="/projetos/$id"
                  params={{ id: p.id }}
                  className="w-56 shrink-0 truncate pr-3 text-sm hover:underline"
                  title={p.name}
                >
                  {p.client ? (
                    <span className="font-mono text-xs text-muted-foreground">{p.client.code} </span>
                  ) : null}
                  {p.name}
                </Link>
                <div className="relative h-6 flex-1">
                  {today >= 0 && today <= 100 && (
                    <div
                      className="absolute inset-y-0 w-px bg-destructive/60"
                      style={{ left: `${today}%` }}
                      aria-hidden
                    />
                  )}
                  <div
                    className="absolute top-1 h-4 overflow-hidden rounded bg-primary/25"
                    style={{ left: `${((a - from) / span) * 100}%`, width: `${((b - a) / span) * 100}%` }}
                    title={`${calendarDate(p.startDate, i18n.language)} → ${calendarDate(p.deliveryDeadline, i18n.language)}`}
                  >
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {undated > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">{t("projects.undated", { count: undated })}</p>
        )}
      </div>
    </Card>
  );
}
