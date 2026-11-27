import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@recpm/ui";
import { useTranslation } from "react-i18next";

/** Confirmação para ações destrutivas. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = true,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Seletor de cor com amostra e campo hex. Vazio = sem cor. */
export function ColorInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="color"
        aria-label={t("catalogs.color")}
        value={value ?? "#64748b"}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-12 cursor-pointer rounded-md border border-input bg-transparent p-1"
      />
      <span className="font-mono text-xs text-muted-foreground">{value ?? t("catalogs.noColor")}</span>
      {value ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          {t("catalogs.clearColor")}
        </Button>
      ) : null}
    </div>
  );
}

export const textareaClass =
  "flex min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground disabled:opacity-50";
