import type { Entitlements } from "@recpm/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Check, CreditCard, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { Notice } from "../../components/auth-layout";
import { PageHeader } from "../../components/page-header";
import { UsageMeter } from "../../components/usage-meter";
import { api, unwrap } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { date, daysUntil, money } from "../../lib/format";
import { billingQuery, meQuery } from "../../lib/queries";

export const Route = createFileRoute("/_app/assinatura")({
  validateSearch: z.object({ checkout: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("tenant.billing")) throw redirect({ to: "/" });
  },
  component: Billing,
});

type Plan = Awaited<ReturnType<NonNullable<typeof billingQuery.queryFn>>>["plans"][number];

function Billing() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { checkout } = Route.useSearch();
  const { data, isPending, error } = useQuery(billingQuery);
  const [confirm, setConfirm] = useState<Plan | null>(null);

  // Volta do checkout: o webhook pode levar alguns segundos; recarrega até o plano mudar.
  useEffect(() => {
    if (checkout !== "ok") return;
    toast.success(t("billing.checkoutReturn"));
    void navigate({ to: "/assinatura", search: {}, replace: true });
    const timers = [2000, 5000, 10000].map((ms) =>
      setTimeout(() => qc.invalidateQueries({ queryKey: ["billing"] }), ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [checkout, navigate, qc, t]);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["billing"] }),
      qc.invalidateQueries({ queryKey: ["entitlements"] }),
    ]);

  const change = useMutation({
    mutationFn: (planSlug: string) =>
      unwrap(api.billing["change-plan"].$post({ json: { planSlug, interval: "monthly" } })),
    onSuccess: async (r) => {
      setConfirm(null);
      if (r.mode === "checkout" && r.url) {
        window.location.assign(r.url);
        return;
      }
      toast.success(t(`billing.changed.${r.mode}`));
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const undo = useMutation({
    mutationFn: () => unwrap(api.billing["undo-scheduled"].$post()),
    onSuccess: async () => {
      toast.success(t("billing.undone"));
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const portal = useMutation({
    mutationFn: () => unwrap(api.billing.portal.$post()),
    onSuccess: (r) => window.open(r.url, "_blank", "noopener"),
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  if (isPending)
    return (
      <>
        <PageHeader title={t("billing.title")} />
        <Skeleton className="h-40" />
      </>
    );
  if (error || !data) return <Notice tone="error">{errorMessage(t, error)}</Notice>;

  const e = data.entitlements;
  const current = data.plans.find((p) => p.slug === e.plan.slug);
  const lang = i18n.language;

  /** O que o botão de cada plano faz (espelha planChangeFor da API). */
  const actionFor = (p: Plan): { label: string; disabled?: boolean; variant?: "default" | "outline" } => {
    const isCurrent = p.slug === e.plan.slug && e.status !== "trialing";
    if (isCurrent) return { label: t("billing.currentPlan"), disabled: true, variant: "outline" };
    if (p.priceIsStartingAt) return { label: t("billing.contactSales"), disabled: true, variant: "outline" };
    if (e.pendingPlan?.slug === p.slug)
      return { label: t("billing.scheduled"), disabled: true, variant: "outline" };
    if (p.priceMonthlyCents === 0)
      return e.status === "trialing"
        ? { label: t("billing.afterTrial"), disabled: true, variant: "outline" }
        : { label: t("billing.switch"), variant: "outline" };
    if (!e.hasPaidSubscription) return { label: t("billing.subscribe") };
    return p.priceMonthlyCents > (current?.priceMonthlyCents ?? 0)
      ? { label: t("billing.upgradeTo") }
      : { label: t("billing.switch"), variant: "outline" };
  };

  /** Downgrade e plano gratuito pedem confirmação (valem no fim do ciclo). */
  const choose = (p: Plan) => {
    const downgrade = e.hasPaidSubscription
      ? p.priceMonthlyCents < (current?.priceMonthlyCents ?? 0)
      : p.priceMonthlyCents === 0;
    if (downgrade) setConfirm(p);
    else change.mutate(p.slug);
  };

  return (
    <>
      <PageHeader
        title={t("billing.title")}
        description={t("billing.subtitle")}
        actions={
          e.hasPaidSubscription ? (
            <Button variant="outline" onClick={() => portal.mutate()} disabled={portal.isPending}>
              <CreditCard /> {t("billing.portal")} <ExternalLink className="size-3.5 opacity-60" />
            </Button>
          ) : null
        }
      />

      {!data.billingEnabled && (
        <div className="mb-4">
          <Notice tone="info">{t("billing.notConfigured")}</Notice>
        </div>
      )}

      <Card className="mb-8">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{e.plan.name}</CardTitle>
            <StatusBadge e={e} />
          </div>
          <CardDescription>{subscriptionLine(e, t, lang)}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <UsageMeter e={e} />
          {(e.pendingPlan || e.cancelAtPeriodEnd) && (
            <Notice tone="info">
              <span>
                {e.cancelAtPeriodEnd
                  ? t("billing.cancelScheduled", { date: date(e.currentPeriodEnd, lang) })
                  : t("billing.downgradeScheduled", {
                      plan: e.pendingPlan?.name,
                      date: date(e.currentPeriodEnd, lang),
                    })}
              </span>{" "}
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() => undo.mutate()}
                disabled={undo.isPending}
              >
                {t("billing.undo")}
              </Button>
            </Notice>
          )}
        </CardContent>
      </Card>

      <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t("billing.plans")}</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.plans.map((p) => {
          const a = actionFor(p);
          const highlight = p.slug === e.plan.slug;
          return (
            <Card
              key={p.slug}
              className={cn("flex flex-col", highlight && "border-primary ring-1 ring-primary")}
            >
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
                <p className="text-2xl font-semibold tracking-tight">
                  {p.priceMonthlyCents === 0 ? (
                    t("billing.free")
                  ) : (
                    <>
                      {p.priceIsStartingAt && (
                        <span className="mr-1 text-sm font-normal text-muted-foreground">
                          {t("billing.from")}
                        </span>
                      )}
                      {money(p.priceMonthlyCents, p.currency, lang)}
                      <span className="text-sm font-normal text-muted-foreground">
                        {t("billing.perMonth")}
                      </span>
                    </>
                  )}
                </p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <ul className="grid gap-1.5 text-sm">
                  <Feature>
                    {p.limits.tasksPerCycle === null
                      ? t("billing.f.tasksUnlimited")
                      : t("billing.f.tasks", {
                          n: new Intl.NumberFormat(lang).format(p.limits.tasksPerCycle),
                        })}
                  </Feature>
                  <Feature>
                    {p.limits.maxUsers === null
                      ? t("billing.f.usersUnlimited")
                      : t("billing.f.users", { n: p.limits.maxUsers })}
                  </Feature>
                  <Feature>{t("billing.f.storage", { n: p.limits.storageGb })}</Feature>
                  {(
                    [
                      "clientPortal",
                      "eSignature",
                      "aiAssistant",
                      "publicApi",
                      "advancedReports",
                      "customDomain",
                      "sso",
                    ] as const
                  )
                    .filter((f) => p.features[f])
                    .map((f) => (
                      <Feature key={f}>{t(`billing.feature.${f}`)}</Feature>
                    ))}
                </ul>
                <Button
                  className="mt-auto"
                  variant={a.variant ?? "default"}
                  disabled={
                    a.disabled ||
                    change.isPending ||
                    (!data.billingEnabled && !a.disabled && p.priceMonthlyCents > 0)
                  }
                  onClick={() => choose(p)}
                >
                  {a.label}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent closeLabel={t("common.cancel")}>
          <DialogHeader>
            <DialogTitle>{t("billing.confirmTitle", { plan: confirm?.name })}</DialogTitle>
            <DialogDescription>
              {t("billing.confirmText", { date: date(e.currentPeriodEnd, lang), plan: e.plan.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => confirm && change.mutate(confirm.slug)} disabled={change.isPending}>
              {t("billing.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const Feature = ({ children }: { children: React.ReactNode }) => (
  <li className="flex items-start gap-2">
    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
    <span>{children}</span>
  </li>
);

function StatusBadge({ e }: { e: Entitlements }) {
  const { t } = useTranslation();
  if (e.readOnly) return <Badge variant="destructive">{t("billing.status.readOnly")}</Badge>;
  const v = {
    trialing: "default",
    active: "success",
    past_due: "destructive",
    canceled: "secondary",
  } as const;
  return <Badge variant={v[e.status]}>{t(`billing.status.${e.status}`)}</Badge>;
}

function subscriptionLine(e: Entitlements, t: TFunction, lang: string) {
  if (e.status === "trialing" && e.trialEndsAt)
    return t("billing.trialLine", { count: daysUntil(e.trialEndsAt), date: date(e.trialEndsAt, lang) });
  if (e.status === "past_due" && e.graceEndsAt)
    return t("billing.pastDueLine", { date: date(e.graceEndsAt, lang) });
  if (e.plan.priceMonthlyCents === 0) return t("billing.freeLine");
  return t("billing.renewsLine", { date: date(e.currentPeriodEnd, lang) });
}
