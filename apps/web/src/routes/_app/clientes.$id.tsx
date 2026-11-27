import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Skeleton } from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Mail, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { ClientForm } from "../../components/client-form";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { authClient, ba } from "../../lib/auth-client";
import { clientQuery, formatDocument, portalUsersQuery } from "../../lib/clients";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { limitCodeOf } from "../../lib/upgrade-modal";

export const Route = createFileRoute("/_app/clientes/$id")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("clients.read")) throw redirect({ to: "/" });
  },
  component: ClientPage,
});

function ClientPage() {
  const { t, i18n } = useTranslation();
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery);
  const perms = new Set(me?.tenant?.permissions ?? []);
  const canManage = perms.has("clients.manage");
  const client = useQuery(clientQuery(id));
  const [confirm, setConfirm] = useState<"delete" | "toggle" | null>(null);
  const num = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["clients"] });

  const update = useMutation({
    mutationFn: (json: Record<string, unknown>) =>
      unwrap(api.clients[":id"].$patch({ param: { id }, json: json as never })),
    onSuccess: async () => {
      toast.success(t("clients.saved"));
      setConfirm(null);
      await refresh();
    },
    onError: (e) => {
      setConfirm(null);
      toast.error(errorMessage(t, e));
    },
  });
  const remove = useMutation({
    mutationFn: () => unwrapVoid(api.clients[":id"].$delete({ param: { id } })),
    onSuccess: async () => {
      toast.success(t("clients.deleted"));
      await refresh();
      await navigate({ to: "/clientes" });
    },
    onError: (e) => {
      setConfirm(null);
      toast.error(errorMessage(t, e));
    },
  });

  if (client.isPending) return <Skeleton className="h-64" />;
  if (client.isError) return <p className="text-destructive">{errorMessage(t, client.error)}</p>;
  const c = client.data;
  const stats = [
    { k: "projects", v: `${c.activeProjectCount} / ${c.projectCount}` },
    { k: "contracted", v: `${num.format(c.hours.contracted)} h` },
    { k: "invested", v: `${num.format(c.hours.invested)} h` },
    { k: "remaining", v: `${num.format(c.hours.remaining)} h`, bad: c.hours.remaining < 0 },
  ];

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link
          to="/clientes"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> {t("clients.title")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
          <Badge variant="outline" className="font-mono">
            {c.code}
          </Badge>
          {!c.active && <Badge variant="secondary">{t("clients.inactive")}</Badge>}
          {c.assetsLink && (
            <a
              href={c.assetsLink}
              target="_blank"
              rel="noreferrer"
              className="ml-auto flex items-center gap-1 text-sm text-primary hover:underline"
            >
              {t("clients.assets")} <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
        {c.document && <p className="text-sm text-muted-foreground">{formatDocument(c.document)}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.k} className="p-4">
            <p className="text-xs text-muted-foreground">{t(`clients.stats.${s.k}`)}</p>
            <p className={`mt-1 text-xl font-semibold tabular-nums ${s.bad ? "text-destructive" : ""}`}>
              {s.v}
            </p>
          </Card>
        ))}
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">{t("clients.hoursHelp")}</p>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("clients.data")}</CardTitle>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <ClientForm
                key={c.id}
                client={c}
                submitLabel={t("common.save")}
                pending={update.isPending}
                onSubmit={(v) => update.mutate(v)}
              />
            ) : (
              <dl className="grid gap-2 text-sm sm:grid-cols-[140px_1fr]">
                {(["email", "phone", "notes"] as const).map((k) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{t(`clients.fields.${k}`)}</dt>
                    <dd className="whitespace-pre-wrap">{c[k] ?? "—"}</dd>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          <PortalUsers
            clientId={id}
            canInvite={perms.has("members.invite") && c.active}
            canManage={perms.has("members.manage")}
          />
          {canManage && (
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="text-base">{t("clients.danger")}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                <Button variant="outline" onClick={() => setConfirm("toggle")}>
                  {c.active ? t("clients.deactivate") : t("clients.activate")}
                </Button>
                <Button variant="destructive" onClick={() => setConfirm("delete")}>
                  {t("clients.delete")}
                </Button>
                <p className="text-xs text-muted-foreground">{t("clients.deleteHelp")}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm === "toggle"}
        destructive={c.active}
        title={
          c.active
            ? t("clients.deactivateTitle", { name: c.name })
            : t("clients.activateTitle", { name: c.name })
        }
        description={c.active ? t("clients.deactivateText") : undefined}
        confirmLabel={c.active ? t("clients.deactivate") : t("clients.activate")}
        pending={update.isPending}
        onConfirm={() => update.mutate({ active: !c.active })}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={t("clients.deleteTitle", { name: c.name })}
        description={t("clients.deleteText")}
        confirmLabel={t("clients.delete")}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function PortalUsers({
  clientId,
  canInvite,
  canManage,
}: {
  clientId: string;
  canInvite: boolean;
  canManage: boolean;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const users = useQuery(portalUsersQuery(clientId));
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["clients", clientId] });
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short" });

  const invite = useMutation({
    mutationFn: () => ba(authClient.organization.inviteMember({ email, role: "cliente", clientId } as never)),
    onSuccess: async () => {
      toast.success(t("members.inviteSent", { email }));
      setEmail("");
      await refresh();
    },
    onError: (e) => {
      if (!limitCodeOf(e)) setFormError(errorMessage(t, e));
    },
  });
  const cancel = useMutation({
    mutationFn: (invitationId: string) => ba(authClient.organization.cancelInvitation({ invitationId })),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const toggle = useMutation({
    mutationFn: (u: { id: string; active: boolean }) =>
      unwrap(
        u.active
          ? api.members[":id"].deactivate.$post({ param: { id: u.id } })
          : api.members[":id"].reactivate.$post({ param: { id: u.id } }),
      ),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("clients.portal.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("clients.portal.text")}</p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {users.isPending ? (
          <Skeleton className="h-10" />
        ) : users.data?.data.length ? (
          <ul className="divide-y rounded-md border">
            {users.data.data.map((u) => (
              <li key={u.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                {u.kind === "invitation" && <Mail className="size-4 shrink-0 text-muted-foreground" />}
                <div className="grid min-w-0 flex-1">
                  <span className="truncate">{u.name ?? u.email}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {u.kind === "invitation"
                      ? t("clients.portal.pending", { date: date.format(new Date(u.expiresAt!)) })
                      : u.email}
                  </span>
                </div>
                {u.kind === "member" && !u.active && (
                  <Badge variant="secondary">{t("members.inactive")}</Badge>
                )}
                {u.kind === "invitation" && canInvite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("members.cancelInvite")}
                    onClick={() => cancel.mutate(u.id)}
                  >
                    <X />
                  </Button>
                )}
                {u.kind === "member" && canManage && (
                  <Button variant="ghost" size="sm" onClick={() => toggle.mutate(u)}>
                    {u.active ? t("members.deactivate") : t("members.reactivate")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("clients.portal.empty")}</p>
        )}
        {canInvite && (
          <form
            className="grid gap-2"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!z.email().safeParse(email).success) return setFormError(t("validation.email"));
              setFormError(null);
              invite.mutate();
            }}
          >
            <label htmlFor="portal-email" className="text-sm font-medium">
              {t("clients.portal.invite")}
            </label>
            <div className="flex gap-2">
              <Input
                id="portal-email"
                type="email"
                placeholder="nome@cliente.com"
                value={email}
                aria-invalid={!!formError}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" disabled={invite.isPending}>
                <UserPlus /> <span className="sr-only sm:not-sr-only">{t("members.invite")}</span>
              </Button>
            </div>
            {formError && (
              <p role="alert" className="text-xs text-destructive">
                {formError}
              </p>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
