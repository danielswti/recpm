/** Perfil do usuário do portal: nome, senha e idioma. */
import { Button, Card, cn, Field, Input } from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { authClient, ba } from "../lib/auth-client";
import { errorMessage } from "../lib/errors";
import { LOCALES } from "../lib/i18n";
import { portalHomeQuery } from "../lib/portal";

export const Route = createFileRoute("/cliente/perfil")({ component: PortalProfile });

function PortalProfile() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const home = useQuery(portalHomeQuery).data;
  const [name, setName] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const saveName = useMutation({
    mutationFn: () => ba(authClient.updateUser({ name: (name ?? "").trim() })),
    onSuccess: () => {
      toast.success(t("portal.profile.saved"));
      setName(null);
      void qc.invalidateQueries({ queryKey: ["portal"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const savePassword = useMutation({
    mutationFn: () =>
      ba(
        authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true }),
      ),
    onSuccess: () => {
      toast.success(t("portal.profile.passwordChanged"));
      setCurrent("");
      setNext("");
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  if (!home) return null;
  return (
    <div className="grid max-w-xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("portal.profile.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {home.user.email} · {home.client.name}
        </p>
      </div>
      <Card className="p-4">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveName.mutate();
          }}
        >
          <Field id="pf-name" label={t("common.name")}>
            <Input
              id="pf-name"
              required
              minLength={2}
              maxLength={120}
              value={name ?? home.user.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-fit" disabled={name === null || saveName.isPending}>
            {t("common.save")}
          </Button>
        </form>
      </Card>
      <Card className="p-4">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            savePassword.mutate();
          }}
        >
          <h2 className="font-semibold">{t("portal.profile.password")}</h2>
          <Field id="pf-cur" label={t("portal.profile.currentPassword")}>
            <Input
              id="pf-cur"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field id="pf-new" label={t("portal.profile.newPassword")}>
            <Input
              id="pf-new"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-fit" disabled={savePassword.isPending}>
            {t("portal.profile.changePassword")}
          </Button>
        </form>
      </Card>
      <Card className="grid gap-2 p-4">
        <h2 className="font-semibold">{t("nav.language")}</h2>
        <div className="flex flex-wrap gap-2">
          {LOCALES.map((l) => (
            <Button
              key={l.code}
              variant="outline"
              size="sm"
              className={cn(i18n.language === l.code && "border-primary text-primary")}
              onClick={() => i18n.changeLanguage(l.code)}
            >
              {l.label}
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}
