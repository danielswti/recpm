import { Button, Field, Input } from "@recpm/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthLayout, Notice } from "../components/auth-layout";
import { authClient, ba } from "../lib/auth-client";
import { errorMessage } from "../lib/errors";

export const Route = createFileRoute("/esqueci-senha")({ component: Forgot });

function Forgot() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!z.email().safeParse(email).success) return setError(t("validation.email"));
    setState("busy");
    setError(null);
    try {
      await ba(
        authClient.requestPasswordReset({ email, redirectTo: `${window.location.origin}/redefinir-senha` }),
      );
      setState("sent");
    } catch (e) {
      setError(errorMessage(t, e));
      setState("idle");
    }
  };

  return (
    <AuthLayout
      title={t("forgot.title")}
      description={t("forgot.description")}
      footer={
        <Link to="/entrar" className="font-medium text-primary hover:underline">
          {t("common.back")}
        </Link>
      }
    >
      {state === "sent" ? (
        <Notice tone="success">{t("forgot.sent")}</Notice>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field id="email" label={t("common.email")}>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={state === "busy"}>
            {t("forgot.submit")}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
