import { SIMPLE_CATALOGS, type SimpleCatalog } from "@recpm/shared";
import {
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
import { type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { ClipboardList, Copy, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { ColorInput, ConfirmDialog, textareaClass } from "../../components/confirm-dialog";
import { PageHeader } from "../../components/page-header";
import { SortableList } from "../../components/sortable-list";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import {
  briefingFormsQuery,
  type CatalogItem,
  catalogQuery,
  type KanbanColumn,
  kanbanColumnsQuery,
  type TaskType,
  taskTypesQuery,
} from "../../lib/catalogs";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";

const TABS = ["task-types", "kanban-columns", ...SIMPLE_CATALOGS, "briefings"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/cadastros/")({
  validateSearch: z.object({ tab: z.enum(TABS).default("task-types") }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("catalogs.manage")) throw redirect({ to: "/" });
  },
  component: Catalogs,
});

function Catalogs() {
  const { t } = useTranslation();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: "/cadastros/" });
  return (
    <>
      <PageHeader title={t("catalogs.title")} description={t("catalogs.subtitle")} />
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <Select
          className="md:hidden"
          aria-label={t("catalogs.section")}
          value={tab}
          onChange={(e) => void navigate({ search: { tab: e.target.value as Tab } })}
        >
          {TABS.map((k) => (
            <option key={k} value={k}>
              {t(`catalogs.tabs.${k}`)}
            </option>
          ))}
        </Select>
        <nav aria-label={t("catalogs.section")} className="hidden flex-col gap-0.5 md:flex">
          {TABS.map((k) => (
            <Link
              key={k}
              to="/cadastros"
              search={{ tab: k }}
              className={cn(
                "rounded-md px-3 py-2 text-sm hover:bg-accent",
                tab === k ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {t(`catalogs.tabs.${k}`)}
            </Link>
          ))}
        </nav>
        <section className="min-w-0">
          <header className="mb-4">
            <h2 className="text-lg font-semibold">{t(`catalogs.tabs.${tab}`)}</h2>
            <p className="text-sm text-muted-foreground">{t(`catalogs.help.${tab}`)}</p>
          </header>
          {tab === "task-types" ? (
            <TaskTypesPanel />
          ) : tab === "kanban-columns" ? (
            <ColumnsPanel />
          ) : tab === "briefings" ? (
            <BriefingsPanel />
          ) : (
            <SimplePanel key={tab} kind={tab} />
          )}
        </section>
      </div>
    </>
  );
}

// ── Peças comuns ──────────────────────────────────────────────────────────────

function Swatch({ color, emoji }: { color: string | null; emoji?: string | null }) {
  if (emoji) return <span className="w-5 text-center text-base leading-none">{emoji}</span>;
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-full border"
      style={{ background: color ?? "transparent" }}
    />
  );
}

/** Reordenação otimista: aplica no cache já e desfaz se a API recusar. */
function useReorder(key: QueryKey, send: (ids: string[]) => Promise<void>) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: send,
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ data: { id: string; position: number }[] }>(key);
      if (prev)
        qc.setQueryData(key, {
          ...prev,
          data: ids.map((id, position) => ({ ...prev.data.find((i) => i.id === id)!, position })),
        });
      return { prev };
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(errorMessage(t, e));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

