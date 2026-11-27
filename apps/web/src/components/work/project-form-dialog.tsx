/** Criar/editar projeto: dados do contrato, equipe e tags. Itens de contrato ficam na página do projeto. */
import { PROJECT_STATUSES, type ProjectInput } from "@recpm/shared";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap } from "../../lib/api";
import { catalogQuery } from "../../lib/catalogs";
import { clientsQuery } from "../../lib/clients";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import type { Project } from "../../lib/work";
import { useLookups } from "./lookups";

type V = {
  name: string;
  internal: boolean;
  clientId: string;
  modality: "mensal" | "avulso";
  periodicity: "" | "mensal" | "anual";
  typeId: string;
  status: (typeof PROJECT_STATUSES)[number];
  priority: "baixa" | "media" | "alta";
  startDate: string;
  deliveryDeadline: string;
  clientDeliveryDate: string;
  managerId: string;
  members: string[];
  tagIds: string[];
  value: string;
  recurringValue: string;
  publicSummary: string;
};

const fromProject = (p?: Project | null): V => ({
  name: p?.name ?? "",
  internal: p?.internal ?? false,
  clientId: p?.client?.id ?? "",
  modality: p?.modality ?? "avulso",
  periodicity: p?.periodicity ?? "",
  typeId: p?.type?.id ?? "",
  status: p?.status ?? "planejamento",
  priority: p?.priority ?? "media",
  startDate: p?.startDate ?? "",
  deliveryDeadline: p?.deliveryDeadline ?? "",
  clientDeliveryDate: p?.clientDeliveryDate ?? "",
  managerId: p?.manager?.id ?? "",
  members: p?.members.map((m) => m.id) ?? [],
  tagIds: p?.tags.map((t) => t.id) ?? [],
  value: p?.valueCents != null ? String(p.valueCents / 100) : "",
  recurringValue: p?.recurringValueCents != null ? String(p.recurringValueCents / 100) : "",
  publicSummary: p?.publicSummary ?? "",
});

const cents = (v: string) => (v.trim() ? Math.round(Number(v.replace(",", ".")) * 100) : null);

