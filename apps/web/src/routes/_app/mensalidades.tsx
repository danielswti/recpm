/**
 * Mensalidades (§6.6): MRR, ativas, canceladas e a receber em 30 dias; filtro
 * ativas/canceladas/todas; nova mensalidade avulsa; cancelar e reativar; cobranças de cada uma.
 */
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Ban, ListOrdered, Plus, Repeat, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { InstallmentsTable } from "../../components/finance/installments";
import { PageHeader } from "../../components/page-header";
import { api, unwrap } from "../../lib/api";
import { clientsQuery } from "../../lib/clients";
import { errorMessage } from "../../lib/errors";
import {
  brl,
  parseMoney,
  type SubscriptionFilter,
  subscriptionChargesQuery,
  subscriptionsQuery,
  todayYmd,
} from "../../lib/finance";
import { meQuery } from "../../lib/queries";
import { calendarDate } from "../../lib/work";

export const Route = createFileRoute("/_app/mensalidades")({
  validateSearch: z.object({ status: z.enum(["active", "canceled", "all"]).optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("finance.read")) throw redirect({ to: "/" });
  },
  component: SubscriptionsPage,
});

type Row = Awaited<ReturnType<NonNullable<ReturnType<typeof subscriptionsQuery>["queryFn"]>>>["data"][number];

