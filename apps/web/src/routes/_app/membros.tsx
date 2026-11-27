import { INVITABLE_ROLES, type TenantRole } from "@recpm/shared";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Mail, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { Notice } from "../../components/auth-layout";
import { PageHeader } from "../../components/page-header";
import { authClient, ba } from "../../lib/auth-client";
import { errorMessage } from "../../lib/errors";
import { membersQuery, meQuery } from "../../lib/queries";
import { limitCodeOf } from "../../lib/upgrade-modal";

export const Route = createFileRoute("/_app/membros")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("members.read")) throw redirect({ to: "/" });
  },
  component: Members,
});

const invitationsKey = ["invitations"] as const;

function Members() {
  const { t, i18n } = useTranslation();
  const { data: me } = useSuspenseQuery(meQuery);
  const members = useQuery(membersQuery);
  const canInvite = !!me?.tenant?.permissions.includes("members.invite");
  const qc = useQueryClient();

  const invitations = useQuery({
    queryKey: invitationsKey,
    queryFn: () => ba(authClient.organization.listInvitations()),
    enabled: canInvite,
    select: (rows) => rows.filter((i) => i.status === "pending"),
  });

  const cancel = useMutation({
    mutationFn: (invitationId: string) => ba(authClient.organization.cancelInvitation({ invitationId })),
    onSuccess: () => {
      toast.success(t("members.inviteCanceled"));
      return qc.invalidateQueries({ queryKey: invitationsKey });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  const dateFmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });

  return (
    <>
      <PageHeader
        title={t("members.title")}
        description={t("members.subtitle")}
        actions={canInvite && me?.tenant ? <InviteDialog role={me.tenant.role} /> : null}
      />

      <Card className="overflow-hidden">
        {members.isPending ? (
          <div className="grid gap-2 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : members.isError ? (
          <div className="p-4">
            <Notice tone="error">{errorMessage(t, members.error)}</Notice>
          </div>
        ) : (
          <ul className="divide-y">
            {members.data.data.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={m.name} src={m.image} />
                <div className="grid min-w-0 flex-1">
                  <span className="truncate font-medium">
                    {m.name}
                    {m.userId === me?.user.id && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        ({t("members.you")})
                      </span>
                    )}
                  </span>
                  <span className="truncate text-sm text-muted-foreground">{m.email}</span>
                </div>
                <Badge variant="secondary">{t(`roles.${m.role}`)}</Badge>
                {!m.active && <Badge variant="destructive">{t("members.inactive")}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {members.data?.data.length === 1 && canInvite ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("members.empty")}</p>
      ) : null}

      {canInvite && !!invitations.data?.length && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t("members.pending")}</h2>
          <Card className="overflow-hidden">
            <ul className="divide-y">
              {invitations.data.map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 px-4 py-3">
                  <Mail className="size-4 text-muted-foreground" />
                  <div className="grid min-w-0 flex-1">
                    <span className="truncate">{inv.email}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("members.expiresAt", { date: dateFmt.format(new Date(inv.expiresAt)) })}
                    </span>
                  </div>
                  <Badge variant="outline">{t(`roles.${inv.role}`)}</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("members.cancelInvite")}
                    title={t("members.cancelInvite")}
                    onClick={() => cancel.mutate(inv.id)}
                    disabled={cancel.isPending}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </>
  );
}

function InviteDialog({ role }: { role: TenantRole }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // Cliente exige vínculo com um cliente cadastrado — o cadastro de clientes chega na Fase 3.
  const roles = INVITABLE_ROLES[role].filter((r) => r !== "cliente");
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<TenantRole>(
    roles.includes("funcionario") ? "funcionario" : (roles[0] ?? "funcionario"),
  );
  const [formError, setFormError] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: () =>
      ba(
        authClient.organization.inviteMember({
          email,
          role: newRole as never,
        }),
      ),
    // Limite do plano: o modal de upgrade assume (aberto pelo MutationCache); este diálogo fecha.
    onError: (e) => {
      if (limitCodeOf(e)) setOpen(false);
    },
    onSuccess: async () => {
      toast.success(t("members.inviteSent", { email }));
      setOpen(false);
      setEmail("");
      await qc.invalidateQueries({ queryKey: invitationsKey });
    },
  });

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!z.email().safeParse(email).success) return setFormError(t("validation.email"));
    setFormError(null);
    invite.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        invite.reset();
        setFormError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserPlus /> {t("members.invite")}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t("members.inviteTitle")}</DialogTitle>
          <DialogDescription>{t("members.inviteDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {invite.error ? <Notice tone="error">{errorMessage(t, invite.error)}</Notice> : null}
          <Field id="inv-email" label={t("common.email")} error={formError ?? undefined}>
            <Input
              id="inv-email"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field id="inv-role" label={t("members.role")} hint={t("members.clientRoleLater")}>
            <Select id="inv-role" value={newRole} onChange={(e) => setNewRole(e.target.value as TenantRole)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={invite.isPending}>
              {t("members.invite")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
