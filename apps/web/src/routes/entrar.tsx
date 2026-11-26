import { zodResolver } from "@hookform/resolvers/zod";
import { Button, Field, Input } from "@recpm/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthLayout, Notice } from "../components/auth-layout";
import { authClient, ba } from "../lib/auth-client";
import { errorMessage } from "../lib/errors";
import { fieldError, invalid } from "../lib/forms";
import { guestOnly, safeRedirect } from "../lib/guards";
import { meQuery } from "../lib/queries";

export const Route = createFileRoute("/entrar")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: ({ context }) => guestOnly(context.queryClient),
  component: Login,
});

const loginSchema = z.object({
  email: z.email("validation.email"),
  password: z.string().min(1, "validation.required"),
});

function Login() {
  const { t } = useTranslation();
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<"password" | "2fa">("password");
  const [error, setError] = useState<string | null>(null);

  const done = async () => {
    await qc.invalidateQueries({ queryKey: meQuery.queryKey });
    await navigate({ to: safeRedirect(redirect) });
  };

  const form = useForm({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });
  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setError(null);
    try {
      const data = await ba(authClient.signIn.email({ email, password, rememberMe: true }));
      if ("twoFactorRedirect" in data && data.twoFactorRedirect) setStep("2fa");
      else await done();
    } catch (e) {
      setError(errorMessage(t, e));
    }
  });

  // Convite: quem chega sem conta cria uma e volta para o convite.
  const inviteId = redirect?.match(/^\/convite\/([^/?#]+)/)?.[1];
  const e = form.formState.errors;

  if (step === "2fa") return <TwoFactorStep onDone={done} />;

  return (
    <AuthLayout
      title={t("login.title")}
      description={t("login.subtitle")}
      footer={
        <>
          {t("login.noAccount")}{" "}
          <Link
            to="/cadastro"
            search={{ convite: inviteId }}
            className="font-medium text-primary hover:underline"
          >
            {t("login.signup")}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Field id="email" label={t("common.email")} error={fieldError(t, e.email)}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            {...invalid("email", e.email)}
            {...form.register("email")}
          />
        </Field>
        <Field id="password" label={t("common.password")} error={fieldError(t, e.password)}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            {...invalid("password", e.password)}
            {...form.register("password")}
          />
        </Field>
        <div className="flex justify-end">
          <Link to="/esqueci-senha" className="text-sm text-primary hover:underline">
            {t("login.forgot")}
          </Link>
        </div>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {t("login.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

function TwoFactorStep({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (mode === "totp" && !/^\d{6}$/.test(code)) return setError(t("validation.code"));
    setBusy(true);
    setError(null);
    try {
      if (mode === "totp") await ba(authClient.twoFactor.verifyTotp({ code, trustDevice }));
      else await ba(authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice }));
      await onDone();
    } catch (e) {
      setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t("twoFactor.title")}
      description={mode === "totp" ? t("twoFactor.description") : undefined}
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Field id="code" label={mode === "totp" ? t("twoFactor.code") : t("twoFactor.backupCode")}>
          <Input
            id="code"
            autoFocus
            autoComplete="one-time-code"
            inputMode={mode === "totp" ? "numeric" : "text"}
            maxLength={mode === "totp" ? 6 : 32}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />
          {t("twoFactor.trustDevice")}
        </label>
        <Button type="submit" disabled={busy}>
          {t("twoFactor.submit")}
        </Button>
        <Button
          type="button"
          variant="link"
          onClick={() => {
            setMode(mode === "totp" ? "backup" : "totp");
            setCode("");
            setError(null);
          }}
        >
          {mode === "totp" ? t("twoFactor.useBackup") : t("twoFactor.useTotp")}
        </Button>
      </form>
    </AuthLayout>
  );
}
