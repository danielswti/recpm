/**
 * Aba "Financeiro" do projeto: contratos (parcelado ou mensalidade), parcelas geradas
 * automaticamente, pagamentos, estornos, cancelar e reativar.
 */
import { CONTRACT_MODALITIES } from "@recpm/shared";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, Wallet } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import {
  brl,
  CONTRACT_TONE,
  type Contract,
  centsToInput,
  parseMoney,
  projectContractsQuery,
  splitPreview,
  todayYmd,
} from "../../lib/finance";
import { meQuery } from "../../lib/queries";
import { calendarDate } from "../../lib/work";
import { ConfirmDialog, textareaClass } from "../confirm-dialog";
import { InstallmentsTable } from "./installments";

export function ContractsTab({ projectId, hasClient }: { projectId: string; hasClient: boolean }) {
  const { t } = useTranslation();
  const q = useQuery(projectContractsQuery(projectId));
  const { data: me } = useQuery(meQuery);
  const canManage = !!me?.tenant?.permissions.includes("finance.manage");
  const [editing, setEditing] = useState<Contract | "new" | null>(null);

  if (q.isPending)
    return (
      <div className="grid max-w-4xl gap-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-40" />
      </div>
    );
  if (q.isError) return <p className="text-destructive">{errorMessage(t, q.error)}</p>;
  const newButton = canManage ? (
    <Button onClick={() => setEditing("new")}>
      <Plus /> {t("finance.newContract")}
    </Button>
  ) : null;
  return (
    <div className="grid max-w-4xl grid-cols-[minmax(0,1fr)] gap-4">
      {q.data.data.length ? (
        <>
          <div className="flex justify-end">{newButton}</div>
          {q.data.data.map((c) => (
            <ContractCard key={c.id} contract={c} canManage={canManage} onEdit={() => setEditing(c)} />
          ))}
        </>
      ) : (
        <EmptyState
          icon={<Wallet className="size-6" />}
          title={t("finance.noContracts")}
          description={t("finance.noContractsText")}
          action={newButton}
        />
      )}
      {editing && (
        <ContractDialog
          projectId={projectId}
          hasClient={hasClient}
          contract={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ContractCard({
  contract: c,
  canManage,
  onEdit,
}: {
  contract: Contract;
  canManage: boolean;
  onEdit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"cancel" | "delete" | null>(null);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const setStatus = (status: "ativo" | "cancelado") =>
    run.mutate(() => unwrap(api.contracts[":id"].status.$post({ param: { id: c.id }, json: { status } })));
  const pct = c.totalValueCents ? Math.min(100, Math.round((c.paidCents / c.totalValueCents) * 100)) : 0;
  const stats = [
    { k: "total", v: c.totalValueCents },
    { k: "paid", v: c.paidCents, tone: "text-success" },
    { k: "remaining", v: c.remainingCents },
    { k: "overdue", v: c.overdueCents, tone: c.overdueCents ? "text-destructive" : undefined },
  ];
  return (
    <Card className="min-w-0">
      <div className="flex flex-wrap items-start gap-3 border-b p-4">
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{t(`finance.modalities.${c.modality}`)}</h3>
            <Badge variant={CONTRACT_TONE[c.status]}>{t(`finance.contractStatus.${c.status}`)}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(c.modality === "mensalidade" ? "finance.monthlySummary" : "finance.installmentSummary", {
              count: c.installmentsCount,
              amount: brl(Math.round(c.totalValueCents / c.installmentsCount), i18n.language),
              date: calendarDate(c.firstDueDate, i18n.language),
            })}
          </p>
          {c.notes && <p className="text-sm text-muted-foreground">{c.notes}</p>}
        </div>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={t("finance.contractActions")}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {c.status !== "cancelado" && (
                <DropdownMenuItem onSelect={onEdit}>
                  <Pencil /> {t("finance.editTerms")}
                </DropdownMenuItem>
              )}
              {c.status === "cancelado" ? (
                <DropdownMenuItem onSelect={() => setStatus("ativo")}>
                  <RotateCcw /> {t("finance.reactivate")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => setConfirm("cancel")}>
                  <Ban /> {t("finance.cancelContract")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onSelect={() => setConfirm("delete")}>
                <Trash2 /> {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 border-b p-4 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.k}>
            <p className="text-xs text-muted-foreground">{t(`finance.stats.${s.k}`)}</p>
            <p className={`font-semibold tabular-nums ${s.tone ?? ""}`}>{brl(s.v, i18n.language)}</p>
          </div>
        ))}
        <div
          className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted sm:col-span-4"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("finance.progress", { pct })}
        >
          <div className="h-full bg-success" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <InstallmentsTable items={c.installments} canManage={canManage && c.status !== "cancelado"} />
      <ConfirmDialog
        open={confirm === "cancel"}
        title={t("finance.cancelTitle")}
        description={t("finance.cancelText")}
        confirmLabel={t("finance.cancelContract")}
        pending={run.isPending}
        onConfirm={() => setStatus("cancelado")}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={t("finance.deleteTitle")}
        description={t("finance.deleteText")}
        confirmLabel={t("common.delete")}
        pending={run.isPending}
        onConfirm={() => run.mutate(() => unwrapVoid(api.contracts[":id"].$delete({ param: { id: c.id } })))}
        onClose={() => setConfirm(null)}
      />
    </Card>
  );
}

function ContractDialog({
  projectId,
  hasClient,
  contract,
  onClose,
}: {
  projectId: string;
  hasClient: boolean;
  contract: Contract | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [modality, setModality] = useState<(typeof CONTRACT_MODALITIES)[number]>(
    contract?.modality ?? "parcelado",
  );
  const [total, setTotal] = useState(contract ? centsToInput(contract.totalValueCents, i18n.language) : "");
  const [count, setCount] = useState(String(contract?.installmentsCount ?? 1));
  const [first, setFirst] = useState(contract?.firstDueDate ?? todayYmd());
  const [notes, setNotes] = useState(contract?.notes ?? "");
  const cents = parseMoney(total);
  const n = Math.max(1, Math.min(120, Number(count) || 1));
  const preview = cents
    ? splitPreview(
        cents - (contract?.paidCents ?? 0),
        n - (contract ? contract.installments.filter((i) => i.status === "pago").length : 0),
      )
    : null;
  const save = useMutation({
    mutationFn: () => {
      const json = {
        modality,
        totalValueCents: cents ?? 0,
        installmentsCount: n,
        firstDueDate: first,
        notes: notes.trim() || null,
      };
      return contract
        ? unwrap(api.contracts[":id"].$patch({ param: { id: contract.id }, json }))
        : unwrap(api.projects[":id"].contracts.$post({ param: { id: projectId }, json }));
    },
    onSuccess: () => {
      toast.success(t(contract ? "finance.contractUpdated" : "finance.contractCreated"));
      void qc.invalidateQueries({ queryKey: ["finance"] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const monthlyBlocked = modality === "mensalidade" && !hasClient;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t(contract ? "finance.editTerms" : "finance.newContract")}</DialogTitle>
          <DialogDescription>
            {t(contract ? "finance.editTermsText" : "finance.newContractText")}
          </DialogDescription>
        </DialogHeader>
        <form
          id="contract-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (cents && !monthlyBlocked) save.mutate();
          }}
        >
          <Field id="c-modality" label={t("finance.modality")} className="sm:col-span-2">
            <Select
              id="c-modality"
              value={modality}
              onChange={(e) => setModality(e.target.value as typeof modality)}
            >
              {CONTRACT_MODALITIES.map((m) => (
                <option key={m} value={m}>
                  {t(`finance.modalities.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          {monthlyBlocked && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {t("finance.monthlyNeedsClient")}
            </p>
          )}
          <Field
            id="c-total"
            label={t("finance.totalValue")}
            error={total && cents === null ? t("finance.invalidAmount") : undefined}
          >
            <Input
              id="c-total"
              inputMode="decimal"
              required
              placeholder="0,00"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
            />
          </Field>
          <Field
            id="c-count"
            label={t(modality === "mensalidade" ? "finance.months" : "finance.installmentsCount")}
          >
            <Input
              id="c-count"
              type="number"
              min={1}
              max={120}
              required
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </Field>
          <Field id="c-first" label={t("finance.firstDueDate")} className="sm:col-span-2">
            <Input
              id="c-first"
              type="date"
              required
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
          </Field>
          <Field id="c-notes" label={t("finance.notes")} className="sm:col-span-2">
            <textarea
              id="c-notes"
              className={textareaClass}
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          {preview && preview.count > 0 && (
            <p className="text-sm text-muted-foreground sm:col-span-2" aria-live="polite">
              {preview.first === preview.last
                ? t("finance.previewEqual", {
                    count: preview.count,
                    amount: brl(preview.first, i18n.language),
                  })
                : t("finance.previewUneven", {
                    count: preview.count,
                    first: brl(preview.first, i18n.language),
                    last: brl(preview.last, i18n.language),
                  })}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="contract-form" disabled={!cents || monthlyBlocked || save.isPending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
