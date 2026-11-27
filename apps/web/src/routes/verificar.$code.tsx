/**
 * Verificação pública (§5): pelo código do certificado, mostra quem assinou e quando, os hashes
 * SHA-256 e deixa conferir um arquivo no próprio navegador (o arquivo não sai do computador).
 */
import { Badge, Button, Input, Skeleton } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FileCheck2, FileX2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout, Notice } from "../components/auth-layout";
import { api, unwrap } from "../lib/api";
import { SIGNATURE_TONE, SIGNER_TONE, sha256OfFile } from "../lib/finance";

export const Route = createFileRoute("/verificar/$code")({ component: VerifyPage });

const when = (iso: string | null, locale: string) =>
  iso
    ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso))
    : "—";

function VerifyPage() {
  const { t, i18n } = useTranslation();
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const [other, setOther] = useState("");
  const [check, setCheck] = useState<{ name: string; hash: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useQuery({
    queryKey: ["public-verify", code],
    queryFn: () => unwrap(api.public.verify[":code"].$get({ param: { code } })),
    retry: false,
  });
  const lookup = (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (other.trim())
          void navigate({ to: "/verificar/$code", params: { code: other.trim().toUpperCase() } });
      }}
    >
      <Input
        aria-label={t("verify.otherCode")}
        placeholder="XXXX-XXXX-XXXX"
        className="font-mono uppercase"
        value={other}
        onChange={(e) => setOther(e.target.value)}
      />
      <Button type="submit" variant="outline">
        {t("verify.check")}
      </Button>
    </form>
  );

  if (q.isPending)
    return (
      <AuthLayout title={t("verify.title")}>
        <Skeleton className="h-40" />
      </AuthLayout>
    );
  if (q.isError)
    return (
      <AuthLayout title={t("verify.title")}>
        <div className="grid gap-4">
          <Notice tone="error">{t("verify.notFound", { code })}</Notice>
          {lookup}
        </div>
      </AuthLayout>
    );
  const v = q.data;
  const match =
    check && (check.hash === v.signedSha256 ? "signed" : check.hash === v.documentSha256 ? "original" : null);
  return (
    <AuthLayout title={t("verify.title")} description={t("verify.subtitle")}>
      <div className="grid gap-4 text-sm">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{v.title}</span>
            <Badge variant={SIGNATURE_TONE[v.status]}>{t(`signatures.status.${v.status}`)}</Badge>
          </div>
          <span className="text-muted-foreground">
            {v.workspace} · <span className="font-mono">{code.toUpperCase()}</span>
          </span>
          <span className="text-muted-foreground">
            {v.completedAt
              ? t("verify.completed", { date: when(v.completedAt, i18n.language) })
              : t("verify.sent", { date: when(v.sentAt, i18n.language) })}
          </span>
        </div>
        <section aria-labelledby="v-signers" className="grid gap-1.5">
          <h2 id="v-signers" className="text-xs font-medium text-muted-foreground">
            {t("sign.signers")}
          </h2>
          {v.signers.map((s) => (
            <div key={s.email} className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="block truncate">{s.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {s.email}
                  {s.signedAt ? ` · ${when(s.signedAt, i18n.language)}` : ""}
                </span>
              </span>
              <Badge variant={SIGNER_TONE[s.status]}>{t(`signatures.signerStatus.${s.status}`)}</Badge>
            </div>
          ))}
        </section>
        <section aria-labelledby="v-hash" className="grid gap-1.5">
          <h2 id="v-hash" className="text-xs font-medium text-muted-foreground">
            SHA-256
          </h2>
          {v.signedSha256 && (
            <p>
              <span className="text-xs text-muted-foreground">{t("verify.signedHash")}</span>
              <code className="block break-all font-mono text-xs">{v.signedSha256}</code>
            </p>
          )}
          <p>
            <span className="text-xs text-muted-foreground">{t("verify.originalHash")}</span>
            <code className="block break-all font-mono text-xs">{v.documentSha256}</code>
          </p>
        </section>
        <div className="grid gap-2 rounded-md border border-dashed p-3">
          <p className="text-muted-foreground">{t("verify.compareText")}</p>
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload /> {t("verify.compare")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            aria-label={t("verify.compare")}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) setCheck({ name: f.name, hash: await sha256OfFile(f) });
            }}
          />
          {check &&
            (match ? (
              <Notice tone="success">
                <FileCheck2 className="mr-1 inline size-4" />
                {t(match === "signed" ? "verify.matchSigned" : "verify.matchOriginal", { name: check.name })}
              </Notice>
            ) : (
              <Notice tone="error">
                <FileX2 className="mr-1 inline size-4" />
                {t("verify.noMatch", { name: check.name })}
              </Notice>
            ))}
        </div>
        <div className="grid gap-1.5 border-t pt-3">
          <span className="text-xs text-muted-foreground">{t("verify.otherCode")}</span>
          {lookup}
        </div>
      </div>
    </AuthLayout>
  );
}
