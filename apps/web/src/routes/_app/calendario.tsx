/**
 * Calendário (§6.4): abas Cronograma, Agenda da equipe e Entregas; grade ou lista; visões de
 * dia, semana e mês; filtros por tipo; criar/editar eventos; importação de feriados nacionais.
 */
import { CALENDAR_EVENT_TYPES } from "@recpm/shared";
import { Button, cn, EmptyState, Select, Skeleton } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  Settings2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { EventDialog, HolidaysDialog } from "../../components/calendar/event-dialog";
import { PageHeader } from "../../components/page-header";
import { TaskDrawer } from "../../components/work/task-drawer";
import { addDays, type CalendarItem, type CalendarTab, calendarQuery, parseYmd, ymd } from "../../lib/comms";
import { meQuery } from "../../lib/queries";

const searchSchema = z.object({
  tab: z.enum(["schedule", "team", "deliveries"]).optional(),
  view: z.enum(["month", "week", "day"]).optional(),
  layout: z.enum(["grid", "list"]).optional(),
  date: z.string().optional(),
  types: z.string().optional(),
  mine: z.boolean().optional(),
  task: z.string().optional(),
});
type S = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/_app/calendario")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("calendar.read")) throw redirect({ to: "/" });
  },
  component: CalendarPage,
});

/** Filtros por aba (o servidor filtra pela lista de tipos). */
const TAB_TYPES: Record<CalendarTab, string[]> = {
  schedule: [...CALENDAR_EVENT_TYPES, "milestones"],
  team: ["reuniao", "treinamento", "podcast", "aniversario", "feriado"],
  deliveries: [],
};
const MILESTONE_TYPES = [
  "milestone_start",
  "milestone_first_delivery",
  "milestone_feedback_deadline",
  "milestone_final_delivery",
  "milestone_support_start",
  "milestone_support_end",
  "milestone_custom",
];

export const TYPE_TONE: Record<string, string> = {
  reuniao: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40",
  treinamento: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40",
  podcast: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-500/40",
  aniversario: "bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/40",
  feriado: "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/40",
  outro: "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/40",
  milestone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
  entrega: "bg-primary/15 text-primary border-primary/40",
  atrasada: "bg-destructive/15 text-destructive border-destructive/40",
  concluida: "bg-success/15 text-success border-success/40",
};
const toneOf = (i: CalendarItem) =>
  i.kind === "task"
    ? i.task?.completed
      ? TYPE_TONE.concluida
      : i.task?.overdue
        ? TYPE_TONE.atrasada
        : TYPE_TONE.entrega
    : i.kind === "milestone"
      ? TYPE_TONE.milestone
      : (TYPE_TONE[i.type] ?? TYPE_TONE.outro);