function SubscriptionsPage() {
  const { t, i18n } = useTranslation();
  const L = i18n.language;
  const status: SubscriptionFilter = Route.useSearch().status ?? "active";
  const navigate = useNavigate({ from: "/mensalidades" });
  const qc = useQueryClient();
  const q = useQuery(subscriptionsQuery(status));
  const { data: me } = useQuery(meQuery);
  const canManage = !!me?.tenant?.permissions.includes("finance.manage");
  const [creating, setCreating] = useState(false);
  const [charges, setCharges] = useState<Row | null>(null);
  const [canceling, setCanceling] = useState<Row | null>(null);
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "ativa" | "cancelada" }) =>
      unwrap(api.finance.subscriptions[":id"].status.$post({ param: { id }, json: { status } })),
    onSuccess: (_, v) => {
      toast.success(t(v.status === "ativa" ? "subscriptions.reactivated" : "subscriptions.canceled"));
      setCanceling(null);
      void qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });

  const k = q.data?.kpis;
  const kpis = k
    ? [
        { key: "mrr", v: brl(k.mrrCents, L) },
        { key: "active", v: String(k.active) },
        { key: "canceled", v: String(k.canceled) },
        { key: "receivable30", v: brl(k.receivable30Cents, L) },
      ]
    : [];

  return (
    <>
      <PageHeader
        title={t("subscriptions.title")}
        description={t("subscriptions.subtitle")}
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("subscriptions.new")}
            </Button>
          ) : null
        }
      />
      <section aria-label={t("finance.kpisLabel")} className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {!k
          ? ["a", "b", "c", "d"].map((k) => <Skeleton key={k} className="h-20" />)
          : kpis.map((x) => (
              <Card key={x.key} className="p-4">
                <p className="truncate text-xl font-semibold tabular-nums">{x.v}</p>
                <p className="text-xs text-muted-foreground">{t(`subscriptions.kpi.${x.key}`)}</p>
              </Card>
            ))}
      </section>
      <div role="tablist" aria-label={t("subscriptions.filter")} className="mb-4 flex gap-1">
        {(["active", "canceled", "all"] as const).map((s) => (
          <Button
            key={s}
            role="tab"
            aria-selected={status === s}
            size="sm"
            variant={status === s ? "secondary" : "ghost"}
            onClick={() => void navigate({ search: { status: s === "active" ? undefined : s } })}
          >
            {t(`subscriptions.filters.${s}`)}
          </Button>
        ))}
      </div>
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.isError ? (
        <p className="text-destructive">{errorMessage(t, q.error)}</p>
      ) : !q.data.data.length ? (
        <EmptyState
          icon={<Repeat className="size-6" />}
          title={t("subscriptions.empty")}
          description={t("subscriptions.emptyText")}
        />
      ) : (
        <Card className="relative overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("subscriptions.cols.client")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("subscriptions.cols.amount")}</th>
                <th className="px-4 py-2 font-medium">{t("subscriptions.cols.due")}</th>
                <th className="px-4 py-2 font-medium">{t("subscriptions.cols.status")}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {q.data.data.map((s) => (
                <tr key={s.id} className="hover:bg-accent/40">
                  <td className="px-4 py-3">
                    <Link
                      to="/clientes/$id"
                      params={{ id: s.client.id }}
                      className="font-medium hover:underline"
                    >
                      {s.client.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {s.project ? (
                        <Link
                          to="/projetos/$id"
                          params={{ id: s.project.id }}
                          search={{ tab: "financeiro" }}
                          className="hover:underline"
                        >
                          {s.project.name}
                        </Link>
                      ) : (
                        s.client.code
                      )}
                      {" · "}
                      {t("subscriptions.since", { date: calendarDate(s.startedAt, L) })}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{brl(s.amountCents, L)}</td>
                  <td className="px-4 py-3">
                    {t("subscriptions.day", { day: s.dayOfMonth })}
                    {s.nextDueDate && s.status === "ativa" && (
                      <span className="block text-xs text-muted-foreground">
                        {t("finance.nextDue", { date: calendarDate(s.nextDueDate, L) })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {s.status === "cancelada" ? (
                        <Badge variant="secondary">
                          {t("subscriptions.canceledOn", { date: calendarDate(s.canceledAt, L) })}
                        </Badge>
                      ) : (
                        <Badge variant={s.upToDate ? "success" : "destructive"}>
                          {t(s.upToDate ? "finance.upToDate" : "finance.behind")}
                        </Badge>
                      )}
                      {s.contractId && <Badge variant="outline">{t("subscriptions.fromContract")}</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setCharges(s)}>
                        <ListOrdered /> {t("subscriptions.charges")}
                      </Button>
                      {canManage &&
                        !s.contractId &&
                        (s.status === "ativa" ? (
                          <Button size="sm" variant="ghost" onClick={() => setCanceling(s)}>
                            <Ban /> {t("subscriptions.cancel")}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={setStatus.isPending}
                            onClick={() => setStatus.mutate({ id: s.id, status: "ativa" })}
                          >
                            <RotateCcw /> {t("subscriptions.reactivate")}
                          </Button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {creating && <NewSubscriptionDialog onClose={() => setCreating(false)} />}
      {charges && <ChargesDialog sub={charges} canManage={canManage} onClose={() => setCharges(null)} />}
      <ConfirmDialog
        open={!!canceling}
        title={t("subscriptions.cancelTitle")}
        description={t("subscriptions.cancelText")}
        confirmLabel={t("subscriptions.cancel")}
        pending={setStatus.isPending}
        onConfirm={() => canceling && setStatus.mutate({ id: canceling.id, status: "cancelada" })}
        onClose={() => setCanceling(null)}
      />
    </>
  );
}

function ChargesDialog({ sub, canManage, onClose }: { sub: Row; canManage: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const q = useQuery(subscriptionChargesQuery(sub.id));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")} className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("subscriptions.chargesOf", { name: sub.client.name })}</DialogTitle>
          <DialogDescription>
            {t("subscriptions.chargesText", {
              amount: brl(sub.amountCents, i18n.language),
              day: sub.dayOfMonth,
            })}
          </DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <Skeleton className="h-32" />
        ) : q.isError ? (
          <p className="text-destructive">{errorMessage(t, q.error)}</p>
        ) : (
          <div className="-mx-6">
            <InstallmentsTable items={[...q.data.data].reverse()} canManage={canManage} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewSubscriptionDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const clients = useQuery(clientsQuery({ status: "active" }));
  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [startedAt, setStartedAt] = useState(todayYmd());
  const [day, setDay] = useState(String(Number(todayYmd().slice(8, 10))));
  const cents = parseMoney(amount);
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.finance.subscriptions.$post({
          json: { clientId, amountCents: cents ?? 0, dayOfMonth: Number(day), startedAt },
        }),
      ),
    onSuccess: () => {
      toast.success(t("subscriptions.created"));
      void qc.invalidateQueries({ queryKey: ["finance"] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t("subscriptions.new")}</DialogTitle>
          <DialogDescription>{t("subscriptions.newText")}</DialogDescription>
        </DialogHeader>
        <form
          id="sub-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (cents && clientId) create.mutate();
          }}
        >
          <Field id="sub-client" label={t("subscriptions.cols.client")} className="sm:col-span-2">
            <Select id="sub-client" required value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">{t("subscriptions.chooseClient")}</option>
              {clients.data?.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id="sub-amount"
            label={t("subscriptions.monthlyAmount")}
            error={amount && cents === null ? t("finance.invalidAmount") : undefined}
          >
            <Input
              id="sub-amount"
              inputMode="decimal"
              required
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field id="sub-day" label={t("subscriptions.dueDay")}>
            <Input
              id="sub-day"
              type="number"
              min={1}
              max={31}
              required
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </Field>
          <Field id="sub-start" label={t("subscriptions.startedAt")} className="sm:col-span-2">
            <Input
              id="sub-start"
              type="date"
              required
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="sub-form" disabled={!cents || !clientId || create.isPending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
