import { zodResolver } from "@hookform/resolvers/zod";
import { passwordSchema, slugify, slugSchema } from "@recpm/shared";
import { Button, Field, Input } from "@recpm/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Trans, useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthLayout, Notice } from "../components/auth-layout";
import { api, unwrap } from "../lib/api";
import { authClient, ba } from "../lib/auth-client";
import { errorMessage } from "../lib/errors";
import { fieldError, invalid } from "../lib/forms";
import { guestOnly } from "../lib/guards";
import { meQuery } from "../lib/queries";

export const Route = createFileRoute("/cadastro")({
  validateSearch: z.object({ convite: z.string().optional() }),
  beforeLoad: ({ context }) => guestOnly(context.queryClient),
  component: Signup,
});

const base = {
  name: z.string().trim().min(2, "validation.required"),
  email: z.email("validation.email"),
  password: passwordSchema,
  acceptTerms: z.boolean().refine((v) => v, "validation.terms"),
};
const withWorkspace = z.object({
  ...base,
  workspaceName: z.string().trim().min(2, "validation.required").max(80),
  slug: slugSchema,
});
const invited = z.object({ ...base, workspaceName: z.string().optional(), slug: z.string().optional() });

function Signup() {
  const { t, i18n } = useTranslation();
  const { convite } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  // Se a conta foi criada mas o workspace falhou (ex.: endereço em uso), o reenvio só tenta o workspace.
  const [accountCreated, setAccountCreated] = useState(false);

  const form = useForm({
    resolver: zodResolver(convite ? invited : withWorkspace),
    defaultValues: { name: "", email: "", password: "", acceptTerms: false, workspaceName: "", slug: "" },
  });
  const e = form.formState.errors;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const origin = window.location.origin;
      if (!accountCreated) {
        await ba(
          authClient.signUp.email({
            name: v.name,
            email: v.email,
            password: v.password,
            locale: i18n.language,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            callbackURL: convite ? `${origin}/convite/${convite}` : `${origin}/`,
            // validado também no servidor (hook do Better Auth)
            acceptTerms: true,
          } as Parameters<typeof authClient.signUp.email>[0]),
        );
        setAccountCreated(true);
      }
      if (convite) {
        await qc.invalidateQueries({ queryKey: meQuery.queryKey });
        await navigate({ to: "/convite/$id", params: { id: convite } });
        return;
      }
      await unwrap(api.workspaces.$post({ json: { name: v.workspaceName ?? "", slug: v.slug ?? "" } }));
      await qc.invalidateQueries();
      await navigate({ to: "/" });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  });

  const nameField = form.register("workspaceName");

  return (
    <AuthLayout
      title={t("signup.title")}
      description={convite ? t("signup.invitedSubtitle") : t("signup.subtitle")}
      footer={
        <>
          {t("signup.haveAccount")}{" "}
          <Link
            to="/entrar"
            search={{ redirect: convite ? `/convite/${convite}` : undefined }}
            className="font-medium text-primary hover:underline"
          >
            {t("login.submit")}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Field id="name" label={t("signup.yourName")} error={fieldError(t, e.name)}>
          <Input
            id="name"
            autoComplete="name"
            autoFocus
            {...invalid("name", e.name)}
            {...form.register("name")}
          />
        </Field>
        <Field id="email" label={t("common.email")} error={fieldError(t, e.email)}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            {...invalid("email", e.email)}
            {...form.register("email")}
          />
        </Field>
        <Field id="password" label={t("common.password")} error={fieldError(t, e.password)}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...invalid("password", e.password)}
            {...form.register("password")}
          />
        </Field>
        {!convite && (
          <>
            <Field
              id="workspaceName"
              label={t("signup.workspaceName")}
              error={fieldError(t, e.workspaceName)}
            >
              <Input
                id="workspaceName"
                autoComplete="organization"
                {...invalid("workspaceName", e.workspaceName)}
                {...nameField}
                onChange={(ev) => {
                  void nameField.onChange(ev);
                  if (!slugTouched) form.setValue("slug", slugify(ev.target.value));
                }}
              />
            </Field>
            <Field
              id="slug"
              label={t("signup.workspaceSlug")}
              error={fieldError(t, e.slug)}
              hint={t("signup.slugHint")}
            >
              <Input
                id="slug"
                autoCapitalize="none"
                spellCheck={false}
                {...invalid("slug", e.slug)}
                {...form.register("slug", { onChange: () => setSlugTouched(true) })}
              />
            </Field>
          </>
        )}
        <div className="grid gap-1">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" {...form.register("acceptTerms")} />
            <span>
              <Trans
                i18nKey="signup.terms"
                components={{ terms: <ExtLink href="/termos" />, privacy: <ExtLink href="/privacidade" /> }}
              />
            </span>
          </label>
          {e.acceptTerms ? (
            <p role="alert" className="text-xs text-destructive">
              {t("validation.terms")}
            </p>
          ) : null}
        </div>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {t("signup.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** Link para os termos/política; o texto vem da tradução via <Trans>. */
function ExtLink({ href, children }: { href: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
      {children}
    </a>
  );
}