function range(view: "month" | "week" | "day", anchor: Date) {
  if (view === "day") return { from: anchor, to: anchor };
  if (view === "week") {
    const start = addDays(anchor, -((anchor.getDay() + 6) % 7)); // segunda
    return { from: start, to: addDays(start, 6) };
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const end = addDays(last, 6 - ((last.getDay() + 6) % 7));
  return { from: start, to: end };
}

function CalendarPage() {
  const { t, i18n } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/calendario" });
  const set = (patch: Partial<S>) => void navigate({ search: (s: S) => ({ ...s, ...patch }) });
  const me = useQuery(meQuery).data;
  const canManage = !!me?.tenant?.permissions.includes("calendar.manage");
  const tab = search.tab ?? "schedule";
  const view = search.view ?? "month";
  const layout = search.layout ?? "grid";
  const anchor = search.date ? parseYmd(search.date) : new Date();
  const { from, to } = range(view, anchor);
  const selected = search.types ? search.types.split(",") : [];
  const serverTypes = selected.flatMap((x) => (x === "milestones" ? MILESTONE_TYPES : [x])).join(",");
  const q = useQuery(
    calendarQuery({ from: ymd(from), to: ymd(to), tab, types: serverTypes || undefined, mine: search.mine }),
  );
  const [editing, setEditing] = useState<CalendarItem | "new" | null>(null);
  const [newDate, setNewDate] = useState<string | null>(null);
  const [holidays, setHolidays] = useState(false);

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const it of q.data?.data ?? []) m.set(it.date, [...(m.get(it.date) ?? []), it]);
    for (const list of m.values()) list.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    return m;
  }, [q.data]);

  const step = (dir: 1 | -1) => {
    const d =
      view === "month"
        ? new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1)
        : addDays(anchor, dir * (view === "week" ? 7 : 1));
    set({ date: ymd(d) });
  };
  const label =
    view === "month"
      ? new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(anchor)
      : view === "week"
        ? `${new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(from)} – ${new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short", year: "numeric" }).format(to)}`
        : new Intl.DateTimeFormat(i18n.language, { weekday: "long", day: "numeric", month: "long" }).format(
            anchor,
          );

  const open = (it: CalendarItem) => {
    if (it.kind === "task" && it.task) set({ task: it.task.id });
    else if (it.kind === "event" && canManage && it.source !== "feriado_api") setEditing(it);
    else if (it.project) void navigate({ to: "/projetos/$id", params: { id: it.project.id } });
  };
  const toggleType = (k: string) => {
    const next = selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k];
    set({ types: next.length ? next.join(",") : undefined });
  };

  return (
    <>
      <PageHeader
        title={t("calendar.title")}
        description={t("calendar.subtitle")}
        actions={
          canManage ? (
            <>
              <Button
                variant="outline"
                size="icon"
                aria-label={t("calendar.holidays.title")}
                onClick={() => setHolidays(true)}
              >
                <Settings2 />
              </Button>
              <Button
                onClick={() => {
                  setNewDate(view === "day" ? ymd(anchor) : null);
                  setEditing("new");
                }}
              >
                <CalendarPlus /> {t("calendar.newEvent")}
              </Button>
            </>
          ) : null
        }
      />
      {/* biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância */}
      <div className="mb-4 flex gap-1 overflow-x-auto border-b" role="group" aria-label={t("calendar.title")}>
        {(["schedule", "team", "deliveries"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={tab === k}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm",
              tab === k
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground",
            )}
            onClick={() => set({ tab: k === "schedule" ? undefined : k, types: undefined, mine: undefined })}
          >
            {t(`calendar.tabs.${k}`)}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label={t("calendar.prev")} onClick={() => step(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" onClick={() => set({ date: undefined })}>
            {t("calendar.today")}
          </Button>
          <Button variant="outline" size="icon" aria-label={t("calendar.next")} onClick={() => step(1)}>
            <ChevronRight />
          </Button>
        </div>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold" aria-live="polite">
          {label.charAt(0).toUpperCase() + label.slice(1)}
        </h2>
        <Select
          aria-label={t("calendar.view")}
          className="w-auto"
          value={view}
          onChange={(e) =>
            set({ view: e.target.value === "month" ? undefined : (e.target.value as S["view"]) })
          }
        >
          {(["month", "week", "day"] as const).map((v) => (
            <option key={v} value={v}>
              {t(`calendar.views.${v}`)}
            </option>
          ))}
        </Select>
        <div className="flex rounded-md border">
          {(["grid", "list"] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={layout === l}
              aria-label={t(`calendar.layouts.${l}`)}
              title={t(`calendar.layouts.${l}`)}
              className={cn(
                "grid size-9 place-items-center",
                layout === l ? "bg-accent" : "text-muted-foreground",
              )}
              onClick={() => set({ layout: l === "grid" ? undefined : l })}
            >
              {l === "grid" ? <LayoutGrid className="size-4" /> : <List className="size-4" />}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {TAB_TYPES[tab].map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={selected.includes(k)}
            onClick={() => toggleType(k)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs",
              selected.includes(k)
                ? TYPE_TONE[k === "milestones" ? "milestone" : k]
                : "text-muted-foreground",
            )}
          >
            {t(`calendar.types.${k}`)}
          </button>
        ))}
        {tab === "deliveries" && (
          <button
            type="button"
            aria-pressed={!!search.mine}
            onClick={() => set({ mine: search.mine ? undefined : true })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs",
              search.mine ? TYPE_TONE.entrega : "text-muted-foreground",
            )}
          >
            {t("calendar.onlyMine")}
          </button>
        )}
        {tab === "team" && <span className="text-xs text-muted-foreground">{t("calendar.teamHint")}</span>}
      </div>

      {q.isPending ? (
        <Skeleton className="h-[28rem]" />
      ) : layout === "list" || view === "day" ? (
        <ListView
          from={from}
          to={to}
          byDay={byDay}
          onOpen={open}
          emptyAll={!q.data?.data.length}
          onNew={canManage ? () => setEditing("new") : undefined}
        />
      ) : (
        <GridView
          view={view}
          anchor={anchor}
          from={from}
          to={to}
          byDay={byDay}
          onOpen={open}
          onDay={(d) => set({ view: "day", date: d })}
        />
      )}

      {editing && (
        <EventDialog
          item={editing === "new" ? null : editing}
          defaultDate={newDate ?? ymd(anchor)}
          onClose={() => setEditing(null)}
        />
      )}
      {holidays && <HolidaysDialog onClose={() => setHolidays(false)} />}
      <TaskDrawer taskId={search.task ?? null} onClose={() => set({ task: undefined })} />
    </>
  );
}

function ItemChip({
  it,
  onOpen,
  compact,
}: {
  it: CalendarItem;
  onOpen: (i: CalendarItem) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const kindLabel =
    it.kind === "milestone" ? t(`calendar.milestones.${it.type.replace("milestone_", "")}`) : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(it)}
      title={[it.time, kindLabel, it.title, it.project?.clientCode].filter(Boolean).join(" · ")}
      className={cn(
        "flex w-full min-w-0 items-center gap-1 rounded border-l-2 px-1.5 text-left",
        compact ? "py-0.5 text-[11px]" : "py-1 text-xs",
        toneOf(it),
        it.task?.completed && "line-through opacity-70",
      )}
    >
      {it.time && <span className="shrink-0 tabular-nums opacity-80">{it.time}</span>}
      <span className="truncate">
        {kindLabel ? `${kindLabel}: ` : ""}
        {it.title}
      </span>
    </button>
  );
}

