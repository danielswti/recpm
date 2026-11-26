import { Button } from "@recpm/ui";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AuthLayout, Notice } from "../components/auth-layout";
import { authClient, ba } from "../lib/auth-client";
import { errorMessage } from "../lib/errors";
import { requireUser } from "../lib/guards";
import { meQuery } from "../lib/queries";

/** Link do e-mail de convite. Exige login (ou cadastro) com o e-mail convidado e e-mail confirmado. */
export const Route = createFileRoute("/convite/$id")({
  beforeLoad: ({ context, location }) => requireUser(context.queryClient, location.href),
  component: Invitation,
});

function Invitation() {
  const { t } = useTranslation();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const [resent, setResent] = useState(false);

  const inv = useQuery({
    queryKey: ["invitation", id],
    queryFn: () => ba(authClient.organization.getInvitation({ query: { id } })),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: async () => {
      await ba(authClient.organization.acceptInvitation({ invitationId: id }));
      await ba(authClient.organization.setActive({ organizationId: inv.data?.organizationId ?? null }));
    },
    onSuccess: async () => {
      await qc.invalidateQueries();
      await navigate({ to: "/" });
    },
  });

  const reject = useMutation({
    mutationFn: () => ba(authClient.organization.rejectInvitation({ invitationId: id })),
    onSuccess: async () => {
      toast.success(t("invite.rejected"));
      await navigate({ to: "/" });
    },
  });

  const resend = async () => {
    if (!me) return;
    await authClient.sendVerificationEmail({
      email: me.user.email,
      callbackURL: `${window.location.origin}/convite/${id}`,
    });
    setResent(true);
  };

  const switchAccount = async () => {
    await authClient.signOut();
    qc.clear();
    await navigate({ to: "/entrar", search: { redirect: `/convite/${id}` } });
  };

  const err = accept.error ?? reject.error;
  const isVerifyError = (e: unknown) =>
    !!e && typeof e === "object" && "code" in e && String(e.code).startsWith("EMAIL_VERIFICATION_REQUIRED");
  // O Better Auth só mostra/aceita o convite depois que o e-mail convidado é confirmado.
  const needsVerify = isVerifyError(err) || isVerifyError(inv.error);

  const verifyNotice = (
    <Notice tone="info">
      <p>{t("invite.needVerify")}</p>
      {resent ? (
        <p className="mt-1 font-medium">{t("invite.resent")}</p>
      ) : (
        <Button variant="link" className="h-auto px-0" onClick={resend}>
          {t("invite.resend")}
        </Button>
      )}
    </Notice>
  );

  return (
    <AuthLayout
      title={t("invite.title")}
      footer={
        <span>
          {t("invite.signedInAs", { email: me?.user.email })}{" "}
          <button type="button" onClick={switchAccount} className="font-medium text-primary hover:underline">
            {t("invite.switchAccount")}
          </button>
        </span>
      }
    >
      {inv.isPending ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : needsVerify && !inv.data ? (
        verifyNotice
      ) : inv.isError || !inv.data ? (
        <Notice tone="error">{t("invite.notFound")}</Notice>
      ) : (
        <div className="grid gap-4">
          <p>
            {t("invite.description", {
              inviter: inv.data.inviterEmail,
              workspace: inv.data.organizationName,
              role: t(`roles.${inv.data.role}`),
            })}
          </p>
          {needsVerify ? verifyNotice : err ? <Notice tone="error">{errorMessage(t, err)}</Notice> : null}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
              {t("invite.accept")}
            </Button>
            <Button variant="outline" onClick={() => reject.mutate()} disabled={reject.isPending}>
              {t("invite.reject")}
            </Button>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
