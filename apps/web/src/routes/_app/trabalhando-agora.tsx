/**
 * Trabalhando agora (§6.8): quem está com "Estou nessa" ligado, em que tarefa e há quanto tempo
 * (horas úteis). Atualiza em tempo real por SSE; a aba Histórico mostra os registros por pessoa.
 */
import { Avatar, Badge, Card, cn, EmptyState, Input, Select, Skeleton } from "@recpm/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Activity, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import { useLookups } from "../../components/work/lookups";
import { TaskDrawer } from "../../components/work/task-drawer";
import { meQuery } from "../../lib/queries";
import {
  formatDuration,
  timeEntriesQuery,
  useTicking,
  type WorkingNow,
  workingNowQuery,
} from "../../lib/time";

const searchSchema = z.object({
  tab: z.enum(["now", "history"]).optional(),
  userId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  task: z.string().optional(),
});
type S = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/_app/trabalhando-agora")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("workingNow.view")) throw redirect({ to: "/" });
  },
  component: WorkingNowPage,
});

/** Assina o SSE e escreve cada instantâneo no cache da consulta. */
function useLiveWorkingNow() {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/v1/time/working-now/stream", { withCredentials: true });
    es.addEventListener("snapshot", (e) => {
      qc.setQueryData(workingNowQuery.queryKey, JSON.parse((e as MessageEvent).data) as WorkingNow);
      setLive(true);
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [qc]);
  return live;
}

function WorkingNowPage() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/trabalhando-agora" });
  const tab = search.tab ?? "now";
  const set = (patch: Partial<S>) => void navigate({ search: (s: S) => ({ ...s, ...patch }) });
  return (
    <>
      <PageHeader title={t("workingNow.title")} description={t("workingNow.subtitle")} />
      {/* biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância */}
      <div className="mb-4 flex gap-1 border-b" role="group" aria-label={t("workingNow.title")}>
        {(["now", "history"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={tab === k}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === k
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground",
            )}
            onClick={() => set({ tab: k === "now" ? undefined : k })}
          >
            {t(`workingNow.tabs.${k}`)}
          </button>
        ))}
      </div>
      {tab === "now" ? (
        <Now onOpen={(task) => set({ task })} />
      ) : (
        <History search={search} set={set} onOpen={(task) => set({ task })} />
      )}
      <TaskDrawer taskId={search.task ?? null} onClose={() => set({ task: undefined })} />
    </>
  );
}

