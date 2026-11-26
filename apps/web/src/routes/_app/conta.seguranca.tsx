import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from "@recpm/ui";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import QRCode from "qrcode";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Notice } from "../../components/auth-layout";
import { PageHeader } from "../../components/page-header";
import { authClient, ba } from "../../lib/auth-client";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";

export const Route = createFileRoute("/_app/conta/seguranca")({ component: Security });

type Setup = { qr: string; secret: string; backupCodes: string[] };

function Security() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const enabled = !!me?.user.twoFactorEnabled;

  const [step, setStep] = useState<"idle" | "password" | "scan">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep("idle");
    setPassword("");
    setCode("");
    setSetup(null);
    setError(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const confirmPassword = (ev: React.FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      if (enabled) {
        await ba(authClient.twoFactor.disable({ password }));
        toast.success(t("security.disabledToast"));
        reset();
        await qc.invalidateQueries({ queryKey: meQuery.queryKey });
        return;
      }
      const data = await ba(authClient.twoFactor.enable({ password }));
      if (!("totpURI" in data)) throw new Error("2FA: resposta inesperada");
      const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
      const qr = await QRCode.toDataURL(data.totpURI, { margin: 1, width: 200 });
      setSetup({ qr, secret, backupCodes: data.backupCodes });
      setPassword("");
      setStep("scan");
    });
  };

  const verify = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError(t("validation.code"));
    void run(async () => {
      await ba(authClient.twoFactor.verifyTotp({ code }));
      toast.success(t("security.enabledToast"));
      reset();
      await qc.invalidateQueries({ queryKey: meQuery.queryKey });
    });
  };

  return (
    <>
      <PageHeader title={t("security.title")} />
      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{t("security.twoFactorTitle")}</CardTitle>
            <Badge variant={enabled ? "success" : "secondary"}>
              {enabled ? t("security.enabled") : t("security.disabled")}
            </Badge>
          </div>
          <CardDescription>{t("security.twoFactorDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error ? <Notice tone="error">{error}</Notice> : null}

          {step === "idle" && (
            <div>
              <Button variant={enabled ? "outline" : "default"} onClick={() => setStep("password")}>
                {enabled ? t("security.disable") : t("security.enable")}
              </Button>
            </div>
          )}

          {step === "password" && (
            <form onSubmit={confirmPassword} className="grid max-w-sm gap-3" noValidate>
              <Field id="2fa-pw" label={t("common.password")} hint={t("security.confirmPassword")}>
                <Input
                  id="2fa-pw"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant={enabled ? "destructive" : "default"}
                  disabled={busy || !password}
                >
                  {t("common.continue")}
                </Button>
                <Button type="button" variant="ghost" onClick={reset}>
                  {t("common.cancel")}
                </Button>
              </div>
            </form>
          )}

          {step === "scan" && setup && (
            <form onSubmit={verify} className="grid gap-4" noValidate>
              <p className="text-sm">{t("security.scan")}</p>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <img src={setup.qr} alt="QR code" className="size-[200px] rounded-md bg-white p-2" />
                <div className="grid gap-2 text-sm">
                  <span className="text-muted-foreground">{t("security.manualKey")}</span>
                  <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                    {setup.secret}
                  </code>
                </div>
              </div>
              <div className="grid gap-2">
                <p className="text-sm font-medium">{t("security.backupCodes")}</p>
                <p className="text-xs text-muted-foreground">{t("security.backupHint")}</p>
                <ul className="grid grid-cols-2 gap-1 rounded-md bg-muted p-3 font-mono text-xs sm:grid-cols-5">
                  {setup.backupCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <Field id="2fa-code" label={t("twoFactor.code")}>
                <Input
                  id="2fa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  className="max-w-40"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {t("security.verify")}
                </Button>
                <Button type="button" variant="ghost" onClick={reset}>
                  {t("common.cancel")}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </>
  );
}
