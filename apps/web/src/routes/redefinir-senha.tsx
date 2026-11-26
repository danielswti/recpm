import { passwordSchema } from "@recpm/shared";
import { Button, Field, Input } from "@recpm/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthLayout, Notice } from "../components/auth-layout";
import { authClient, ba } from "../lib/auth-client";
import { errorMessage } from "../lib/errors";

/** Destino do link do e-mail: o Better Auth redireciona para cá com ?token=… (ou ?error=INVALID_TOKEN). */
export const Route = createFileRoute("/redefinir-senha")({
  validateSearch: z.object({ token: z.string().optional(), error: z.string().optional() }),
  component: Reset,
});

function Reset() {
  const { t } = useTranslation();
  const { token, error: linkError } = Route.useSearch();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!passwordSchema.safeParse(pw).success) return setError(t("validation.passwordMin", { min: 10 }));
    if (pw !== pw2) return setError(t("reset.mismatch"));
    setState("busy");
    setError(null);
    try {
      await ba(authClient.resetPassword({ newPassword: pw, token: token ?? "" }));
      setState("done");
    } catch (e) {
      setError(errorMessage(t, e));
      setState("idle");
    }
  };

  const footer = (
    <Link to="/entrar" className="font-medium text-primary hover:underline">
      {t("login.submit")}
    </Link>
  );

  if (!token || linkError)
    return (
      <AuthLayout
        title={t("reset.title")}
        footer={
          <Link to="/esqueci-senha" className="font-medium text-primary hover:underline">
            {t("forgot.title")}
          </Link>
        }
      >
        <Notice tone="error">{t("reset.invalidToken")}</Notice>
      </AuthLayout>
    );

  return (
    <AuthLayout title={t("reset.title")} footer={footer}>
      {state === "done" ? (
        <Notice tone="success">{t("reset.done")}</Notice>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field id="pw" label={t("reset.newPassword")} hint={t("validation.passwordMin", { min: 10 })}>
            <Input
              id="pw"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          </Field>
          <Field id="pw2" label={t("reset.confirm")}>
            <Input
              id="pw2"
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={state === "busy"}>
            {t("reset.submit")}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
