import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@recpm/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useUpgradeModal } from "../lib/upgrade-modal";

/** Abre sozinho quando a API responde com um limite do plano (402). */
export function UpgradeDialog({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { code, close } = useUpgradeModal();
  return (
    <Dialog open={!!code} onOpenChange={(o) => !o && close()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t("billing.upgrade.title")}</DialogTitle>
          <DialogDescription>{code ? t(`billing.upgrade.${code}`) : null}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {canManage ? t("billing.upgrade.admin") : t("billing.upgrade.member")}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {t("common.back")}
          </Button>
          {canManage && (
            <Button
              onClick={() => {
                close();
                void navigate({ to: "/assinatura" });
              }}
            >
              {t("billing.upgrade.cta")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