function Now({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const live = useLiveWorkingNow();
  const q = useQuery({ ...workingNowQuery, refetchInterval: live ? false : 30_000 });
  const rel = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
  if (q.isPending) return <Skeleton className="h-64" />;
  if (!q.data) return null;
  const { working, idle } = q.data;
  const ago = (iso: string) => {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    return min < 60
      ? rel.format(-min, "minute")
      : min < 1440
        ? rel.format(-Math.round(min / 60), "hour")
        : rel.format(-Math.round(min / 1440), "day");
  };
  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Radio className={cn("size-4", live ? "text-emerald-500" : "text-muted-foreground")} aria-hidden />
        {live ? t("workingNow.live") : t("workingNow.polling")}
        <span className="ml-auto">{t("workingNow.count", { count: working.length })}</span>
      </div>
      {working.length === 0 ? (
        <EmptyState
          icon={<Activity className="size-6" />}
          title={t("workingNow.empty")}
          description={t("workingNow.emptyText")}
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("workingNow.person")}</th>
                <th className="px-3 py-2 font-medium">{t("workingNow.task")}</th>
                <th className="px-3 py-2 font-medium">{t("workingNow.elapsed")}</th>
                <th className="px-3 py-2 font-medium">{t("workingNow.started")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {working.map((w) => (
                <tr key={w.entryId}>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      <Avatar name={w.user.name} src={w.user.image} className="size-8" />
                      <span className="grid leading-tight">
                        <span className="font-medium">{w.user.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {[
                            w.jobTitle ?? t(`roles.${w.role}`),
                            w.employmentType && t(`members.employment.${w.employmentType}`),
                            w.sector,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="max-w-80 px-3 py-2.5">
                    <button
                      type="button"
                      className="block max-w-full truncate text-left font-medium hover:underline"
                      onClick={() => onOpen(w.task.id)}
                    >
                      {w.task.title}
                    </button>
                    {w.task.project && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {w.task.project.clientCode ? `${w.task.project.clientCode} · ` : ""}
                        {w.task.project.name}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Elapsed ms={w.businessMs} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">{ago(w.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {idle.length > 0 && (
        <section aria-labelledby="idle-h">
          <h2 id="idle-h" className="mb-2 text-sm font-semibold">
            {t("workingNow.idle", { count: idle.length })}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {idle.map((p) => (
              <li
                key={p.user.id}
                className="inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm"
              >
                <Avatar name={p.user.name} src={p.user.image} className="size-6" />
                {p.user.name}
                <span className="text-xs text-muted-foreground">
                  {p.lastEndedAt
                    ? t("workingNow.lastSeen", { when: ago(p.lastEndedAt) })
                    : t("workingNow.never")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Elapsed({ ms }: { ms: number }) {
  const v = useTicking(ms, true);
  return <span className="font-medium tabular-nums">{formatDuration(v ?? ms, { seconds: true })}</span>;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function History({
  search,
  set,
  onOpen,
}: {
  search: { userId?: string; from?: string; to?: string };
  set: (p: { userId?: string; from?: string; to?: string }) => void;
  onOpen: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const lk = useLookups({ projects: false });
  const me = useQuery(meQuery).data;
  const userId = search.userId ?? me?.user.id;
  const from = search.from ?? daysAgo(6);
  const to = search.to ?? today();
  const q = useQuery({ ...timeEntriesQuery({ userId, from, to }), enabled: !!userId });
  const dt = new Intl.DateTimeFormat(i18n.language, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const tm = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          className="w-56"
          aria-label={t("workingNow.person")}
          value={userId ?? ""}
          onChange={(e) => set({ userId: e.target.value })}
        >
          {lk.people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </Select>
        <Input
          type="date"
          className="w-40"
          aria-label={t("workingNow.from")}
          value={from}
          onChange={(e) => set({ from: e.target.value || undefined })}
        />
        <Input
          type="date"
          className="w-40"
          aria-label={t("workingNow.to")}
          value={to}
          onChange={(e) => set({ to: e.target.value || undefined })}
        />
        {q.data && (
          <span className="ml-auto text-sm">
            {t("workingNow.total")} <strong className="tabular-nums">{formatDuration(q.data.totalMs)}</strong>
          </span>
        )}
      </div>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : !q.data?.data.length ? (
        <p className="text-sm text-muted-foreground">{t("workingNow.noHistory")}</p>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("workingNow.when")}</th>
                <th className="px-3 py-2 font-medium">{t("workingNow.task")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("workingNow.business")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {q.data.data.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {dt.format(new Date(e.startedAt))} –{" "}
                    {e.endedAt ? tm.format(new Date(e.endedAt)) : t("time.running")}
                  </td>
                  <td className="max-w-96 px-3 py-2">
                    <button
                      type="button"
                      className="block max-w-full truncate text-left hover:underline"
                      onClick={() => onOpen(e.task.id)}
                    >
                      {e.task.title}
                    </button>
                    {e.task.project && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {e.task.project.clientCode ? `${e.task.project.clientCode} · ` : ""}
                        {e.task.project.name}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatDuration(e.businessMs)}
                    {e.statusAtStart === "ajustes" && (
                      <Badge variant="outline" className="ml-2">
                        {t("time.reworkShort")}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        <Link to="/aprovacoes" className="underline">
          {t("workingNow.adjustmentsLink")}
        </Link>
      </p>
    </div>
  );
}
