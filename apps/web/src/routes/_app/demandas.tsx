/**
 * Fila de demandas abertas pelos clientes no portal (§6.11). Aceitar cria a tarefa em
 * "Demandas" (conta na cota do plano); recusar pede um motivo, que o cliente vê.
 */
import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Check, Inbox, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import { TaskDrawer } from "../../components/work/task-drawer";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { demandsQuery, type TeamDemand } from "../../lib/portal";
import { membersQuery, meQuery } from "../../lib/queries";

const TABS = ["pending", "accepted", "rejected"] as const;

export const Route = createFileRoute("/_app/demandas")({
  validateSearch: z.object({
    tab: z.enum(TABS).optional(),
    d: z.string().optional(),
    task: z.string().optional(),
  }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("tasks.create")) throw redirect({ to: "/" });
  },
  component: Demands,
});

function Demands() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/demandas" });
  const tab = search.tab ?? "pending";
  const q = useQuery(demandsQuery(tab));
  const [accepting, setAccepting] = useState<TeamDemand | null>(null);
  const [rejecting, setRejecting] = useState<TeamDemand | null>(null);
  const set = (p: Partial<typeof search>) =>
    void navigate({ search: (s: typeof search) => ({ ...s, ...p }) });
  return (
    <>
      <PageHeader title={t("demands.title")} description={t("demands.subtitle")} />
      {/* biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância */}
      <div className="mb-4 flex gap-1 overflow-x-auto border-b" role="group" aria-label={t("demands.title")}>
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={tab === k}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm",
              tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground",
            )}
            onClick={() => set({ tab: k === "pending" ? undefined : k })}
          >
            {t(`demands.tabs.${k}`)}
            {k === "pending" && q.data && q.data.pending > 0 && (
              <Badge className="ml-2 h-5 px-1.5">{q.data.pending}</Badge>
            )}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : !q.data?.data.length ? (
        <EmptyState icon={<Inbox className="size-6" />} title={t(`demands.empty.${tab}`)} />
      ) : (
        <div className="grid gap-3">
          {q.data.data.map((d) => (
            <DemandCard
              key={d.id}
              d={d}
              highlight={search.d === d.id}
              onAccept={() => setAccepting(d)}
              onReject={() => setRejecting(d)}
              onOpenTask={() => d.taskId && set({ task: d.taskId })}
            />
          ))}
        </div>
      )}
      <AcceptDialog
        d={accepting}
        onClose={() => setAccepting(null)}
        onDone={(taskId) => set({ task: taskId })}
      />
      <RejectDialog d={rejecting} onClose={() => setRejecting(null)} />
      <TaskDrawer taskId={search.task ?? null} onClose={() => set({ task: undefined })} />
    </>
  );
}

function DemandCard({
  d,
  highlight,
  onAccept,
  onReject,
  onOpenTask,
}: {
  d: TeamDemand;
  highlight: boolean;
  onAccept: () => void;
  onReject: () => void;
  onOpenTask: () => void;
}) {
  const { t, i18n } = useTranslation();
  const dt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  return (
    <Card className={cn("grid gap-3 p-4", highlight && "ring-2 ring-primary")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{d.client.code}</Badge>
        <span className="min-w-0 flex-1 font-medium">{d.title}</span>
        <span className="text-xs text-muted-foreground">{dt.format(new Date(d.createdAt))}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {[
          d.client.name,
          d.requestedBy && t("demands.by", { name: d.requestedBy }),
          d.project?.name ?? t("demands.noProject"),
          d.desiredDate && t("demands.desired", { date: df.format(new Date(`${d.desiredDate}T12:00:00Z`)) }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {d.description && <p className="whitespace-pre-wrap text-sm">{d.description}</p>}
      {d.briefing && (
        <div className="grid gap-1 rounded-md border bg-muted/40 p-3 text-sm">
          <span className="text-xs font-medium text-muted-foreground">
            {t("demands.briefing", { form: d.briefing.form })}
          </span>
          <dl className="grid gap-1">
            {d.briefing.answers.map((a) => (
              <div key={a.label} className="grid gap-0.5 sm:grid-cols-[180px_1fr] sm:gap-2">
                <dt className="text-muted-foreground">{a.label}</dt>
                <dd className="whitespace-pre-wrap break-words">{a.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {d.status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onAccept}>
            <Check /> {t("demands.accept")}
          </Button>
          <Button size="sm" variant="outline" onClick={onReject}>
            <X /> {t("demands.reject")}
          </Button>
        </div>
      ) : d.status === "accepted" ? (
        <Button size="sm" variant="link" className="w-fit px-0" onClick={onOpenTask}>
          {t("demands.openTask")}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("demands.rejectedReason")}: {d.rejectionReason}
        </p>
      )}
    </Card>
  );
}

function AcceptDialog({
  d,
  onClose,
  onDone,
}: {
  d: TeamDemand | null;
  onClose: () => void;
  onDone: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const team = useQuery({ ...membersQuery("team"), enabled: !!d }).data;
  const [assignee, setAssignee] = useState("");
  const [deadline, setDeadline] = useState("");
  const accept = useMutation({
    mutationFn: () =>
      unwrap(
        api.demands[":id"].accept.$post({
          param: { id: d!.id },
          json: {
            assigneeId: assignee || null,
            deadline: deadline ? new Date(deadline).toISOString() : null,
          },
        }),
      ),
    onSuccess: (r) => {
      toast.success(t("demands.accepted"));
      void qc.invalidateQueries({ queryKey: ["demands"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      setAssignee("");
      setDeadline("");
      onClose();
      onDone(r.taskId);
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const people = (team?.data ?? []).filter((m) => m.active);
  return (
    <Dialog open={!!d} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            accept.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("demands.acceptTitle")}</DialogTitle>
            <DialogDescription>{t("demands.acceptHelp")}</DialogDescription>
          </DialogHeader>
          <Field id="ac-assignee" label={t("demands.assignee")}>
            <Select id="ac-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">{t("demands.noAssignee")}</option>
              {people.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ac-deadline" label={t("demands.deadline")}>
            <Input
              id="ac-deadline"
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={accept.isPending}>
              {t("demands.accept")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ d, onClose }: { d: TeamDemand | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const reject = useMutation({
    mutationFn: () =>
      unwrapVoid(api.demands[":id"].reject.$post({ param: { id: d!.id }, json: { reason: reason.trim() } })),
    onSuccess: () => {
      toast.success(t("demands.rejected"));
      void qc.invalidateQueries({ queryKey: ["demands"] });
      setReason("");
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open={!!d} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            reject.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("demands.rejectTitle")}</DialogTitle>
            <DialogDescription>{t("demands.rejectHelp")}</DialogDescription>
          </DialogHeader>
          <Field id="rj-reason" label={t("demands.reason")}>
            <textarea
              id="rj-reason"
              required
              maxLength={1000}
              className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={!reason.trim() || reject.isPending}>
              {t("demands.reject")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
