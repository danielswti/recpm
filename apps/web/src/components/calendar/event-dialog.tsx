/** Evento da agenda (criar/editar/excluir) e configuração dos feriados nacionais. */
import { CALENDAR_EVENT_TYPES } from "@recpm/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { type CalendarItem, holidaysQuery } from "../../lib/comms";
import { errorMessage } from "../../lib/errors";
import { projectsQuery } from "../../lib/work";

export function EventDialog({
  item,
  defaultDate,
  onClose,
}: {
  item: CalendarItem | null;
  defaultDate: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const projects = useQuery(projectsQuery({}));
  const ev = item?.event;
  const [f, setF] = useState({
    title: item?.title ?? "",
    description: ev?.description ?? "",
    date: item?.date ?? defaultDate,
    time: item?.time ?? "",
    type: (item?.type ?? "reuniao") as (typeof CALENDAR_EVENT_TYPES)[number],
    yearlyRecurring: ev?.yearlyRecurring ?? false,
    isDayOff: item?.isDayOff ?? false,
    projectId: ev?.projectId ?? "",
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["calendar"] });
    onClose();
  };
  const json = () => ({
    title: f.title,
    description: f.description || null,
    date: f.date,
    time: f.time || null,
    type: f.type,
    yearlyRecurring: f.yearlyRecurring,
    isDayOff: f.isDayOff,
    projectId: f.projectId || null,
  });
  const save = useMutation({
    mutationFn: async () => {
      if (ev) await unwrapVoid(api.calendar.events[":id"].$patch({ param: { id: ev.id }, json: json() }));
      else await unwrap(api.calendar.events.$post({ json: json() }));
    },
    onSuccess: () => {
      toast.success(t(ev ? "calendar.eventSaved" : "calendar.eventCreated"));
      done();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const remove = useMutation({
    mutationFn: () => unwrapVoid(api.calendar.events[":id"].$delete({ param: { id: ev!.id } })),
    onSuccess: done,
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const set =
    (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setF((s) => ({
        ...s,
        [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value,
      }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(ev ? "calendar.editEvent" : "calendar.newEvent")}</DialogTitle>
            <DialogDescription>{t("calendar.eventHint")}</DialogDescription>
          </DialogHeader>
          <Field id="ev-title" label={t("calendar.fields.title")}>
            <Input id="ev-title" required maxLength={200} value={f.title} onChange={set("title")} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="ev-date" label={t("calendar.fields.date")}>
              <Input id="ev-date" type="date" required value={f.date} onChange={set("date")} />
            </Field>
            <Field id="ev-time" label={t("calendar.fields.time")}>
              <Input id="ev-time" type="time" value={f.time} onChange={set("time")} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field id="ev-type" label={t("calendar.fields.type")}>
              <Select id="ev-type" value={f.type} onChange={set("type")}>
                {CALENDAR_EVENT_TYPES.map((k) => (
                  <option key={k} value={k}>
                    {t(`calendar.types.${k}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="ev-project" label={t("calendar.fields.project")}>
              <Select id="ev-project" value={f.projectId} onChange={set("projectId")}>
                <option value="">{t("calendar.noProject")}</option>
                {projects.data?.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field id="ev-description" label={t("calendar.fields.description")}>
            <textarea
              id="ev-description"
              className="min-h-20 rounded-md border bg-transparent px-3 py-2 text-sm"
              maxLength={2000}
              value={f.description}
              onChange={set("description")}
            />
          </Field>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.yearlyRecurring} onChange={set("yearlyRecurring")} />
              {t("calendar.fields.yearly")}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.isDayOff} onChange={set("isDayOff")} />
              {t("calendar.fields.dayOff")}
            </label>
          </div>
          <DialogFooter className="gap-2">
            {ev && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t("common.delete")}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function HolidaysDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(holidaysQuery);
  const year = new Date().getFullYear();
  const run = useMutation({
    mutationFn: async (national: boolean) => {
      let added = 0;
      for (const y of national ? [year, year + 1] : [year])
        added += (await unwrap(api.calendar.holidays.$put({ json: { year: y, national } }))).added;
      return added;
    },
    onSuccess: (added, national) => {
      toast.success(
        national ? t("calendar.holidays.imported", { count: added }) : t("calendar.holidays.removed"),
      );
      void qc.invalidateQueries({ queryKey: ["calendar"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const national = q.data?.national ?? true;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")}>
        <DialogHeader>
          <DialogTitle>{t("calendar.holidays.title")}</DialogTitle>
          <DialogDescription>{t("calendar.holidays.hint")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          {q.data
            ? national
              ? t("calendar.holidays.on", { count: q.data.imported })
              : t("calendar.holidays.off")
            : t("common.loading")}
        </p>
        <DialogFooter className="gap-2">
          {national && q.data?.imported ? (
            <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate(false)}>
              {t("calendar.holidays.disable")}
            </Button>
          ) : null}
          <Button disabled={run.isPending} onClick={() => run.mutate(true)}>
            {t("calendar.holidays.import", { from: year, to: year + 1 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
