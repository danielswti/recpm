import { INVITABLE_ROLES, type TenantRole } from "@recpm/shared";
import {
  Avatar,
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Mail, MoreHorizontal, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { Notice } from "../../components/auth-layout";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { MemberDialog } from "../../components/member-dialog";
import { PageHeader } from "../../components/page-header";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { authClient, ba } from "../../lib/auth-client";
import { clientsQuery } from "../../lib/clients";
import { errorMessage } from "../../lib/errors";
import { type Member, membersQuery, meQuery } from "../../lib/queries";
import { limitCodeOf } from "../../lib/upgrade-modal";

export const Route = createFileRoute("/_app/membros")({
  validateSearch: z.object({ tab: z.enum(["team", "clients"]).default("team") }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("members.read")) throw redirect({ to: "/" });
  },
  component: Members,
});

const invitationsKey = ["invitations"] as const;

function Members() {
  const { t, i18n } = useTranslation();
  const { tab } = Route.useSearch();
  const { data: me } = useSuspenseQuery(meQuery);
  const members = useQuery(membersQuery(tab));
  const perms = new Set(me?.tenant?.permissions ?? []);
  const canInvite = perms.has("members.invite");
  const canManage = perms.has("members.manage");
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Member | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "deactivate" | "reset"; member: Member } | null>(null);

  const invitations = useQuery({
    queryKey: invitationsKey,
    queryFn: () => ba(authClient.organization.listInvitations()),
    enabled: canInvite,
    select: (rows) =>
      rows.filter(
        (i) =>
          i.status === "pending" &&
          (tab === "clients" ? (i.role as string) === "cliente" : (i.role as string) !== "cliente"),
      ),
  });

  const cancel = useMutation({
    mutationFn: (invitationId: string) => ba(authClient.organization.cancelInvitation({ invitationId })),
    onSuccess: () => {
      toast.success(t("members.inviteCanceled"));
      return qc.invalidateQueries({ queryKey: invitationsKey });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const action = useMutation({
    mutationFn: async ({ kind, member }: { kind: "deactivate" | "reactivate" | "reset"; member: Member }) => {
      const param = { param: { id: member.id } };
      if (kind === "reset") return unwrapVoid(api.members[":id"]["reset-password"].$post(param));
      await unwrap(
        kind === "deactivate"
          ? api.members[":id"].deactivate.$post(param)
          : api.members[":id"].reactivate.$post(param),
      );
    },
    onSuccess: async (_r, { kind, member }) => {
      toast.success(t(`members.done.${kind}`, { name: member.name }));
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e) => {
      setConfirm(null);
      if (!limitCodeOf(e)) toast.error(errorMessage(t, e));
    },
  });

  const dateFmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });

  return (
    <>
      <PageHeader
        title={t("members.title")}
        description={t("members.subtitle")}
        actions={
          canInvite && me?.tenant ? <InviteDialog role={me.tenant.role} portal={tab === "clients"} /> : null
        }
      />
      <nav className="mb-4 flex gap-1 border-b" aria-label={t("members.title")}>
        {(["team", "clients"] as const).map((k) => (
          <Link
            key={k}
            to="/membros"
            search={{ tab: k }}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === k
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground",
            )}
          >
            {t(`members.tabs.${k}`)}
          </Link>
        ))}
      </nav>

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
        ) : !members.data.data.length ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {tab === "clients" ? t("members.emptyPortal") : t("members.empty")}
          </p>
        ) : (
          <ul className="divide-y">
            {members.data.data.map((m) => {
              const isSelf = m.userId === me?.user.id;
              return (
                <li key={m.id} className={cn("flex items-center gap-3 px-4 py-3", !m.active && "opacity-60")}>
                  <Avatar name={m.name} src={m.image} />
                  <div className="grid min-w-0 flex-1">
                    <span className="truncate font-medium">
                      {m.name}
                      {isSelf && (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          ({t("members.you")})
                        </span>
                      )}
                    </span>
                    <span className="truncate text-sm text-muted-foreground">
                      {[m.clientName ?? m.jobTitle, m.email].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  {m.isAccountManager && (
                    <Badge variant="outline" className="hidden sm:inline-flex">
                      {t("members.accountManager")}
                    </Badge>
                  )}
                  <Badge variant="secondary">{t(`roles.${m.role}`)}</Badge>
                  {!m.active && <Badge variant="destructive">{t("members.inactive")}</Badge>}
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("members.actionsFor", { name: m.name })}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(m)}>
                          {t("members.editProfile")}
                        </DropdownMenuItem>
                        {m.active && (
                          <DropdownMenuItem onSelect={() => setConfirm({ kind: "reset", member: m })}>
                            {t("members.resetPassword")}
                          </DropdownMenuItem>
                        )}
                        {!isSelf && (
                          <>
                            <DropdownMenuSeparator />
                            {m.active ? (
                              <DropdownMenuItem
                                className="text-destructive"
                                onSelect={() => setConfirm({ kind: "deactivate", member: m })}
                              >
                                {t("members.deactivate")}
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onSelect={() => action.mutate({ kind: "reactivate", member: m })}
                              >
                                {t("members.reactivate")}
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

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

      {editing && (
        <MemberDialog
          member={editing}
          isSelf={editing.userId === me?.user.id}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        destructive={confirm?.kind === "deactivate"}
        title={confirm ? t(`members.confirm.${confirm.kind}.title`, { name: confirm.member.name }) : ""}
        description={
          confirm ? t(`members.confirm.${confirm.kind}.text`, { email: confirm.member.email }) : undefined
        }
        confirmLabel={confirm ? t(`members.confirm.${confirm.kind}.confirm`) : ""}
        pending={action.isPending}
        onConfirm={() => confirm && action.mutate(confirm)}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

function InviteDialog({ role, portal }: { role: TenantRole; portal: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const roles = INVITABLE_ROLES[role];
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<TenantRole>(
    portal && roles.includes("cliente")
      ? "cliente"
      : roles.includes("funcionario")
        ? "funcionario"
        : (roles[0] ?? "funcionario"),
  );
  const [clientId, setClientId] = useState("");
  const clients = useQuery({ ...clientsQuery({ status: "active" }), enabled: open && newRole === "cliente" });
  const [formError, setFormError] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: () =>
      ba(
        authClient.organization.inviteMember({
          email,
          role: newRole as never,
          ...(newRole === "cliente" ? { clientId } : {}),
        } as never),
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
    if (newRole === "cliente" && !clientId) return setFormError(t("errors.CLIENT_REQUIRED"));
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
          <Field id="inv-role" label={t("members.role")}>
            <Select id="inv-role" value={newRole} onChange={(e) => setNewRole(e.target.value as TenantRole)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
          {newRole === "cliente" && (
            <Field id="inv-client" label={t("members.client")} hint={t("members.clientHint")}>
              <Select id="inv-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">—</option>
                {clients.data?.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
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
