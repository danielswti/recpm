import { BRIEFING_FIELD_TYPES } from "@recpm/shared";
import { Button, Card, CardContent, Field, Input, Select, Skeleton } from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { textareaClass } from "../../components/confirm-dialog";
import { api, unwrap } from "../../lib/api";
import { briefingFormQuery, briefingFormsQuery, catalogQuery, taskTypesQuery } from "../../lib/catalogs";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";

export const Route = createFileRoute("/_app/cadastros/briefings/$id")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("catalogs.manage")) throw redirect({ to: "/" });
  },
  component: BriefingBuilder,
});

type FieldType = (typeof BRIEFING_FIELD_TYPES)[number];
type Draft = {
  key: string;
  label: string;
  type: FieldType;
  options: string;
  allowOther: boolean;
  required: boolean;
  help: string;
};
const isChoice = (t: FieldType) => t === "escolha_unica" || t === "caixas";
let seq = 0;
const newField = (): Draft => ({
  key: `n${seq++}`,
  label: "",
  type: "texto",
  options: "",
  allowOther: false,
  required: false,
  help: "",
});

function BriefingBuilder() {
  const { t } = useTranslation();
  const { id } = Route.useParams();
  const isNew = id === "novo";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const form = useQuery({ ...briefingFormQuery(id), enabled: !isNew });
  const taskTypes = useQuery(taskTypesQuery);
  const projectTypes = useQuery(catalogQuery("project-types"));

  const [meta, setMeta] = useState({
    name: "",
    description: "",
    taskTypeId: "",
    projectTypeId: "",
    active: true,
  });
  const [fields, setFields] = useState<Draft[]>(isNew ? [newField()] : []);
  useEffect(() => {
    const f = form.data;
    if (!f) return;
    setMeta({
      name: f.name,
      description: f.description ?? "",
      taskTypeId: f.taskTypeId ?? "",
      projectTypeId: f.projectTypeId ?? "",
      active: f.active,
    });
    setFields(
      f.fields.map((x) => ({
        key: x.id,
        label: x.label,
        type: x.type,
        options: x.options.join("\n"),
        allowOther: x.allowOther,
        required: x.required,
        help: x.help ?? "",
      })),
    );
  }, [form.data]);

  const payload = () => ({
    name: meta.name,
    description: meta.description.trim() || null,
    taskTypeId: meta.taskTypeId || null,
    projectTypeId: meta.projectTypeId || null,
    active: meta.active,
    fields: fields.map((f) => ({
      label: f.label,
      type: f.type,
      options: isChoice(f.type)
        ? f.options
            .split("\n")
            .map((o) => o.trim())
            .filter(Boolean)
        : [],
      allowOther: isChoice(f.type) && f.allowOther,
      required: f.required,
      help: f.help.trim() || null,
    })),
  });

  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      isNew
        ? unwrap(api["briefing-forms"].$post({ json: payload() }))
        : unwrap(api["briefing-forms"][":id"].$put({ param: { id }, json: payload() })),
    onSuccess: async (f) => {
      toast.success(t("catalogs.saved"));
      await qc.invalidateQueries({ queryKey: briefingFormsQuery.queryKey });
      if (isNew) await navigate({ to: "/cadastros/briefings/$id", params: { id: f.id }, replace: true });
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = payload();
    if (!p.name.trim()) return setProblem(t("catalogs.briefing.needName"));
    const bad = p.fields.findIndex((f) => !f.label.trim() || (isChoice(f.type) && f.options.length < 2));
    if (bad >= 0) return setProblem(t("catalogs.briefing.badField", { n: bad + 1 }));
    setProblem(null);
    save.mutate();
  };

  const update = (key: string, patch: Partial<Draft>) =>
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const move = (i: number, d: -1 | 1) =>
    setFields((fs) => {
      const next = [...fs];
      const [it] = next.splice(i, 1);
      next.splice(i + d, 0, it!);
      return next;
    });

  if (!isNew && form.isPending) return <Skeleton className="h-64" />;
  if (!isNew && form.isError) return <p className="text-destructive">{errorMessage(t, form.error)}</p>;

  return (
    <form onSubmit={submit} className="mx-auto grid max-w-3xl gap-6" noValidate>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/cadastros"
          search={{ tab: "briefings" }}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> {t("catalogs.tabs.briefings")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isNew ? t("catalogs.briefing.new") : t("catalogs.briefing.edit")}
        </h1>
      </div>
      {problem || save.error ? (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {problem ?? errorMessage(t, save.error)}
        </p>
      ) : null}
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <Field id="bf-name" label={t("common.name")}>
            <Input
              id="bf-name"
              value={meta.name}
              onChange={(e) => setMeta({ ...meta, name: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={meta.active}
              onChange={(e) => setMeta({ ...meta, active: e.target.checked })}
            />
            {t("catalogs.briefing.active")}
          </label>
          <Field id="bf-desc" label={t("catalogs.briefing.description")} className="sm:col-span-2">
            <textarea
              id="bf-desc"
              rows={2}
              className={textareaClass}
              value={meta.description}
              onChange={(e) => setMeta({ ...meta, description: e.target.value })}
            />
          </Field>
          <Field id="bf-tt" label={t("catalogs.briefing.taskType")} hint={t("catalogs.briefing.suggestHint")}>
            <Select
              id="bf-tt"
              value={meta.taskTypeId}
              onChange={(e) => setMeta({ ...meta, taskTypeId: e.target.value })}
            >
              <option value="">{t("catalogs.briefing.any")}</option>
              {taskTypes.data?.data.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="bf-pt" label={t("catalogs.briefing.projectType")}>
            <Select
              id="bf-pt"
              value={meta.projectTypeId}
              onChange={(e) => setMeta({ ...meta, projectTypeId: e.target.value })}
            >
              <option value="">{t("catalogs.briefing.any")}</option>
              {projectTypes.data?.data.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>

      <section className="grid gap-3" aria-label={t("catalogs.briefing.fieldsTitle")}>
        <h2 className="text-lg font-semibold">{t("catalogs.briefing.fieldsTitle")}</h2>
        {fields.map((f, i) => (
          <Card key={f.key}>
            <CardContent className="grid gap-3 pt-6">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-muted-foreground">#{i + 1}</span>
                <div className="ml-auto flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={i === 0}
                    aria-label={t("catalogs.briefing.moveUp", { n: i + 1 })}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={i === fields.length - 1}
                    aria-label={t("catalogs.briefing.moveDown", { n: i + 1 })}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("catalogs.briefing.removeField", { n: i + 1 })}
                    onClick={() => setFields((fs) => fs.filter((x) => x.key !== f.key))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
                <Field id={`f-${f.key}-label`} label={t("catalogs.briefing.question")}>
                  <Input
                    id={`f-${f.key}-label`}
                    value={f.label}
                    onChange={(e) => update(f.key, { label: e.target.value })}
                  />
                </Field>
                <Field id={`f-${f.key}-type`} label={t("catalogs.briefing.type")}>
                  <Select
                    id={`f-${f.key}-type`}
                    value={f.type}
                    onChange={(e) => update(f.key, { type: e.target.value as FieldType })}
                  >
                    {BRIEFING_FIELD_TYPES.map((ty) => (
                      <option key={ty} value={ty}>
                        {t(`catalogs.briefing.types.${ty}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {isChoice(f.type) && (
                <Field
                  id={`f-${f.key}-opts`}
                  label={t("catalogs.briefing.options")}
                  hint={t("catalogs.briefing.optionsHint")}
                >
                  <textarea
                    id={`f-${f.key}-opts`}
                    rows={3}
                    className={textareaClass}
                    value={f.options}
                    onChange={(e) => update(f.key, { options: e.target.value })}
                  />
                </Field>
              )}
              <Field id={`f-${f.key}-help`} label={t("catalogs.briefing.help")}>
                <Input
                  id={`f-${f.key}-help`}
                  value={f.help}
                  onChange={(e) => update(f.key, { help: e.target.value })}
                />
              </Field>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => update(f.key, { required: e.target.checked })}
                  />
                  {t("catalogs.briefing.required")}
                </label>
                {isChoice(f.type) && (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={f.allowOther}
                      onChange={(e) => update(f.key, { allowOther: e.target.checked })}
                    />
                    {t("catalogs.briefing.allowOther")}
                  </label>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
        <div>
          <Button type="button" variant="outline" onClick={() => setFields((fs) => [...fs, newField()])}>
            <Plus /> {t("catalogs.briefing.addField")}
          </Button>
        </div>
      </section>

      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t bg-background/90 px-4 py-3 backdrop-blur">
        <Button
          type="button"
          variant="ghost"
          onClick={() => void navigate({ to: "/cadastros", search: { tab: "briefings" } })}
        >
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