function RowMenu({
  label,
  active,
  canToggle = true,
  canDelete = true,
  onEdit,
  onToggle,
  onDelete,
}: {
  label: string;
  active: boolean;
  canToggle?: boolean;
  canDelete?: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("catalogs.actionsFor", { name: label })}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>{t("common.edit")}</DropdownMenuItem>
        {canToggle && (
          <DropdownMenuItem onSelect={onToggle}>
            {active ? t("catalogs.deactivate") : t("catalogs.activate")}
          </DropdownMenuItem>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={onDelete}>
              {t("common.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ListSkeleton() {
  return (
    <Card className="grid gap-2 p-4">
      <Skeleton className="h-9" />
      <Skeleton className="h-9" />
      <Skeleton className="h-9" />
    </Card>
  );
}

// ── Catálogos simples ─────────────────────────────────────────────────────────

function SimplePanel({ kind }: { kind: SimpleCatalog }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = catalogQuery(kind);
  const { data, isPending } = useQuery(q);
  const [editing, setEditing] = useState<CatalogItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<CatalogItem | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: q.queryKey });

  const reorder = useReorder(q.queryKey, (ids) =>
    unwrapVoid(api.catalogs[":kind"].order.$put({ param: { kind }, json: { ids } })),
  );
  const toggle = useMutation({
    mutationFn: (i: CatalogItem) =>
      unwrap(api.catalogs[":kind"][":id"].$patch({ param: { kind, id: i.id }, json: { active: !i.active } })),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const remove = useMutation({
    mutationFn: (i: CatalogItem) =>
      unwrapVoid(api.catalogs[":kind"][":id"].$delete({ param: { kind, id: i.id } })),
    onSuccess: () => {
      toast.success(t("catalogs.deleted"));
      setDeleting(null);
      return refresh();
    },
    onError: (e) => {
      setDeleting(null);
      toast.error(errorMessage(t, e));
    },
  });

  if (isPending) return <ListSkeleton />;
  const items = data?.data ?? [];
  return (
    <div className="grid gap-3">
      <div>
        <Button onClick={() => setEditing("new")}>
          <Plus /> {t("catalogs.add")}
        </Button>
      </div>
      {items.length ? (
        <Card className="overflow-hidden">
          <SortableList
            items={items}
            itemLabel={(i) => i.label}
            onReorder={(ids) => reorder.mutate(ids)}
            renderItem={(i) => (
              <div className="flex items-center gap-3">
                <Swatch color={i.color} />
                <span className={cn("flex-1 truncate", !i.active && "text-muted-foreground line-through")}>
                  {i.label}
                </span>
                {!i.active && <Badge variant="secondary">{t("catalogs.inactive")}</Badge>}
                <RowMenu
                  label={i.label}
                  active={i.active}
                  onEdit={() => setEditing(i)}
                  onToggle={() => toggle.mutate(i)}
                  onDelete={() => setDeleting(i)}
                />
              </div>
            )}
          />
        </Card>
      ) : (
        <EmptyState title={t("catalogs.empty")} description={t(`catalogs.help.${kind}`)} />
      )}
      {editing && (
        <SimpleItemDialog
          kind={kind}
          item={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t("catalogs.deleteTitle", { name: deleting?.label })}
        description={t("catalogs.deleteText")}
        confirmLabel={t("common.delete")}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function SimpleItemDialog({
  kind,
  item,
  onClose,
}: {
  kind: SimpleCatalog;
  item: CatalogItem | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [label, setLabel] = useState(item?.label ?? "");
  const [color, setColor] = useState<string | null>(item?.color ?? null);
  const save = useMutation({
    mutationFn: () =>
      item
        ? unwrap(
            api.catalogs[":kind"][":id"].$patch({ param: { kind, id: item.id }, json: { label, color } }),
          )
        : unwrap(api.catalogs[":kind"].$post({ param: { kind }, json: { label, color } })),
    onSuccess: async () => {
      toast.success(t("catalogs.saved"));
      onClose();
      await qc.invalidateQueries({ queryKey: ["catalogs", kind] });
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>
            {item ? t("catalogs.editTitle") : t("catalogs.newTitle", { kind: t(`catalogs.tabs.${kind}`) })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(t, save.error)}
            </p>
          ) : null}
          <Field id="c-label" label={t("common.name")}>
            <Input
              id="c-label"
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
            />
          </Field>
          <Field id="c-color" label={t("catalogs.color")}>
            <ColorInput id="c-color" value={color} onChange={setColor} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !label.trim()}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Tipos de tarefa ───────────────────────────────────────────────────────────

function TaskTypesPanel() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data, isPending } = useQuery(taskTypesQuery);
  const cats = useQuery(catalogQuery("report-categories"));
  const [editing, setEditing] = useState<TaskType | "new" | null>(null);
  const [deleting, setDeleting] = useState<TaskType | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: taskTypesQuery.queryKey });
  const reorder = useReorder(taskTypesQuery.queryKey, (ids) =>
    unwrapVoid(api.catalogs["task-types"].order.$put({ json: { ids } })),
  );
  const toggle = useMutation({
    mutationFn: (i: TaskType) =>
      unwrap(api.catalogs["task-types"][":id"].$patch({ param: { id: i.id }, json: { active: !i.active } })),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const remove = useMutation({
    mutationFn: (i: TaskType) =>
      unwrapVoid(api.catalogs["task-types"][":id"].$delete({ param: { id: i.id } })),
    onSuccess: () => {
      toast.success(t("catalogs.deleted"));
      setDeleting(null);
      return refresh();
    },
    onError: (e) => {
      setDeleting(null);
      toast.error(errorMessage(t, e));
    },
  });
  const catName = (id: string | null) =>
    cats.data?.data.find((c) => c.id === id)?.label ?? t("catalogs.otherCategory");
  const hours = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 });

  if (isPending) return <ListSkeleton />;
  return (
    <div className="grid gap-3">
      <div>
        <Button onClick={() => setEditing("new")}>
          <Plus /> {t("catalogs.add")}
        </Button>
      </div>
      <Card className="overflow-hidden">
        <SortableList
          items={data?.data ?? []}
          itemLabel={(i) => i.label}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(i) => (
            <div className="flex items-center gap-3">
              <Swatch color={i.color} />
              <div className="grid min-w-0 flex-1">
                <span className={cn("truncate", !i.active && "text-muted-foreground line-through")}>
                  {i.label}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {catName(i.reportCategoryId)}
                  {i.defaultEstimatedHours !== null &&
                    ` · ${t("catalogs.taskType.hoursShort", { h: hours.format(i.defaultEstimatedHours) })}`}
                  {i.checklist.length
                    ? ` · ${t("catalogs.taskType.checklistCount", { count: i.checklist.length })}`
                    : ""}
                </span>
              </div>
              <div className="hidden gap-1 sm:flex">
                {i.countsAsPiece && <Badge variant="outline">{t("catalogs.taskType.piece")}</Badge>}
                {i.sellable && <Badge variant="outline">{t("catalogs.taskType.sellable2")}</Badge>}
                {!i.usableAsType && <Badge variant="secondary">{t("catalogs.taskType.notUsable")}</Badge>}
              </div>
              {!i.active && <Badge variant="secondary">{t("catalogs.inactive")}</Badge>}
              <RowMenu
                label={i.label}
                active={i.active}
                onEdit={() => setEditing(i)}
                onToggle={() => toggle.mutate(i)}
                onDelete={() => setDeleting(i)}
              />
            </div>
          )}
        />
      </Card>
      {editing && (
        <TaskTypeDialog
          item={editing === "new" ? null : editing}
          categories={cats.data?.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t("catalogs.deleteTitle", { name: deleting?.label })}
        description={t("catalogs.deleteText")}
        confirmLabel={t("common.delete")}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function TaskTypeDialog({
  item,
  categories,
  onClose,
}: {
  item: TaskType | null;
  categories: CatalogItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({
    label: item?.label ?? "",
    color: item?.color ?? null,
    hours: item?.defaultEstimatedHours?.toString().replace(".", ",") ?? "",
    reportCategoryId: item?.reportCategoryId ?? "",
    sellable: item?.sellable ?? true,
    usableAsType: item?.usableAsType ?? true,
    countsAsPiece: item?.countsAsPiece ?? true,
    checklist: item?.checklist.join("\n") ?? "",
  });
  const json = () => ({
    label: f.label,
    color: f.color,
    defaultEstimatedHours: f.hours.trim() ? Number(f.hours.replace(",", ".")) : null,
    reportCategoryId: f.reportCategoryId || null,
    sellable: f.sellable,
    usableAsType: f.usableAsType,
    countsAsPiece: f.countsAsPiece,
    checklist: f.checklist
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  });
  const save = useMutation({
    mutationFn: () =>
      item
        ? unwrap(api.catalogs["task-types"][":id"].$patch({ param: { id: item.id }, json: json() }))
        : unwrap(api.catalogs["task-types"].$post({ json: json() })),
    onSuccess: async () => {
      toast.success(t("catalogs.saved"));
      onClose();
      await qc.invalidateQueries({ queryKey: taskTypesQuery.queryKey });
    },
  });
  const flags = ["countsAsPiece", "sellable", "usableAsType"] as const;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")} className="max-h-[90dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {item ? t("catalogs.editTitle") : t("catalogs.newTitle", { kind: t("catalogs.tabs.task-types") })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(t, save.error)}
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="tt-label" label={t("common.name")}>
              <Input
                id="tt-label"
                autoFocus
                value={f.label}
                onChange={(e) => setF({ ...f, label: e.target.value })}
              />
            </Field>
            <Field id="tt-hours" label={t("catalogs.taskType.hours")}>
              <Input
                id="tt-hours"
                inputMode="decimal"
                value={f.hours}
                onChange={(e) => setF({ ...f, hours: e.target.value })}
              />
            </Field>
            <Field
              id="tt-cat"
              label={t("catalogs.taskType.category")}
              hint={t("catalogs.taskType.categoryHint")}
            >
              <Select
                id="tt-cat"
                value={f.reportCategoryId}
                onChange={(e) => setF({ ...f, reportCategoryId: e.target.value })}
              >
                <option value="">{t("catalogs.otherCategory")}</option>
                {categories
                  .filter((c) => c.active || c.id === f.reportCategoryId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field id="tt-color" label={t("catalogs.color")}>
              <ColorInput id="tt-color" value={f.color} onChange={(color) => setF({ ...f, color })} />
            </Field>
          </div>
          <fieldset className="grid gap-2">
            <legend className="sr-only">{t("catalogs.taskType.flags")}</legend>
            {flags.map((k) => (
              <label key={k} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={f[k]}
                  onChange={(e) => setF({ ...f, [k]: e.target.checked })}
                />
                <span>
                  {t(`catalogs.taskType.${k}`)}
                  <span className="block text-xs text-muted-foreground">
                    {t(`catalogs.taskType.${k}Hint`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <Field
            id="tt-checklist"
            label={t("catalogs.taskType.checklist")}
            hint={t("catalogs.taskType.checklistHint")}
          >
            <textarea
              id="tt-checklist"
              rows={5}
              className={textareaClass}
              value={f.checklist}
              onChange={(e) => setF({ ...f, checklist: e.target.value })}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !f.label.trim()}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Colunas do Kanban ─────────────────────────────────────────────────────────

function ColumnsPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isPending } = useQuery(kanbanColumnsQuery);
  const [editing, setEditing] = useState<KanbanColumn | "new" | null>(null);
  const [deleting, setDeleting] = useState<KanbanColumn | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: kanbanColumnsQuery.queryKey });
  const reorder = useReorder(kanbanColumnsQuery.queryKey, (ids) =>
    unwrapVoid(api.catalogs["kanban-columns"].order.$put({ json: { ids } })),
  );
  const toggle = useMutation({
    mutationFn: (c: KanbanColumn) =>
      unwrap(
        api.catalogs["kanban-columns"][":id"].$patch({ param: { id: c.id }, json: { active: !c.active } }),
      ),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const remove = useMutation({
    mutationFn: (c: KanbanColumn) =>
      unwrapVoid(api.catalogs["kanban-columns"][":id"].$delete({ param: { id: c.id } })),
    onSuccess: () => {
      toast.success(t("catalogs.deleted"));
      setDeleting(null);
      return refresh();
    },
    onError: (e) => {
      setDeleting(null);
      toast.error(errorMessage(t, e));
    },
  });
  if (isPending) return <ListSkeleton />;
  return (
    <div className="grid gap-3">
      <div>
        <Button onClick={() => setEditing("new")}>
          <Plus /> {t("catalogs.column.add")}
        </Button>
      </div>
      <Card className="overflow-hidden">
        <SortableList
          items={data?.data ?? []}
          itemLabel={(c) => c.label}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(c) => {
            const locked = c.system || c.isFinal;
            return (
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-6 w-1 rounded-full"
                  style={{ background: c.color ?? "var(--border)" }}
                />
                <Swatch color={c.color} emoji={c.emoji} />
                <div className="grid min-w-0 flex-1">
                  <span className={cn("truncate", !c.active && "text-muted-foreground line-through")}>
                    {c.label}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {c.key} · {t("catalogs.column.tasks", { count: c.taskCount })}
                  </span>
                </div>
                <div className="hidden gap-1 sm:flex">
                  {c.isApproval && <Badge>{t("catalogs.column.approval")}</Badge>}
                  {c.isFinal && <Badge variant="success">{t("catalogs.column.final")}</Badge>}
                  {c.system && <Badge variant="outline">{t("catalogs.column.system")}</Badge>}
                </div>
                {!c.active && <Badge variant="secondary">{t("catalogs.inactive")}</Badge>}
                <RowMenu
                  label={c.label}
                  active={c.active}
                  canToggle={!locked}
                  canDelete={!locked}
                  onEdit={() => setEditing(c)}
                  onToggle={() => toggle.mutate(c)}
                  onDelete={() => setDeleting(c)}
                />
              </div>
            );
          }}
        />
      </Card>
      {editing && (
        <ColumnDialog column={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t("catalogs.deleteTitle", { name: deleting?.label })}
        description={t("catalogs.column.deleteText")}
        confirmLabel={t("common.delete")}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function ColumnDialog({ column, onClose }: { column: KanbanColumn | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({
    label: column?.label ?? "",
    emoji: column?.emoji ?? "",
    color: column?.color ?? null,
    isApproval: column?.isApproval ?? false,
    isFinal: column?.isFinal ?? false,
  });
  const json = () => ({ ...f, emoji: f.emoji.trim() || null });
  const save = useMutation({
    mutationFn: () =>
      column
        ? unwrap(api.catalogs["kanban-columns"][":id"].$patch({ param: { id: column.id }, json: json() }))
        : unwrap(api.catalogs["kanban-columns"].$post({ json: json() })),
    onSuccess: async () => {
      toast.success(t("catalogs.saved"));
      onClose();
      await qc.invalidateQueries({ queryKey: kanbanColumnsQuery.queryKey });
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{column ? t("catalogs.editTitle") : t("catalogs.column.add")}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(t, save.error)}
            </p>
          ) : null}
          <div className="grid grid-cols-[1fr_88px] gap-3">
            <Field id="col-label" label={t("common.name")}>
              <Input
                id="col-label"
                autoFocus
                value={f.label}
                onChange={(e) => setF({ ...f, label: e.target.value })}
              />
            </Field>
            <Field id="col-emoji" label={t("catalogs.column.emoji")}>
              <Input
                id="col-emoji"
                value={f.emoji}
                maxLength={8}
                onChange={(e) => setF({ ...f, emoji: e.target.value })}
              />
            </Field>
          </div>
          {column && (
            <p className="text-xs text-muted-foreground">
              {t("catalogs.column.keyFixed", { key: column.key })}
            </p>
          )}
          <Field id="col-color" label={t("catalogs.color")}>
            <ColorInput id="col-color" value={f.color} onChange={(color) => setF({ ...f, color })} />
          </Field>
          {(["isApproval", "isFinal"] as const).map((k) => (
            <label key={k} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={f[k]}
                disabled={k === "isFinal" && column?.isFinal}
                onChange={(e) => setF({ ...f, [k]: e.target.checked })}
              />
              <span>
                {t(`catalogs.column.${k}`)}
                <span className="block text-xs text-muted-foreground">{t(`catalogs.column.${k}Hint`)}</span>
              </span>
            </label>
          ))}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !f.label.trim()}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Formulários de briefing ───────────────────────────────────────────────────

function BriefingsPanel() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isPending } = useQuery(briefingFormsQuery);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: briefingFormsQuery.queryKey });
  const duplicate = useMutation({
    mutationFn: (id: string) => unwrap(api["briefing-forms"][":id"].duplicate.$post({ param: { id } })),
    onSuccess: (f) => {
      toast.success(t("catalogs.briefing.duplicated", { name: f.name }));
      return refresh();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrapVoid(api["briefing-forms"][":id"].$delete({ param: { id } })),
    onSuccess: () => {
      toast.success(t("catalogs.deleted"));
      setDeleting(null);
      return refresh();
    },
  });
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short" });
  if (isPending) return <ListSkeleton />;
  return (
    <div className="grid gap-3">
      <div>
        <Button asChild>
          <Link to="/cadastros/briefings/$id" params={{ id: "novo" }}>
            <Plus /> {t("catalogs.briefing.new")}
          </Link>
        </Button>
      </div>
      {data?.data.length ? (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {data.data.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-3">
                <ClipboardList className="size-4 text-muted-foreground" />
                <Link
                  to="/cadastros/briefings/$id"
                  params={{ id: f.id }}
                  className="grid min-w-0 flex-1 hover:underline"
                >
                  <span className="truncate font-medium">{f.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t("catalogs.briefing.fields", { count: f.fieldCount })} ·{" "}
                    {t("catalogs.briefing.updated", { date: date.format(new Date(f.updatedAt)) })}
                  </span>
                </Link>
                {!f.active && <Badge variant="secondary">{t("catalogs.inactive")}</Badge>}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("catalogs.actionsFor", { name: f.name })}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => void navigate({ to: "/cadastros/briefings/$id", params: { id: f.id } })}
                    >
                      {t("common.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => duplicate.mutate(f.id)}>
                      <Copy /> {t("catalogs.briefing.duplicate")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(f)}>
                      {t("common.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState title={t("catalogs.briefing.empty")} description={t("catalogs.help.briefings")} />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t("catalogs.deleteTitle", { name: deleting?.name })}
        description={t("catalogs.briefing.deleteText")}
        confirmLabel={t("common.delete")}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
