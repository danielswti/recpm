/** Gaveta da tarefa: tempo útil (por pessoa e registros), pedidos de ajuste e entregas (peças). */
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, PackageCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatDuration, taskDeliveriesQuery, taskTimeQuery, useTicking } from "../../lib/time";
import { fromLocalInput, toLocalInput } from "../../lib/work";
import { textareaClass } from "../confirm-dialog";

type Entry = { id: string; startedAt: string; endedAt: string | null };

export function TaskTime({ taskId, meId, canTrack }: { taskId: string; meId: string; canTrack: boolean }) {
  const { t, i18n } = useTranslation();
  const q = useQuery(taskTimeQuery(taskId));
  const [open, setOpen] = useState(false);
  const [adjust, setAdjust] = useState<null | { entry?: Entry }>(null);
  const total = useTicking(q.data?.totalMs, !!q.data?.running);
  const dt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const tm = new Intl.DateTimeFormat(i18n.language, { timeStyle: "short" });
  if (!q.data) return null;
  const d = q.data;

  return (
    <section className="grid gap-2" aria-labelledby="task-time-h">
      <div className="flex items-center gap-2">
        <h3 id="task-time-h" className="text-sm font-semibold">
          {t("time.title")}
        </h3>
        <span className="text-sm tabular-nums text-muted-foreground">{formatDuration(total ?? 0)}</span>
        {d.reworkMs >= 60_000 && (
          <Badge variant="outline" title={t("time.reworkHelp")}>
            {t("time.rework", { time: formatDuration(d.reworkMs) })}
          </Badge>
        )}
        {d.pendingAdjustments > 0 && (
          <Badge variant="secondary">{t("time.pendingCount", { count: d.pendingAdjustments })}</Badge>
        )}
        {canTrack && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdjust({})}>
            <Plus /> {t("time.requestAdjustment")}
          </Button>
        )}
      </div>
      {d.people.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("time.none")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2 text-sm">
          {d.people.map((p) => (
            <li
              key={p.user.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted py-0.5 pl-0.5 pr-2.5"
            >
              <Avatar name={p.user.name} src={p.user.image} className="size-5" />
              {p.user.name}
              <span className="tabular-nums text-muted-foreground">{formatDuration(p.ms)}</span>
            </li>
          ))}
        </ul>
      )}
      {d.entries.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={open}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {t("time.entries", { count: d.entries.length })}
          </button>
          {open && (
            <ul className="mt-2 grid gap-1 text-sm">
              {d.entries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5">
                  <Avatar name={e.user.name} src={e.user.image} className="size-5" />
                  <span className="truncate">{e.user.name}</span>
                  <span className="text-muted-foreground">
                    {dt.format(new Date(e.startedAt))}
                    {" – "}
                    {e.endedAt ? tm.format(new Date(e.endedAt)) : t("time.running")}
                  </span>
                  {e.statusAtStart === "ajustes" && <Badge variant="outline">{t("time.reworkShort")}</Badge>}
                  <span className="ml-auto tabular-nums">{formatDuration(e.businessMs)}</span>
                  {e.user.id === meId && e.endedAt && canTrack && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t("time.fixEntry")}
                      title={t("time.fixEntry")}
                      onClick={() => setAdjust({ entry: e })}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <AdjustmentRequestDialog taskId={taskId} state={adjust} onClose={() => setAdjust(null)} />
    </section>
  );
}

function AdjustmentRequestDialog({
  taskId,
  state,
  onClose,
}: {
  taskId: string;
  state: null | { entry?: Entry };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const entry = state?.entry;
  const [sign, setSign] = useState<1 | -1>(1);
  const [minutes, setMinutes] = useState("30");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState<unknown>(null);
  if (key !== state) {
    setKey(state);
    setSign(1);
    setMinutes("30");
    setReason("");
    setStart(entry ? toLocalInput(entry.startedAt) : "");
    setEnd(entry?.endedAt ? toLocalInput(entry.endedAt) : "");
  }
  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.time.adjustments.$post({
          json: entry
            ? {
                timeEntryId: entry.id,
                startedAt: fromLocalInput(start)!,
                endedAt: fromLocalInput(end)!,
                reason: reason.trim(),
              }
            : { taskId, deltaMinutes: sign * Number(minutes), reason: reason.trim() },
        }),
      ),
    onSuccess: () => {
      toast.success(t("time.adjustmentSent"));
      void qc.invalidateQueries({ queryKey: ["time"] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{entry ? t("time.fixEntry") : t("time.requestAdjustment")}</DialogTitle>
            <DialogDescription>{t("time.adjustmentHelp")}</DialogDescription>
          </DialogHeader>
          {entry ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="adj-start" label={t("time.startedAt")}>
                <Input
                  id="adj-start"
                  type="datetime-local"
                  required
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </Field>
              <Field id="adj-end" label={t("time.endedAt")}>
                <Input
                  id="adj-end"
                  type="datetime-local"
                  required
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <div className="flex items-end gap-3">
              <fieldset className="grid gap-1.5">
                <legend className="mb-1.5 text-sm font-medium">{t("time.direction")}</legend>
                <div className="flex gap-3 text-sm">
                  {([1, -1] as const).map((v) => (
                    <label key={v} className="flex items-center gap-1.5">
                      <input type="radio" name="adj-sign" checked={sign === v} onChange={() => setSign(v)} />
                      {v === 1 ? t("time.add") : t("time.remove")}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field id="adj-min" label={t("time.minutes")}>
                <Input
                  id="adj-min"
                  type="number"
                  min={1}
                  max={1440}
                  required
                  className="w-28"
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </Field>
            </div>
          )}
          <Field id="adj-reason" label={t("time.reason")}>
            <textarea
              id="adj-reason"
              required
              minLength={3}
              maxLength={500}
              className={textareaClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={send.isPending || reason.trim().length < 3}>
              {t("time.sendForApproval")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Concluído": registra peças entregues (fonte única dos relatórios de entregas). */
export function TaskDeliveries({
  taskId,
  pieceQuantity,
  editable,
}: {
  taskId: string;
  pieceQuantity: number;
  editable: boolean;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(taskDeliveriesQuery(taskId));
  const [qty, setQty] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const dt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const remaining = Math.max(1, pieceQuantity - (q.data?.total ?? 0));
  const refresh = () => void qc.invalidateQueries({ queryKey: ["time", "deliveries", taskId] });
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.tasks[":id"].deliveries.$post({
          param: { id: taskId },
          json: { quantity: Number(qty), note: note.trim() || null },
        }),
      ),
    onSuccess: () => {
      toast.success(t("deliveries.saved"));
      setQty(null);
      setNote("");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const del = useMutation({
    mutationFn: (subId: string) =>
      unwrapVoid(api.tasks[":id"].deliveries[":subId"].$delete({ param: { id: taskId, subId } })),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  if (!q.data) return null;

  return (
    <section className="grid gap-2" aria-labelledby="task-deliv-h">
      <div className="flex items-center gap-2">
        <h3 id="task-deliv-h" className="text-sm font-semibold">
          {t("deliveries.title")}
        </h3>
        <span className="text-sm tabular-nums text-muted-foreground">
          {t("deliveries.progress", { done: q.data.total, total: pieceQuantity })}
        </span>
        {editable && qty === null && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setQty(String(remaining))}>
            <PackageCheck /> {t("deliveries.done")}
          </Button>
        )}
      </div>
      {qty !== null && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field id="deliv-qty" label={t("deliveries.quantity")}>
            <Input
              id="deliv-qty"
              type="number"
              min={1}
              max={1000}
              required
              className="w-24"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </Field>
          <Field id="deliv-note" label={t("deliveries.note")} className="min-w-40 flex-1">
            <Input id="deliv-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button type="submit" disabled={add.isPending}>
            {t("common.save")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setQty(null)}>
            {t("common.cancel")}
          </Button>
        </form>
      )}
      {q.data.data.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {q.data.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5">
              <Avatar name={d.user.name} src={d.user.image} className="size-5" />
              <span className="font-medium tabular-nums">
                {t("deliveries.pieces", { count: d.quantity })}
              </span>
              <span className="truncate text-muted-foreground">{d.user.name}</span>
              {d.note && <span className="truncate text-muted-foreground">· {d.note}</span>}
              <span className="ml-auto text-xs text-muted-foreground">
                {dt.format(new Date(d.deliveredAt))}
              </span>
              {d.canDelete && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={t("deliveries.undo")}
                  title={t("deliveries.undo")}
                  onClick={() => del.mutate(d.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
