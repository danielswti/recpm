/** Tabela de parcelas (contrato ou mensalidade) com registrar pagamento e estornar. */
import { PAYMENT_METHODS } from "@recpm/shared";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Input,
  Select,
} from "@recpm/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, MoreHorizontal, Undo2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import {
  brl,
  centsToInput,
  INSTALLMENT_TONE,
  type Installment,
  parseMoney,
  todayYmd,
} from "../../lib/finance";
import { calendarDate } from "../../lib/work";
import { ConfirmDialog, textareaClass } from "../confirm-dialog";

export function InstallmentsTable({ items, canManage }: { items: Installment[]; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [paying, setPaying] = useState<Installment | null>(null);
  const [reversing, setReversing] = useState<Installment | null>(null);
  const reverse = useMutation({
    mutationFn: (id: string) => unwrap(api.installments[":id"].reverse.$post({ param: { id } })),
    onSuccess: () => {
      toast.success(t("finance.reversed"));
      setReversing(null);
      void qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  if (!items.length)
    return <p className="px-4 py-3 text-sm text-muted-foreground">{t("finance.noInstallments")}</p>;
  return (
    <>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">{t("finance.cols.due")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("finance.cols.amount")}</th>
              <th className="px-4 py-2 font-medium">{t("finance.cols.status")}</th>
              <th className="px-4 py-2 font-medium">{t("finance.cols.payment")}</th>
              {canManage && (
                <th className="w-10 px-2 py-2">
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((i) => (
              <tr key={i.id} className={i.status === "estornado" ? "text-muted-foreground" : undefined}>
                <td className="px-4 py-2 tabular-nums">{i.number >= 10_000 ? "↺" : i.number}</td>
                <td className="px-4 py-2 tabular-nums">{calendarDate(i.dueDate, i18n.language)}</td>
                <td
                  className={`px-4 py-2 text-right tabular-nums ${i.status === "estornado" ? "line-through" : ""}`}
                >
                  {brl(i.amountCents, i18n.language)}
                </td>
                <td className="px-4 py-2">
                  <Badge variant={INSTALLMENT_TONE[i.status]}>
                    {t(`finance.installmentStatus.${i.status}`)}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {i.paidAt ? (
                    <>
                      {calendarDate(i.paidAt, i18n.language)} ·{" "}
                      {brl(i.paidAmountCents ?? i.amountCents, i18n.language)}
                      {i.method ? ` · ${t(`finance.methods.${i.method}`)}` : ""}
                      {i.note ? <span className="block truncate">{i.note}</span> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                {canManage && (
                  <td className="px-2 py-1 text-right">
                    {i.status === "pendente" || i.status === "atrasado" ? (
                      <Button size="sm" variant="outline" onClick={() => setPaying(i)}>
                        <BadgeCheck /> <span className="hidden sm:inline">{t("finance.pay")}</span>
                      </Button>
                    ) : i.status === "pago" ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" aria-label={t("common.actions")}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setReversing(i)}>
                            <Undo2 /> {t("finance.reverse")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {paying && <PayDialog installment={paying} onClose={() => setPaying(null)} />}
      <ConfirmDialog
        open={!!reversing}
        title={t("finance.reverseTitle")}
        description={t("finance.reverseText")}
        confirmLabel={t("finance.reverse")}
        pending={reverse.isPending}
        onConfirm={() => reversing && reverse.mutate(reversing.id)}
        onClose={() => setReversing(null)}
      />
    </>
  );
}

function PayDialog({ installment, onClose }: { installment: Installment; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [paidAt, setPaidAt] = useState(todayYmd());
  const [amount, setAmount] = useState(centsToInput(installment.amountCents, i18n.language));
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>("pix");
  const [note, setNote] = useState("");
  const cents = parseMoney(amount);
  const pay = useMutation({
    mutationFn: () =>
      unwrap(
        api.installments[":id"].pay.$post({
          param: { id: installment.id },
          json: { paidAt, paidAmountCents: cents ?? 0, method, note: note.trim() || null },
        }),
      ),
    onSuccess: () => {
      toast.success(t("finance.paid"));
      void qc.invalidateQueries({ queryKey: ["finance"] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t("finance.payTitle")}</DialogTitle>
          <DialogDescription>
            {t("finance.payText", {
              n: installment.number,
              amount: brl(installment.amountCents, i18n.language),
              date: calendarDate(installment.dueDate, i18n.language),
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          id="pay-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (cents) pay.mutate();
          }}
        >
          <Field id="pay-date" label={t("finance.paidAt")}>
            <Input
              id="pay-date"
              type="date"
              required
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
            />
          </Field>
          <Field
            id="pay-amount"
            label={t("finance.amountPaid")}
            error={cents === null ? t("finance.invalidAmount") : undefined}
          >
            <Input
              id="pay-amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field id="pay-method" label={t("finance.method")} className="sm:col-span-2">
            <Select
              id="pay-method"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`finance.methods.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="pay-note" label={t("finance.note")} className="sm:col-span-2">
            <textarea
              id="pay-note"
              className={textareaClass}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="pay-form" disabled={!cents || pay.isPending}>
            {t("finance.confirmPayment")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