export function ProjectFormDialog({
  open,
  project,
  defaultClientId,
  onClose,
  onSaved,
}: {
  open: boolean;
  project?: Project | null;
  defaultClientId?: string;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const seeMoney = !!me?.tenant?.permissions.includes("finance.read");
  const lk = useLookups({ projects: false });
  const clients = useQuery({ ...clientsQuery({ status: "active" }), enabled: open });
  const types = useQuery({ ...catalogQuery("project-types"), enabled: open });
  const tags = useQuery({ ...catalogQuery("project-tags"), enabled: open });
  const [v, setV] = useState<V>(fromProject(project));
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reinicia ao abrir
  useEffect(() => {
    if (open) {
      setV({ ...fromProject(project), ...(project ? {} : { clientId: defaultClientId ?? "" }) });
      setError(null);
    }
  }, [open]);
  const set =
    <K extends keyof V>(k: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setV((s) => ({ ...s, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async () => {
      const body: ProjectInput = {
        name: v.name,
        internal: v.internal,
        clientId: v.internal ? null : v.clientId || null,
        modality: v.modality,
        periodicity: v.modality === "mensal" ? v.periodicity || "mensal" : null,
        typeId: v.typeId || null,
        status: v.status,
        priority: v.priority,
        startDate: v.startDate || null,
        deliveryDeadline: v.deliveryDeadline || null,
        clientDeliveryDate: v.clientDeliveryDate || null,
        managerId: v.managerId || null,
        members: v.members.map((userId) => ({
          userId,
          roleId: project?.members.find((m) => m.id === userId)?.roleId,
        })),
        tagIds: v.tagIds,
        publicSummary: v.publicSummary || null,
        ...(seeMoney ? { valueCents: cents(v.value), recurringValueCents: cents(v.recurringValue) } : {}),
      };
      return project
        ? unwrap(api.projects[":id"].$patch({ param: { id: project.id }, json: body as never }))
        : unwrap(api.projects.$post({ json: body as never }));
    },
    onSuccess: (p) => {
      toast.success(project ? t("projects.saved") : t("projects.created"));
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      onSaved?.(p.id);
    },
    onError: (e) => setError(errorMessage(t, e)),
  });

  const toggle = (k: "members" | "tagIds", id: string) =>
    setV((s) => ({ ...s, [k]: s[k].includes(id) ? s[k].filter((x) => x !== id) : [...s[k], id] }));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")} className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!v.internal && !v.clientId) return setError(t("errors.CLIENT_REQUIRED"));
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{project ? t("projects.edit") : t("projects.new")}</DialogTitle>
          </DialogHeader>
          <Field id="pf-name" label={t("projects.fields.name")} hint={t("projects.nameHint")}>
            <Input id="pf-name" required autoFocus maxLength={160} value={v.name} onChange={set("name")} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={v.internal}
              onChange={(e) => setV((s) => ({ ...s, internal: e.target.checked }))}
            />
            {t("projects.fields.internal")}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            {!v.internal && (
              <Field id="pf-client" label={t("projects.fields.client")}>
                <Select id="pf-client" required value={v.clientId} onChange={set("clientId")}>
                  <option value="">{t("common.choose")}</option>
                  {clients.data?.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field id="pf-type" label={t("projects.fields.type")}>
              <Select id="pf-type" value={v.typeId} onChange={set("typeId")}>
                <option value="">—</option>
                {types.data?.data
                  .filter((x) => x.active)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field id="pf-modality" label={t("projects.fields.modality")}>
              <Select id="pf-modality" value={v.modality} onChange={set("modality")}>
                <option value="avulso">{t("projects.modality.avulso")}</option>
                <option value="mensal">{t("projects.modality.mensal")}</option>
              </Select>
            </Field>
            {v.modality === "mensal" && (
              <Field id="pf-periodicity" label={t("projects.fields.periodicity")}>
                <Select id="pf-periodicity" value={v.periodicity || "mensal"} onChange={set("periodicity")}>
                  <option value="mensal">{t("projects.periodicity.mensal")}</option>
                  <option value="anual">{t("projects.periodicity.anual")}</option>
                </Select>
              </Field>
            )}
            <Field id="pf-status" label={t("projects.fields.status")}>
              <Select id="pf-status" value={v.status} onChange={set("status")}>
                {PROJECT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`projects.status.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="pf-priority" label={t("projects.fields.priority")}>
              <Select id="pf-priority" value={v.priority} onChange={set("priority")}>
                {(["baixa", "media", "alta"] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`work.priority.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="pf-start" label={t("projects.fields.startDate")}>
              <Input id="pf-start" type="date" value={v.startDate} onChange={set("startDate")} />
            </Field>
            <Field id="pf-deadline" label={t("projects.fields.deliveryDeadline")}>
              <Input
                id="pf-deadline"
                type="date"
                value={v.deliveryDeadline}
                onChange={set("deliveryDeadline")}
              />
            </Field>
            <Field id="pf-client-delivery" label={t("projects.fields.clientDeliveryDate")}>
              <Input
                id="pf-client-delivery"
                type="date"
                value={v.clientDeliveryDate}
                onChange={set("clientDeliveryDate")}
              />
            </Field>
            <Field id="pf-manager" label={t("projects.fields.manager")}>
              <Select id="pf-manager" value={v.managerId} onChange={set("managerId")}>
                <option value="">—</option>
                {lk.people
                  .filter((p) => p.role !== "funcionario" || p.isAccountManager)
                  .map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
            {seeMoney && (
              <>
                <Field id="pf-value" label={t("projects.fields.value")}>
                  <Input
                    id="pf-value"
                    inputMode="decimal"
                    value={v.value}
                    onChange={set("value")}
                    placeholder="0,00"
                  />
                </Field>
                {v.modality === "mensal" && (
                  <Field id="pf-recurring" label={t("projects.fields.recurringValue")}>
                    <Input
                      id="pf-recurring"
                      inputMode="decimal"
                      value={v.recurringValue}
                      onChange={set("recurringValue")}
                      placeholder="0,00"
                    />
                  </Field>
                )}
              </>
            )}
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t("projects.fields.members")}</legend>
            <div className="flex flex-wrap gap-1.5">
              {lk.people.map((p) => {
                const on = v.members.includes(p.userId) || v.managerId === p.userId;
                return (
                  <button
                    key={p.userId}
                    type="button"
                    aria-pressed={on}
                    disabled={v.managerId === p.userId}
                    onClick={() => toggle("members", p.userId)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs",
                      on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground",
                    )}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {!!tags.data?.data.length && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{t("projects.fields.tags")}</legend>
              <div className="flex flex-wrap gap-1.5">
                {tags.data.data
                  .filter((x) => x.active)
                  .map((g) => {
                    const on = v.tagIds.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle("tagIds", g.id)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs",
                          on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground",
                        )}
                      >
                        {g.label}
                      </button>
                    );
                  })}
              </div>
            </fieldset>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {project ? t("common.save") : t("projects.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
