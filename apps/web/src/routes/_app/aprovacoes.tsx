/**
 * Ajustes de tempo (§6.3): quem tem time.approve vê a fila e decide; todos veem os próprios pedidos.
 * Tempo ajustado só entra nos relatórios depois de aprovado.
 */
import { Avatar, Badge, Button, Card, cn, EmptyState, Input, Skeleton } from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, ClipboardCheck, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import { TaskDrawer } from "../../components/work/task-drawer";
import { api, unwrap } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { adjustmentsQuery, formatDuration, type TimeAdjustment } from "../../lib/time";

const TABS = ["pending", "reviewed", "mine"] as const;

export const Route = createFileRoute("/_app/aprovacoes")({
  validateSearch: z.object({ tab: z.enum(TABS).optional(), task: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("time.track")) throw redirect({ to: "/" });
  },
  component: Approvals,
});

function Approvals() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/aprovacoes" });
  const me = useQuery(meQuery).data;
  const approver = !!me?.tenant?.permissions.includes("time.approve");
  const tabs = approver ? TABS : (["mine"] as const);
  const tab = approver ? (search.tab ?? "pending") : "mine";
  const q = useQuery(tab === "mine" ? adjustmentsQuery("all", true) : adjustmentsQuery(tab));
  const set = (p: { tab?: (typeof TABS)[number]; task?: string }) =>
    void navigate({ search: (s: typeof search) => ({ ...s, ...p }) });

  return (
    <>
      <PageHeader
        title={t("approvals.title")}
        description={approver ? t("approvals.subtitle") : t("approvals.subtitleMine")}
      />
      {tabs.length > 1 && (
        // biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância
        <div className="mb-4 flex gap-1 border-b" role="group" aria-label={t("approvals.title")}>
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm",
                tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground",
              )}
              onClick={() => set({ tab: k === "pending" ? undefined : k })}
            >
              {t(`approvals.tabs.${k}`)}
            </button>
          ))}
        </div>
      )}
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : !q.data?.data.length ? (
        <EmptyState
          icon={<ClipboardCheck className="size-6" />}
          title={t(`approvals.empty.${tab}`)}
          description={tab === "mine" ? t("approvals.emptyMineText") : undefined}
        />
      ) : (
        <div className="grid gap-3">
          {q.data.data.map((a) => (
            <AdjustmentCard
              key={a.id}
              a={a}
              canReview={
                approver &&
                a.status === "pending" &&
                (a.user.id !== me?.user.id || me?.tenant?.role === "admin")
              }
              onOpen={() => set({ task: a.task.id })}
            />
          ))}
        </div>
      )}
      <TaskDrawer taskId={search.task ?? null} onClose={() => set({ task: undefined })} />
    </>
  );
}

function AdjustmentCard({
  a,
  canReview,
  onOpen,
}: {
  a: TimeAdjustment;
  canReview: boolean;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const dt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const review = useMutation({
    mutationFn: (approve: boolean) =>
      unwrap(
        api.time.adjustments[":id"].review.$post({
          param: { id: a.id },
          json: { approve, note: note.trim() || null },
        }),
      ),
    onSuccess: (r) => {
      toast.success(r.status === "approved" ? t("approvals.approved") : t("approvals.rejected"));
      void qc.invalidateQueries({ queryKey: ["time"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const variant = a.status === "approved" ? "default" : a.status === "rejected" ? "destructive" : "secondary";
  return (
    <Card className="grid gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Avatar name={a.user.name} src={a.user.image} className="size-7" />
        <span className="font-medium">{a.user.name}</span>
        <span className="text-muted-foreground">·</span>
        <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={onOpen}>
          {a.task.project?.clientCode ? `${a.task.project.clientCode} · ` : ""}
          {a.task.title}
        </button>
        <Badge variant={variant} className="ml-auto">
          {t(`approvals.status.${a.status}`)}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {a.deltaMs != null ? (
          <span
            className={cn(
              "font-semibold tabular-nums",
              a.deltaMs < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400",
            )}
          >
            {a.deltaMs > 0 ? "+" : ""}
            {formatDuration(a.deltaMs)}
          </span>
        ) : (
          <>
            {a.entry && (
              <span className="text-muted-foreground line-through">
                {dt.format(new Date(a.entry.startedAt))} –{" "}
                {a.entry.endedAt ? dt.format(new Date(a.entry.endedAt)) : "…"} (
                {formatDuration(a.entry.businessMs)})
              </span>
            )}
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium">
              {dt.format(new Date(a.newStartedAt!))} – {dt.format(new Date(a.newEndedAt!))} (
              {formatDuration(a.newBusinessMs ?? 0)})
            </span>
          </>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{dt.format(new Date(a.createdAt))}</span>
      </div>
      <p className="text-sm">“{a.reason}”</p>
      {a.reviewer && (
        <p className="text-xs text-muted-foreground">
          {t("approvals.reviewedBy", { name: a.reviewer.name, when: dt.format(new Date(a.reviewedAt!)) })}
          {a.reviewNote ? `: “${a.reviewNote}”` : ""}
        </p>
      )}
      {canReview && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 min-w-48 flex-1"
            placeholder={t("approvals.notePlaceholder")}
            aria-label={t("approvals.note")}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button size="sm" disabled={review.isPending} onClick={() => review.mutate(true)}>
            <Check /> {t("approvals.approve")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={review.isPending}
            onClick={() => review.mutate(false)}
          >
            <X /> {t("approvals.reject")}
          </Button>
        </div>
      )}
    </Card>
  );
}
