import { PLAN_FEATURES, type PlanFeature } from "@recpm/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, MoreHorizontal, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { ThemeToggle } from "../components/theme-toggle";
import { api, unwrap } from "../lib/api";
import { authClient, ba } from "../lib/auth-client";
import { errorMessage } from "../lib/errors";
import { date, money } from "../lib/format";
import { requireUser } from "../lib/guards";
import { platformMetricsQuery, platformPlansQuery } from "../lib/queries";

/** Back-office da plataforma: só super_admin, fora de qualquer workspace. */
export const Route = createFileRoute("/plataforma")({
  validateSearch: z.object({
    tab: z.enum(["tenants", "planos"]).default("tenants"),
    q: z.string().optional(),
    status: z.enum(["active", "read_only", "suspended", "trialing", "past_due"]).optional(),
    page: z.number().int().min(1).optional(),
  }),
  beforeLoad: async ({ context, location }) => {
    const me = await requireUser(context.queryClient, location.href);
    if (me.user.platformRole !== "super_admin" || me.impersonating) throw redirect({ to: "/" });
  },
  component: Platform,
});

function Platform() {
  const { t } = useTranslation();
  const { tab } = Route.useSearch();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur">
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {t("platform.backToApp")}
        </Link>
        <span className="font-semibold">{t("platform.title")}</span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto grid max-w-7xl gap-6 p-4 md:p-8">
        <Metrics />
        <nav className="flex gap-1 border-b" aria-label={t("platform.title")}>
          {(["tenants", "planos"] as const).map((k) => (
            <Link
              key={k}
              to="/plataforma"
              search={{ tab: k }}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm",
                tab === k
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {t(`platform.tabs.${k}`)}
            </Link>
          ))}
        </nav>
        {tab === "tenants" ? <Tenants /> : <Plans />}
      </main>
    </div>
  );
}

