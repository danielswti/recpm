/** Demandas do cliente: abre um pedido (com briefing, se houver formulário) e acompanha a resposta. */
import {
  Badge,
  Button,
  Card,
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
import { createFileRoute, Link } from "@tanstack/react-router";
import { Inbox, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { type BriefingForm, portalDemandsQuery, portalHomeQuery } from "../lib/portal";

export const Route = createFileRoute("/cliente/demandas")({ component: PortalDemands });

function PortalDemands() {
  const { t, i18n } = useTranslation();
  const q = useQuery(portalDemandsQuery);
  const [open, setOpen] = useState(false);
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("portal.demands.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("portal.demands.subtitle")}</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus /> {t("portal.demands.new")}
        </Button>
      </div>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : !q.data?.data.length ? (
        <EmptyState icon={<Inbox className="size-6" />} title={t("portal.demands.empty")} />
      ) : (
        <div className="grid gap-3">
          {q.data.data.map((d) => (
            <Card key={d.id} className="grid gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium">{d.title}</span>
                <Badge
                  variant={
                    d.status === "accepted"
                      ? "default"
                      : d.status === "rejected"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {t(`portal.demands.status.${d.status}`)}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {[d.project?.name, df.format(new Date(d.createdAt))].filter(Boolean).join(" · ")}
              </p>
              {d.description && <p className="whitespace-pre-wrap text-sm">{d.description}</p>}
              {d.status === "rejected" && d.rejectionReason && (
                <p className="text-sm text-destructive">
                  {t("portal.demands.reason")}: {d.rejectionReason}
                </p>
              )}
              {d.status === "accepted" && d.taskId && d.project && (
                <Link
                  to="/cliente/tarefas/$id"
                  params={{ id: d.taskId }}
                  className="w-fit text-sm text-primary hover:underline"
                >
                  {t("portal.demands.openTask")}
                </Link>
              )}
            </Card>
          ))}
        </div>
      )}
      {q.data && <NewDemandDialog open={open} onClose={() => setOpen(false)} forms={q.data.forms} />}
    </div>
  );
}

function NewDemandDialog({
  open,
  onClose,
  forms,
}: {
  open: boolean;
  onClose: () => void;
  forms: BriefingForm[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const projects = useQuery(portalHomeQuery).data?.projects ?? [];
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [date, setDate] = useState("");
  const [formId, setFormId] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const form = forms.find((f) => f.id === formId);
  const reset = () => {
    setTitle("");
    setDescription("");
    setProjectId("");
    setDate("");
    setFormId("");
    setAnswers({});
  };
  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.portal.demands.$post({
          json: {
            title: title.trim(),
            description: description.trim() || null,
            projectId: projectId || null,
            desiredDate: date || null,
            briefing: form ? { formId: form.id, answers } : null,
          },
        }),
      ),
    onSuccess: () => {
      toast.success(t("portal.demands.sent"));
      void qc.invalidateQueries({ queryKey: ["portal"] });
      reset();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")} className="max-h-[90dvh] overflow-y-auto">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("portal.demands.new")}</DialogTitle>
            <DialogDescription>{t("portal.demands.newHelp")}</DialogDescription>
          </DialogHeader>
          <Field id="dm-title" label={t("portal.fields.title")}>
            <Input
              id="dm-title"
              required
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field id="dm-desc" label={t("portal.fields.description")}>
            <textarea
              id="dm-desc"
              className="min-h-20 rounded-md border bg-background px-3 py-2 text-sm"
              maxLength={5000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="dm-project" label={t("portal.fields.project")}>
              <Select id="dm-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">{t("portal.demands.noProject")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="dm-date" label={t("portal.fields.desiredDate")}>
              <Input id="dm-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          {forms.length > 0 && (
            <Field id="dm-form" label={t("portal.demands.briefing")}>
              <Select
                id="dm-form"
                value={formId}
                onChange={(e) => {
                  setFormId(e.target.value);
                  setAnswers({});
                }}
              >
                <option value="">{t("portal.demands.noBriefing")}</option>
                {forms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {form && (
            <fieldset className="grid gap-4 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{form.name}</legend>
              {form.description && <p className="text-sm text-muted-foreground">{form.description}</p>}
              {form.fields.map((f) => (
                <BriefingField
                  key={f.id}
                  field={f}
                  value={answers[f.id]}
                  onChange={(v) => setAnswers((a) => ({ ...a, [f.id]: v }))}
                />
              ))}
            </fieldset>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={send.isPending || !title.trim()}>
              {t("portal.demands.send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BriefingField({
  field: f,
  value,
  onChange,
}: {
  field: BriefingForm["fields"][number];
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
}) {
  const { t } = useTranslation();
  const id = `bf-${f.id}`;
  const label = `${f.label}${f.required ? " *" : ""}`;
  if (f.type === "texto" || f.type === "paragrafo")
    return (
      <Field id={id} label={label}>
        {f.type === "texto" ? (
          <Input
            id={id}
            required={f.required}
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <textarea
            id={id}
            required={f.required}
            className="min-h-20 rounded-md border bg-background px-3 py-2 text-sm"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {f.help && <span className="text-xs text-muted-foreground">{f.help}</span>}
      </Field>
    );
  const multi = f.type === "caixas";
  const selected = multi ? ((value as string[]) ?? []) : value ? [value as string] : [];
  const other = selected.find((v) => !f.options.includes(v));
  const toggle = (opt: string, on: boolean) =>
    multi ? onChange(on ? [...selected, opt] : selected.filter((v) => v !== opt)) : onChange(opt);
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {f.options.map((opt) => (
        <label key={opt} className="flex items-center gap-2 text-sm">
          <input
            type={multi ? "checkbox" : "radio"}
            name={id}
            checked={selected.includes(opt)}
            onChange={(e) => toggle(opt, e.target.checked)}
          />
          {opt}
        </label>
      ))}
      {f.allowOther && (
        <Input
          className="h-8"
          placeholder={t("portal.demands.other")}
          aria-label={`${f.label}: ${t("portal.demands.other")}`}
          value={other ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            const base = selected.filter((x) => f.options.includes(x));
            onChange(multi ? (v ? [...base, v] : base) : v);
          }}
        />
      )}
      {f.help && <span className="text-xs text-muted-foreground">{f.help}</span>}
    </fieldset>
  );
}
