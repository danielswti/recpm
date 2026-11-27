/**
 * Abas de Configurações da Fase 9: webhooks de saída (§6.13, plano Enterprise) e exportação de
 * dados (§6.14: exportar agora, agenda a cada N dias, lista de downloads e aviso por webhook).
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
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, FileArchive, Plus, RotateCw, Send, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useUpgradeModal } from "../../lib/upgrade-modal";
import { ConfirmDialog } from "../confirm-dialog";

const webhooksQuery = queryOptions({
  queryKey: ["settings", "webhooks"],
  queryFn: () => unwrap(api.settings.webhooks.$get()),
});
const deliveriesQuery = (id: string) =>
  queryOptions({
    queryKey: ["settings", "webhooks", id, "deliveries"],
    queryFn: () => unwrap(api.settings.webhooks[":id"].deliveries.$get({ param: { id } })),
    refetchInterval: 5000,
  });
const backupQuery = queryOptions({
  queryKey: ["settings", "backup"],
  queryFn: () => unwrap(api.settings.backup.$get()),
});
const exportsQuery = queryOptions({
  queryKey: ["exports"],
  queryFn: () => unwrap(api.exports.$get()),
  refetchInterval: (q) =>
    q.state.data?.data.some((e) => e.status === "pending" || e.status === "running") ? 3000 : false,
});
type Hook = Awaited<ReturnType<NonNullable<typeof webhooksQuery.queryFn>>>["data"][number];

const statusVariant = (s: string) =>
  s === "succeeded" ? "default" : s === "failed" ? "destructive" : ("secondary" as const);

export function WebhooksTab() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(webhooksQuery);
  const [editing, setEditing] = useState<Hook | "new" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Hook | null>(null);
  const [log, setLog] = useState<Hook | null>(null);
  const dt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["settings", "webhooks"] });
  const toggle = useMutation({
    mutationFn: (h: Hook) =>
      unwrap(api.settings.webhooks[":id"].$patch({ param: { id: h.id }, json: { active: !h.active } })),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const test = useMutation({
    mutationFn: (id: string) => unwrap(api.settings.webhooks[":id"].test.$post({ param: { id } })),
    onSuccess: () => {
      toast.success(t("settings.webhooks.testSent"));
      setTimeout(refresh, 1500);
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => unwrapVoid(api.settings.webhooks[":id"].$delete({ param: { id } })),
    onSuccess: () => {
      setRemoving(null);
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  if (q.isPending) return <Skeleton className="h-32" />;
  if (!q.data) return <p className="text-destructive">{errorMessage(t, q.error)}</p>;
  const { data, available, events } = q.data;
  return (
    <div className="grid gap-4">
      {!available && (
        <Card className="flex flex-wrap items-center gap-3 border-primary/40 p-4">
          <p className="min-w-0 flex-1 text-sm">{t("settings.webhooks.enterpriseOnly")}</p>
          <Button size="sm" onClick={() => useUpgradeModal.getState().open("FEATURE_NOT_IN_PLAN")}>
            {t("settings.webhooks.upgrade")}
          </Button>
        </Card>
      )}
      <div>
        <Button disabled={!available} onClick={() => setEditing("new")}>
          <Plus /> {t("settings.webhooks.new")}
        </Button>
      </div>
      {!data.length ? (
        <EmptyState
          icon={<Webhook className="size-6" />}
          title={t("settings.webhooks.empty")}
          description={t("settings.webhooks.emptyText")}
        />
      ) : (
        <div className="grid gap-3">
          {data.map((h) => (
            <Card key={h.id} className="grid gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all text-sm">{h.url}</code>
                <Badge variant={h.active ? "default" : "outline"}>
                  {h.active ? t("settings.webhooks.active") : t("settings.webhooks.paused")}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-1">
                {h.events.map((e) => (
                  <Badge key={e} variant="secondary" className="font-mono text-[11px]">
                    {e}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {h.lastDelivery
                  ? t("settings.webhooks.last", {
                      status: t(`settings.webhooks.status.${h.lastDelivery.status}`),
                      when: dt.format(new Date(h.lastDelivery.at)),
                      code: h.lastDelivery.responseStatus ?? "—",
                    })
                  : t("settings.webhooks.never")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!h.active || test.isPending}
                  onClick={() => test.mutate(h.id)}
                >
                  <Send /> {t("settings.webhooks.test")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setLog(h)}>
                  {t("settings.webhooks.deliveries")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(h)}>
                  {t("common.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate(h)}
                >
                  {h.active ? t("settings.webhooks.pause") : t("settings.webhooks.resume")}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="ml-auto size-8"
                  aria-label={t("common.delete")}
                  onClick={() => setRemoving(h)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("settings.webhooks.note")}</p>

      <HookDialog
        hook={editing}
        events={events}
        onClose={() => setEditing(null)}
        onCreated={(s) => setSecret(s)}
      />
      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("settings.webhooks.secretTitle")}</DialogTitle>
            <DialogDescription>{t("settings.webhooks.secretHelp")}</DialogDescription>
          </DialogHeader>
          <code className="break-all rounded-md border bg-muted p-3 text-xs">{secret}</code>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(secret ?? "");
                toast.success(t("common.copied"));
              }}
            >
              <Copy /> {t("common.copy")}
            </Button>
            <Button onClick={() => setSecret(null)}>{t("settings.apiKeys.done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeliveriesDialog hook={log} onClose={() => setLog(null)} />
      <ConfirmDialog
        open={!!removing}
        title={t("settings.webhooks.deleteTitle")}
        description={t("settings.webhooks.deleteText", { url: removing?.url ?? "" })}
        confirmLabel={t("common.delete")}
        pending={del.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && del.mutate(removing.id)}
      />
    </div>
  );
}

type HookEvent = Hook["events"][number];

function HookDialog({
  hook,
  events,
  onClose,
  onCreated,
}: {
  hook: Hook | "new" | null;
  events: string[];
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const editing = hook && hook !== "new" ? hook : null;
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<HookEvent[]>([]);
  const [lastOpen, setLastOpen] = useState<typeof hook>(null);
  if (hook !== lastOpen) {
    setLastOpen(hook);
    setUrl(editing?.url ?? "");
    setPicked(editing?.events ?? (events as HookEvent[]));
  }
  const save = useMutation({
    mutationFn: async () => {
      if (editing) {
        await unwrap(
          api.settings.webhooks[":id"].$patch({
            param: { id: editing.id },
            json: { url: url.trim(), events: picked },
          }),
        );
        return null;
      }
      return (await unwrap(api.settings.webhooks.$post({ json: { url: url.trim(), events: picked } })))
        .secret;
    },
    onSuccess: (secret) => {
      void qc.invalidateQueries({ queryKey: ["settings", "webhooks"] });
      onClose();
      if (secret) onCreated(secret);
      else toast.success(t("settings.saved"));
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open={!!hook} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? t("settings.webhooks.edit") : t("settings.webhooks.new")}</DialogTitle>
            <DialogDescription>{t("settings.webhooks.urlHelp")}</DialogDescription>
          </DialogHeader>
          <Field id="wh-url" label="URL">
            <Input
              id="wh-url"
              type="url"
              required
              placeholder="https://"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-sm font-medium">{t("settings.webhooks.events")}</legend>
            {events.map((ev) => (
              <label key={ev} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.includes(ev as HookEvent)}
                  onChange={(e) =>
                    setPicked((p) => (e.target.checked ? [...p, ev as HookEvent] : p.filter((x) => x !== ev)))
                  }
                />
                <code className="text-xs">{ev}</code>
                <span className="text-muted-foreground">
                  {t(`settings.webhooks.eventNames.${ev.replace(".", "_")}`)}
                </span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !picked.length}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeliveriesDialog({ hook, onClose }: { hook: Hook | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ ...deliveriesQuery(hook?.id ?? ""), enabled: !!hook });
  const dt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "medium" });
  const retry = useMutation({
    mutationFn: (deliveryId: string) =>
      unwrap(
        api.settings.webhooks[":id"].deliveries[":deliveryId"].retry.$post({
          param: { id: hook!.id, deliveryId },
        }),
      ),
    onSuccess: () => {
      toast.success(t("settings.webhooks.retrying"));
      void qc.invalidateQueries({ queryKey: ["settings", "webhooks"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open={!!hook} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings.webhooks.deliveries")}</DialogTitle>
          <DialogDescription className="break-all">{hook?.url}</DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <Skeleton className="h-32" />
        ) : !q.data?.data.length ? (
          <p className="text-sm text-muted-foreground">{t("settings.webhooks.noDeliveries")}</p>
        ) : (
          <ul className="grid max-h-[60dvh] gap-2 overflow-y-auto">
            {q.data.data.map((d) => (
              <li key={d.id} className="grid gap-1 rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs">{d.event}</code>
                  <Badge variant={statusVariant(d.status)}>{t(`settings.webhooks.status.${d.status}`)}</Badge>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {dt.format(new Date(d.createdAt))}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("settings.webhooks.attempts", { count: d.attempts })}
                  {d.responseStatus ? ` · HTTP ${d.responseStatus}` : ""}
                  {d.lastError ? ` · ${d.lastError}` : ""}
                  {d.status === "failed" && d.nextAttemptAt
                    ? ` · ${t("settings.webhooks.nextAttempt", { when: dt.format(new Date(d.nextAttemptAt)) })}`
                    : ""}
                </p>
                {d.status === "failed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate(d.id)}
                  >
                    <RotateCw /> {t("settings.webhooks.retry")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ExportsTab() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const sched = useQuery(backupQuery);
  const list = useQuery(exportsQuery);
  const [format, setFormat] = useState<"json" | "csv">("json");
  const dt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const size = (b: number | null) =>
    b == null
      ? ""
      : b > 1_048_576
        ? `${(b / 1_048_576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(b / 1024))} KB`;
  const now = useMutation({
    mutationFn: () => unwrap(api.exports.$post({ json: { format } })),
    onSuccess: () => {
      toast.success(t("settings.exports.queued"));
      void qc.invalidateQueries({ queryKey: ["exports"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const download = useMutation({
    mutationFn: (id: string) => unwrap(api.exports[":id"].download.$get({ param: { id } })),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <div className="grid gap-6">
      <Card className="grid gap-3 p-4">
        <h3 className="font-semibold">{t("settings.exports.now")}</h3>
        <p className="text-sm text-muted-foreground">{t("settings.exports.nowHelp")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field id="ex-format" label={t("settings.exports.format")}>
            <Select
              id="ex-format"
              value={format}
              onChange={(e) => setFormat(e.target.value as "json" | "csv")}
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </Select>
          </Field>
          <Button disabled={now.isPending} onClick={() => now.mutate()}>
            <FileArchive /> {t("settings.exports.exportNow")}
          </Button>
        </div>
      </Card>

      {sched.data ? <Schedule initial={sched.data} /> : <Skeleton className="h-40" />}

      <section className="grid gap-3">
        <h3 className="font-semibold">{t("settings.exports.history")}</h3>
        {list.isPending ? (
          <Skeleton className="h-32" />
        ) : !list.data?.data.length ? (
          <p className="text-sm text-muted-foreground">{t("settings.exports.empty")}</p>
        ) : (
          <Card className="divide-y">
            {list.data.data.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{dt.format(new Date(e.createdAt))}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {e.format.toUpperCase()} · {t(`settings.exports.trigger.${e.trigger}`)}
                    {e.requestedBy ? ` · ${e.requestedBy}` : ""}
                    {e.sizeBytes != null ? ` · ${size(e.sizeBytes)}` : ""}
                  </span>
                  {e.error && <span className="block text-xs text-destructive">{e.error}</span>}
                </span>
                <Badge variant={statusVariant(e.status)}>{t(`settings.exports.status.${e.status}`)}</Badge>
                {e.status === "succeeded" && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={t("settings.exports.download")}
                    disabled={download.isPending}
                    onClick={() => download.mutate(e.id)}
                  >
                    <Download className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

type BackupValue = Awaited<ReturnType<NonNullable<typeof backupQuery.queryFn>>>;

function Schedule({ initial }: { initial: BackupValue }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [v, setV] = useState(initial);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const save = useMutation({
    mutationFn: () =>
      unwrap(api.settings.backup.$put({ json: { ...v, webhookUrl: v.webhookUrl?.trim() || null } })),
    onSuccess: (r) => {
      qc.setQueryData(backupQuery.queryKey, r);
      setV(r);
      toast.success(t("settings.saved"));
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Card className="p-4">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">{t("settings.exports.schedule")}</h3>
            <p className="text-sm text-muted-foreground">{t("settings.exports.scheduleHelp")}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={v.enabled}
              onChange={(e) => setV({ ...v, enabled: e.target.checked })}
            />
            {t("settings.exports.enabled")}
          </label>
        </div>
        <div className={cn("grid gap-4 sm:grid-cols-3", !v.enabled && "opacity-60")}>
          <Field id="bk-days" label={t("settings.exports.everyNDays")}>
            <Input
              id="bk-days"
              type="number"
              min={1}
              max={90}
              required
              value={v.everyNDays}
              onChange={(e) => setV({ ...v, everyNDays: Number(e.target.value) })}
            />
          </Field>
          <Field id="bk-at" label={t("settings.exports.at")}>
            <Input
              id="bk-at"
              type="time"
              required
              value={v.at}
              onChange={(e) => setV({ ...v, at: e.target.value })}
            />
          </Field>
          <Field id="bk-format" label={t("settings.exports.format")}>
            <Select
              id="bk-format"
              value={v.format}
              onChange={(e) => setV({ ...v, format: e.target.value as "json" | "csv" })}
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </Select>
          </Field>
        </div>
        <Field id="bk-url" label={t("settings.exports.webhookUrl")}>
          <Input
            id="bk-url"
            type="url"
            placeholder="https://"
            value={v.webhookUrl ?? ""}
            onChange={(e) => setV({ ...v, webhookUrl: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">{t("settings.exports.webhookHelp")}</span>
        </Field>
        <Button type="submit" className="w-fit" disabled={!dirty || save.isPending}>
          {t("common.save")}
        </Button>
      </form>
    </Card>
  );
}
