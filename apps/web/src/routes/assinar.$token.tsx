/**
 * Página pública do signatário (§5 Assinatura eletrônica): ver o documento, assinar digitando
 * o próprio nome ou recusar com um motivo. Não exige conta; o link pessoal é a credencial.
 */
import { Badge, Button, Field, Input, Skeleton } from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FileText, PenLine, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout, Notice } from "../components/auth-layout";
import { textareaClass } from "../components/confirm-dialog";
import { api, unwrap } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { SIGNER_TONE } from "../lib/finance";

export const Route = createFileRoute("/assinar/$token")({ component: SignPage });

function SignPage() {
  const { t } = useTranslation();
  const { token } = Route.useParams();
  const qc = useQueryClient();
  const key = ["public-sign", token];
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.public.sign[":token"].$get({ param: { token } })),
    retry: false,
  });
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState("");
  const onDone = (v: NonNullable<typeof q.data>) => qc.setQueryData(key, v);
  const sign = useMutation({
    mutationFn: () =>
      unwrap(
        api.public.sign[":token"].sign.$post({ param: { token }, json: { typedName: name, agree: true } }),
      ),
    onSuccess: onDone,
  });
  const refuse = useMutation({
    mutationFn: () => unwrap(api.public.sign[":token"].refuse.$post({ param: { token }, json: { reason } })),
    onSuccess: onDone,
  });

  if (q.isPending)
    return (
      <AuthLayout title={t("sign.loading")}>
        <Skeleton className="h-40" />
      </AuthLayout>
    );
  if (q.isError)
    return (
      <AuthLayout title={t("sign.invalidTitle")}>
        <Notice tone="error">{t("sign.invalidText")}</Notice>
      </AuthLayout>
    );
  const v = q.data;
  const docUrl = `/api/v1/public/sign/${token}/document`;
  const canAct = v.status === "enviado" && (v.me.status === "pendente" || v.me.status === "visualizou");

  return (
    <AuthLayout title={v.title} description={t("sign.from", { workspace: v.workspace })}>
      <div className="grid gap-4">
        {v.message && (
          <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2 text-sm">{v.message}</p>
        )}
        <a
          href={docUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 rounded-md border p-3 text-sm hover:bg-accent/40"
        >
          <FileText className="size-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{v.documentName}</span>
            <span className="text-xs text-muted-foreground">
              {v.status === "assinado" ? t("sign.openSigned") : t("sign.openDocument")}
            </span>
          </span>
        </a>

        {v.status === "cancelado" && <Notice tone="error">{t("sign.canceled")}</Notice>}
        {v.me.status === "assinou" && v.status !== "assinado" && (
          <Notice tone="success">{t("sign.youSigned")}</Notice>
        )}
        {v.me.status === "recusou" && <Notice tone="error">{t("sign.youRefused")}</Notice>}
        {v.status === "recusado" && v.me.status !== "recusou" && (
          <Notice tone="error">{t("sign.refusedByOther")}</Notice>
        )}
        {v.status === "assinado" && (
          <Notice tone="success">
            {t("sign.allSigned")}{" "}
            <Link
              to="/verificar/$code"
              params={{ code: v.verificationCode }}
              className="font-medium underline"
            >
              {v.verificationCode}
            </Link>
          </Notice>
        )}

        {canAct && !refusing && (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (agree) sign.mutate();
            }}
          >
            <Field
              id="sig-name"
              label={t("sign.typeName")}
              hint={t("sign.typeNameHint", { name: v.me.name })}
            >
              <Input
                id="sig-name"
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="font-serif text-lg italic"
              />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
              />
              <span>{t("sign.agree")}</span>
            </label>
            {sign.isError && <Notice tone="error">{errorMessage(t, sign.error)}</Notice>}
            <Button type="submit" disabled={!agree || !name.trim() || sign.isPending}>
              <PenLine /> {t("sign.sign")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRefusing(true)}>
              {t("sign.refuse")}
            </Button>
          </form>
        )}
        {canAct && refusing && (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              refuse.mutate();
            }}
          >
            <Field id="sig-reason" label={t("sign.reason")}>
              <textarea
                id="sig-reason"
                required
                minLength={3}
                maxLength={1000}
                rows={3}
                className={textareaClass}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            {refuse.isError && <Notice tone="error">{errorMessage(t, refuse.error)}</Notice>}
            <Button
              type="submit"
              variant="destructive"
              disabled={reason.trim().length < 3 || refuse.isPending}
            >
              {t("sign.confirmRefuse")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRefusing(false)}>
              {t("common.back")}
            </Button>
          </form>
        )}

        <section aria-labelledby="sig-signers" className="grid gap-2 border-t pt-3">
          <h2 id="sig-signers" className="text-sm font-medium text-muted-foreground">
            {t("sign.signers")}
          </h2>
          <ul className="grid gap-1.5">
            {v.signers.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a lista pública não expõe ids
              <li key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{s.name}</span>
                <Badge variant={SIGNER_TONE[s.status]}>{t(`signatures.signerStatus.${s.status}`)}</Badge>
              </li>
            ))}
          </ul>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" /> {t("sign.legal")}
          </p>
        </section>
      </div>
    </AuthLayout>
  );
}
