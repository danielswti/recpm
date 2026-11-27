import { type ClientInput, clientInput, suggestClientCode } from "@recpm/shared";
import { Button, Field, Input } from "@recpm/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type Client, formatDocument } from "../lib/clients";
import { textareaClass } from "./confirm-dialog";

type Values = {
  code: string;
  name: string;
  email: string;
  phone: string;
  document: string;
  assetsLink: string;
  notes: string;
};

/** Formulário de cliente (criar e editar). Valida com o mesmo schema da API. */
export function ClientForm({
  client,
  pending,
  error,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  client?: Client | null;
  pending?: boolean;
  error?: string | null;
  onSubmit: (v: ClientInput) => void;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState<Values>({
    code: client?.code ?? "",
    name: client?.name ?? "",
    email: client?.email ?? "",
    phone: client?.phone ?? "",
    document: formatDocument(client?.document ?? null),
    assetsLink: client?.assetsLink ?? "",
    notes: client?.notes ?? "",
  });
  const [codeTouched, setCodeTouched] = useState(!!client);
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});

  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    setV((s) => ({
      ...s,
      [k]: value,
      ...(k === "name" && !codeTouched ? { code: suggestClientCode(value) } : {}),
    }));
    if (k === "code") setCodeTouched(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = clientInput.safeParse(v);
    if (!r.success) {
      const errs: Partial<Record<keyof Values, string>> = {};
      for (const i of r.error.issues) errs[i.path[0] as keyof Values] ??= i.message;
      return setErrors(errs);
    }
    setErrors({});
    onSubmit(v);
  };

  const field = (k: keyof Values, props: React.ComponentProps<typeof Input> = {}) => (
    <Field id={`cl-${k}`} label={t(`clients.fields.${k}`)} error={errors[k]}>
      <Input id={`cl-${k}`} value={v[k]} onChange={set(k)} aria-invalid={!!errors[k]} {...props} />
    </Field>
  );

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        {field("name", { autoFocus: !client })}
        {field("code", { className: "uppercase", maxLength: 12 })}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("email", { type: "email" })}
        {field("phone", { type: "tel" })}
        {field("document", { inputMode: "numeric" })}
        {field("assetsLink", { type: "url", placeholder: "https://" })}
      </div>
      <Field id="cl-notes" label={t("clients.fields.notes")}>
        <textarea id="cl-notes" rows={3} className={textareaClass} value={v.notes} onChange={set("notes")} />
      </Field>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
