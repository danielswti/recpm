import type { AdjustmentInput } from "@recpm/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Select,
} from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { catalogQuery } from "../../lib/catalogs";
import { textareaClass } from "../confirm-dialog";

/** Motivo obrigatório ao mandar para Ajustes (ou ao reprovar). */
export function AdjustmentDialog({
  open,
  title,
  forceClient,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  /** Vindo de "aguardando cliente": o ajuste é do cliente. */
  forceClient?: boolean;
  pending?: boolean;
  onConfirm: (a: AdjustmentInput) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const reasons = useQuery({ ...catalogQuery("adjustment-reasons"), enabled: open });
  const active = reasons.data?.data.filter((r) => r.active) ?? [];
  const [reasonId, setReasonId] = useState("");
  const [kind, setKind] = useState<"internal" | "client">("internal");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (open) {
      setReasonId("");
      setDescription("");
      setKind(forceClient ? "client" : "internal");
    }
  }, [open, forceClient]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reasonId) onConfirm({ reasonId, kind, description: description.trim() || null });
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t("tasks.adjustment.help")}</DialogDescription>
          </DialogHeader>
          <Field id="adj-reason" label={t("tasks.adjustment.reason")}>
            <Select id="adj-reason" required value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
              <option value="">{t("common.choose")}</option>
              {active.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t("tasks.adjustment.kind")}</legend>
            <div className="flex gap-4 text-sm">
              {(["internal", "client"] as const).map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="adj-kind"
                    value={k}
                    checked={kind === k}
                    disabled={forceClient}
                    onChange={() => setKind(k)}
                  />
                  {t(`tasks.adjustment.kinds.${k}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <Field id="adj-desc" label={t("tasks.adjustment.description")}>
            <textarea
              id="adj-desc"
              className={textareaClass}
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!reasonId || pending}>
              {t("tasks.adjustment.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