function Metrics() {
  const { t, i18n } = useTranslation();
  const { data: m } = useQuery(platformMetricsQuery);
  const items = m
    ? [
        { k: "mrr", v: money(m.mrrCents, "BRL", i18n.language) },
        { k: "paying", v: m.payingTenants },
        { k: "total", v: m.tenants.total },
        { k: "trialing", v: m.tenants.trialing },
        { k: "trials7d", v: m.trialsEndingIn7Days },
        { k: "pastDue", v: m.tenants.pastDue },
        { k: "readOnly", v: m.tenants.readOnly },
        { k: "suspended", v: m.tenants.suspended },
      ]
    : [];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {m
        ? items.map((i) => (
            <Card key={i.k} className="p-4">
              <p className="text-xs text-muted-foreground">{t(`platform.metrics.${i.k}`)}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{i.v}</p>
            </Card>
          ))
        : ["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => <Skeleton key={k} className="h-[74px]" />)}
    </div>
  );
}

type Action = { kind: "suspend" | "impersonate" | "plan"; tenant: { id: string; name: string } };

function Tenants() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate({ from: "/plataforma" });
  const { q, status, page = 1 } = Route.useSearch();
  const qc = useQueryClient();
  const [search, setSearch] = useState(q ?? "");
  const [action, setAction] = useState<Action | null>(null);
  const list = useQuery({
    queryKey: ["platform", "tenants", q, status, page],
    queryFn: () => unwrap(api.platform.tenants.$get({ query: { q, status, page: String(page) } })),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["platform"] });
  const reactivate = useMutation({
    mutationFn: (id: string) => unwrap(api.platform.tenants[":id"].reactivate.$post({ param: { id } })),
    onSuccess: () => {
      toast.success(t("platform.done.reactivate"));
      return refresh();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  const lang = i18n.language;
  return (
    <section className="grid gap-4">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate({ search: (s) => ({ ...s, q: search || undefined, page: undefined }) });
        }}
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t("platform.search")}
            aria-label={t("platform.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          className="sm:w-56"
          aria-label={t("platform.filter")}
          value={status ?? ""}
          onChange={(e) =>
            void navigate({
              search: (s) => ({
                ...s,
                status: (e.target.value || undefined) as typeof status,
                page: undefined,
              }),
            })
          }
        >
          <option value="">{t("platform.allStatuses")}</option>
          {(["active", "trialing", "past_due", "read_only", "suspended"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`platform.status.${s}`)}
            </option>
          ))}
        </Select>
      </form>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              {["tenant", "plan", "usage", "members", "status", "created", ""].map((h) => (
                <th key={h} className="px-4 py-2 font-medium">
                  {h ? t(`platform.cols.${h}`) : <span className="sr-only">{t("platform.actions")}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.isPending ? (
              <tr>
                <td colSpan={7} className="p-4">
                  <Skeleton className="h-8" />
                </td>
              </tr>
            ) : !list.data?.data.length ? (
              <tr>
                <td colSpan={7} className="p-8 text-center text-muted-foreground">
                  {t("platform.empty")}
                </td>
              </tr>
            ) : (
              list.data.data.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.slug} · {row.adminEmail ?? "—"}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{row.plan.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.subscriptionStatus === "trialing" && row.trialEndsAt
                        ? t("platform.trialUntil", { date: date(row.trialEndsAt, lang) })
                        : t("platform.periodUntil", { date: date(row.currentPeriodEnd, lang) })}
                      {row.provider ? ` · ${row.provider}` : ""}
                    </div>
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {row.tasksCreated}
                    {row.tasksLimit === null ? "" : ` / ${row.tasksLimit}`}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{row.members}</td>
                  <td className="px-4 py-3">
                    <TenantBadge status={row.status} sub={row.subscriptionStatus} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{date(row.createdAt, lang)}</td>
                  <td className="px-2 py-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("platform.actionsFor", { name: row.name })}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setAction({ kind: "impersonate", tenant: row })}>
                          {t("platform.impersonate")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setAction({ kind: "plan", tenant: row })}>
                          {t("platform.assignPlan")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {row.status === "active" ? (
                          <DropdownMenuItem
                            className="text-destructive"
                            onSelect={() => setAction({ kind: "suspend", tenant: row })}
                          >
                            {t("platform.suspend")}
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onSelect={() => reactivate.mutate(row.id)}>
                            {t("platform.reactivate")}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
      {list.data && list.data.total > list.data.pageSize && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => void navigate({ search: (s) => ({ ...s, page: page - 1 }) })}
          >
            {t("platform.prev")}
          </Button>
          <span className="text-muted-foreground">
            {t("platform.pageOf", { page, pages: Math.ceil(list.data.total / list.data.pageSize) })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page * list.data.pageSize >= list.data.total}
            onClick={() => void navigate({ search: (s) => ({ ...s, page: page + 1 }) })}
          >
            {t("platform.next")}
          </Button>
        </div>
      )}
      {action && <ActionDialog action={action} onClose={() => setAction(null)} onDone={refresh} />}
    </section>
  );
}

function TenantBadge({ status, sub }: { status: string; sub: string }) {
  const { t } = useTranslation();
  if (status === "suspended") return <Badge variant="destructive">{t("platform.status.suspended")}</Badge>;
  if (status === "read_only") return <Badge variant="destructive">{t("platform.status.read_only")}</Badge>;
  if (sub === "past_due") return <Badge variant="destructive">{t("platform.status.past_due")}</Badge>;
  if (sub === "trialing") return <Badge>{t("platform.status.trialing")}</Badge>;
  return <Badge variant="success">{t("platform.status.active")}</Badge>;
}

function ActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: Action;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const plans = useQuery({ ...platformPlansQuery, enabled: action.kind === "plan" });
  const [reason, setReason] = useState("");
  const [planSlug, setPlanSlug] = useState("enterprise");
  const [months, setMonths] = useState(12);
  const id = action.tenant.id;

  const run = useMutation({
    mutationFn: async () => {
      if (action.kind === "suspend")
        await unwrap(api.platform.tenants[":id"].suspend.$post({ param: { id }, json: { reason } }));
      if (action.kind === "plan")
        await unwrap(api.platform.tenants[":id"].plan.$post({ param: { id }, json: { planSlug, months } }));
      if (action.kind === "impersonate") {
        const target = await unwrap(
          api.platform.tenants[":id"].impersonation.$post({ param: { id }, json: { reason } }),
        );
        await ba(authClient.admin.impersonateUser({ userId: target.userId }));
        await ba(authClient.organization.setActive({ organizationId: target.tenantId }));
      }
    },
    onSuccess: async () => {
      if (action.kind === "impersonate") {
        qc.clear();
        await navigate({ to: "/" });
        return;
      }
      toast.success(t(`platform.done.${action.kind}`));
      onClose();
      await onDone();
    },
  });

  const needsReason = action.kind !== "plan";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t(`platform.dialog.${action.kind}.title`, { name: action.tenant.name })}</DialogTitle>
          <DialogDescription>{t(`platform.dialog.${action.kind}.text`)}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          {run.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(t, run.error)}
            </p>
          ) : null}
          {needsReason && (
            <Field id="reason" label={t("platform.reason")}>
              <Input id="reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
          {action.kind === "plan" && (
            <>
              <Field id="plan" label={t("platform.plan")}>
                <Select id="plan" value={planSlug} onChange={(e) => setPlanSlug(e.target.value)}>
                  {plans.data?.data.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="months" label={t("platform.months")}>
                <Input
                  id="months"
                  type="number"
                  min={1}
                  max={36}
                  value={months}
                  onChange={(e) => setMonths(Number(e.target.value))}
                />
              </Field>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant={action.kind === "suspend" ? "destructive" : "default"}
              disabled={run.isPending || (needsReason && reason.trim().length < 3)}
            >
              {t(`platform.dialog.${action.kind}.confirm`)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type AdminPlan = Awaited<ReturnType<NonNullable<typeof platformPlansQuery.queryFn>>>["data"][number];

function Plans() {
  const { t, i18n } = useTranslation();
  const { data, isPending } = useQuery(platformPlansQuery);
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  if (isPending) return <Skeleton className="h-40" />;
  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {data?.data.map((p) => (
        <Card key={p.slug}>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{p.name}</CardTitle>
              {!p.isPublic && <Badge variant="secondary">{t("platform.hidden")}</Badge>}
              {!p.active && <Badge variant="destructive">{t("platform.inactive")}</Badge>}
            </div>
            <p className="text-lg font-semibold">
              {p.priceIsStartingAt ? `${t("billing.from")} ` : ""}
              {money(p.priceMonthlyCents, p.currency, i18n.language)}
              <span className="text-sm font-normal text-muted-foreground">{t("billing.perMonth")}</span>
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1">
              <dt className="text-muted-foreground">{t("platform.fields.tasks")}</dt>
              <dd>{p.limits.tasksPerCycle ?? "∞"}</dd>
              <dt className="text-muted-foreground">{t("platform.fields.users")}</dt>
              <dd>{p.limits.maxUsers ?? "∞"}</dd>
              <dt className="text-muted-foreground">Stripe</dt>
              <dd className="truncate">{p.stripePriceIds.monthly ?? "—"}</dd>
            </dl>
            <Button variant="outline" onClick={() => setEditing(p)}>
              {t("platform.editPlan")}
            </Button>
          </CardContent>
        </Card>
      ))}
      {editing && <PlanEditor plan={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** Edita preço, limites, recursos e ids no provedor. Campo de limite vazio = ilimitado. */
function PlanEditor({ plan, onClose }: { plan: AdminPlan; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const cents = (v: string) => Math.round(Number(v.replace(",", ".")) * 100);
  const reais = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2).replace(".", ","));
  const optInt = (v: string) => (v.trim() === "" ? null : Number.parseInt(v, 10));
  const [f, setF] = useState({
    name: plan.name,
    monthly: reais(plan.priceMonthlyCents),
    yearly: reais(plan.priceYearlyCents),
    startingAt: plan.priceIsStartingAt,
    tasks: plan.limits.tasksPerCycle?.toString() ?? "",
    users: plan.limits.maxUsers?.toString() ?? "",
    portalUsers: plan.limits.maxClientPortalUsers?.toString() ?? "",
    storage: String(plan.limits.storageGb),
    stripeMonthly: plan.stripePriceIds.monthly ?? "",
    stripeYearly: plan.stripePriceIds.yearly ?? "",
    isPublic: plan.isPublic,
    active: plan.active,
    features: { ...plan.features } as Record<PlanFeature, boolean>,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.platform.plans[":slug"].$patch({
          param: { slug: plan.slug },
          json: {
            name: f.name,
            priceMonthlyCents: cents(f.monthly || "0"),
            priceYearlyCents: f.yearly.trim() ? cents(f.yearly) : null,
            priceIsStartingAt: f.startingAt,
            isPublic: f.isPublic,
            active: f.active,
            features: f.features,
            stripePriceIds: {
              ...(f.stripeMonthly ? { monthly: f.stripeMonthly } : {}),
              ...(f.stripeYearly ? { yearly: f.stripeYearly } : {}),
            },
            limits: {
              tasksPerCycle: optInt(f.tasks),
              maxUsers: optInt(f.users),
              maxClientPortalUsers: optInt(f.portalUsers),
              storageGb: Number(f.storage) || 0,
              aiMessagesPerCycle: plan.limits.aiMessagesPerCycle,
            },
          },
        }),
      ),
    onSuccess: async () => {
      toast.success(t("platform.done.plan"));
      onClose();
      await qc.invalidateQueries({ queryKey: ["platform"] });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")} className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("platform.editPlanTitle", { name: plan.name })}</DialogTitle>
          <DialogDescription>{t("platform.editPlanText")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error ? (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {errorMessage(t, save.error)}
            </p>
          ) : null}
          <Field id="p-name" label={t("common.name")}>
            <Input id="p-name" value={f.name} onChange={set("name")} />
          </Field>
          <Field id="p-monthly" label={t("platform.fields.monthly")}>
            <Input id="p-monthly" inputMode="decimal" value={f.monthly} onChange={set("monthly")} />
          </Field>
          <Field id="p-yearly" label={t("platform.fields.yearly")} hint={t("platform.fields.blankNone")}>
            <Input id="p-yearly" inputMode="decimal" value={f.yearly} onChange={set("yearly")} />
          </Field>
          <Field id="p-tasks" label={t("platform.fields.tasks")} hint={t("platform.fields.blankUnlimited")}>
            <Input id="p-tasks" inputMode="numeric" value={f.tasks} onChange={set("tasks")} />
          </Field>
          <Field id="p-users" label={t("platform.fields.users")} hint={t("platform.fields.blankUnlimited")}>
            <Input id="p-users" inputMode="numeric" value={f.users} onChange={set("users")} />
          </Field>
          <Field
            id="p-portal"
            label={t("platform.fields.portalUsers")}
            hint={t("platform.fields.blankUnlimited")}
          >
            <Input id="p-portal" inputMode="numeric" value={f.portalUsers} onChange={set("portalUsers")} />
          </Field>
          <Field id="p-storage" label={t("platform.fields.storage")}>
            <Input id="p-storage" inputMode="numeric" value={f.storage} onChange={set("storage")} />
          </Field>
          <Field id="p-stripe-m" label={t("platform.fields.stripeMonthly")}>
            <Input
              id="p-stripe-m"
              value={f.stripeMonthly}
              onChange={set("stripeMonthly")}
              placeholder="price_…"
            />
          </Field>
          <Field id="p-stripe-y" label={t("platform.fields.stripeYearly")}>
            <Input
              id="p-stripe-y"
              value={f.stripeYearly}
              onChange={set("stripeYearly")}
              placeholder="price_…"
            />
          </Field>
          <fieldset className="grid gap-2 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">{t("platform.fields.features")}</legend>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {PLAN_FEATURES.map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={f.features[k]}
                    onChange={(e) =>
                      setF((s) => ({ ...s, features: { ...s.features, [k]: e.target.checked } }))
                    }
                  />
                  {t(`platform.feature.${k}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-4 text-sm sm:col-span-2">
            {(["startingAt", "isPublic", "active"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={f[k]} onChange={set(k)} />
                {t(`platform.fields.${k}`)}
              </label>
            ))}
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