function GridView({
  view,
  anchor,
  from,
  to,
  byDay,
  onOpen,
  onDay,
}: {
  view: "month" | "week";
  anchor: Date;
  from: Date;
  to: Date;
  byDay: Map<string, CalendarItem[]>;
  onOpen: (i: CalendarItem) => void;
  onDay: (d: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const days: Date[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const today = ymd(new Date());
  const weekday = new Intl.DateTimeFormat(i18n.language, { weekday: "short" });
  const max = view === "month" ? 3 : 50;
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-cols-7 border-b bg-muted/40 text-center text-[11px] font-medium uppercase text-muted-foreground">
        {days.slice(0, 7).map((d) => (
          <div key={ymd(d)} className="py-1.5">
            {weekday.format(d).replace(".", "")}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const key = ymd(d);
          const items = byDay.get(key) ?? [];
          const out = view === "month" && d.getMonth() !== anchor.getMonth();
          const dayOff = items.some((i) => i.isDayOff);
          return (
            <div
              key={key}
              className={cn(
                "min-w-0 border-b border-r p-1 [&:nth-child(7n)]:border-r-0",
                view === "month" ? "min-h-16 sm:min-h-28" : "min-h-40 sm:min-h-72",
                out && "bg-muted/30 text-muted-foreground",
                dayOff && "bg-amber-500/5",
              )}
            >
              <button
                type="button"
                onClick={() => onDay(key)}
                aria-label={t("calendar.openDay", {
                  date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "full" }).format(d),
                  count: items.length,
                })}
                className={cn(
                  "mb-1 grid size-6 place-items-center rounded-full text-xs tabular-nums hover:bg-accent",
                  key === today && "bg-primary font-semibold text-primary-foreground hover:bg-primary",
                )}
              >
                {d.getDate()}
              </button>
              {/* no celular, só pontinhos; toque no dia para ver a lista */}
              <div className="flex flex-wrap gap-0.5 sm:hidden">
                {items.slice(0, 4).map((it) => (
                  <span key={it.id} className={cn("size-1.5 rounded-full border", toneOf(it))} />
                ))}
              </div>
              <div className="hidden gap-0.5 sm:grid">
                {items.slice(0, max).map((it) => (
                  <ItemChip key={it.id} it={it} onOpen={onOpen} compact />
                ))}
                {items.length > max && (
                  <button
                    type="button"
                    className="px-1 text-left text-[11px] text-muted-foreground hover:underline"
                    onClick={() => onDay(key)}
                  >
                    {t("calendar.more", { count: items.length - max })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListView({
  from,
  to,
  byDay,
  onOpen,
  emptyAll,
  onNew,
}: {
  from: Date;
  to: Date;
  byDay: Map<string, CalendarItem[]>;
  onOpen: (i: CalendarItem) => void;
  emptyAll: boolean;
  onNew?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: "long", day: "numeric", month: "long" });
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (byDay.has(ymd(d))) days.push(ymd(d));
  if (emptyAll || !days.length)
    return (
      <EmptyState
        icon={<CalendarDays />}
        title={t("calendar.empty")}
        description={t("calendar.emptyHint")}
        action={
          onNew ? (
            <Button variant="outline" onClick={onNew}>
              <CalendarPlus /> {t("calendar.newEvent")}
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <div className="grid gap-4">
      {days.map((d) => (
        <section key={d} aria-label={fmt.format(parseYmd(d))}>
          <h3 className="mb-1.5 text-sm font-medium capitalize">{fmt.format(parseYmd(d))}</h3>
          <ul className="grid gap-1.5">
            {(byDay.get(d) ?? []).map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => onOpen(it)}
                  className={cn(
                    "flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border-l-4 px-3 py-2 text-left text-sm",
                    toneOf(it),
                  )}
                >
                  <span className="w-12 shrink-0 tabular-nums text-xs opacity-80">
                    {it.time ?? t("calendar.allDay")}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-medium",
                      it.task?.completed && "line-through",
                    )}
                  >
                    {it.title}
                  </span>
                  <span className="text-xs opacity-80">
                    {it.kind === "milestone"
                      ? t(`calendar.milestones.${it.type.replace("milestone_", "")}`)
                      : it.kind === "task"
                        ? (it.task?.assignee?.name ?? t("calendar.unassigned"))
                        : t(`calendar.types.${it.type}`)}
                    {it.project?.clientCode ? ` · ${it.project.clientCode}` : ""}
                    {it.isDayOff ? ` · ${t("calendar.dayOff")}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="text-xs text-muted-foreground">
        <Link to="/tarefas" className="hover:underline">
          {t("calendar.seeTasks")}
        </Link>
      </p>
    </div>
  );
}
