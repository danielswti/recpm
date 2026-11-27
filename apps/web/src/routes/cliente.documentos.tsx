/** Documentos para assinar pelo portal (o mesmo pedido que chega por e-mail, sem precisar do link). */
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
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, FileSignature, PenLine, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrapVoid } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { type PortalDocument as Doc, portalDocumentsQuery } from "../lib/portal";

export const Route = createFileRoute("/cliente/documentos")({ component: PortalDocuments });

function PortalDocuments() {
  const { t, i18n } = useTranslation();
  const q = useQuery(portalDocumentsQuery);
  const [signing, setSigning] = useState<Doc | null>(null);
  const [refusing, setRefusing] = useState<Doc | null>(null);
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("portal.documents.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("portal.documents.subtitle")}</p>
      </div>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : !q.data?.data.length ? (
        <EmptyState icon={<FileSignature className="size-6" />} title={t("portal.documents.empty")} />
      ) : (
        <div className="grid gap-3">
          {q.data.data.map((d) => {
            const open = d.status === "enviado" && (d.myStatus === "pendente" || d.myStatus === "visualizou");
            return (
              <Card key={d.id} className="grid gap-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 font-medium">{d.title}</span>
                  <Badge variant={open ? "default" : d.myStatus === "recusou" ? "destructive" : "secondary"}>
                    {open ? t("portal.documents.toSign") : t(`signatures.signerStatus.${d.myStatus}`)}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {[d.project, d.documentName, d.sentAt && df.format(new Date(d.sentAt))]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {d.message && <p className="whitespace-pre-wrap text-sm">{d.message}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <a href={`/api/v1/portal/documents/${d.id}/download`} target="_blank" rel="noreferrer">
                      <Download />{" "}
                      {d.hasSignedCopy
                        ? t("portal.documents.downloadSigned")
                        : t("portal.documents.download")}
                    </a>
                  </Button>
                  {open && (
                    <>
                      <Button size="sm" onClick={() => setSigning(d)}>
                        <PenLine /> {t("portal.documents.sign")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRefusing(d)}>
                        <X /> {t("portal.documents.refuse")}
                      </Button>
                    </>
                  )}
                </div>
                {d.status === "assinado" && (
                  <p className="text-xs text-muted-foreground">
                    {t("portal.documents.code", { code: d.verificationCode })}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <SignDialog doc={signing} onClose={() => setSigning(null)} />
      <RefuseDialog doc={refusing} onClose={() => setRefusing(null)} />
    </div>
  );
}

function SignDialog({ doc, onClose }: { doc: Doc | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const sign = useMutation({
    mutationFn: () =>
      unwrapVoid(
        api.portal.documents[":id"].sign.$post({
          param: { id: doc!.id },
          json: { typedName: name, agree: true },
        }),
      ),
    onSuccess: () => {
      toast.success(t("portal.documents.signed"));
      void qc.invalidateQueries({ queryKey: ["portal"] });
      setName("");
      setAgree(false);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            sign.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("portal.documents.signTitle", { title: doc?.title ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("portal.documents.signHelp", { name: doc?.signerName ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <Field id="sg-name" label={t("portal.documents.typedName")}>
            <Input
              id="sg-name"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            {t("portal.documents.agree")}
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!agree || name.trim().length < 2 || sign.isPending}>
              {t("portal.documents.sign")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RefuseDialog({ doc, onClose }: { doc: Doc | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const refuse = useMutation({
    mutationFn: () =>
      unwrapVoid(
        api.portal.documents[":id"].refuse.$post({ param: { id: doc!.id }, json: { reason: reason.trim() } }),
      ),
    onSuccess: () => {
      toast.success(t("portal.documents.refused"));
      void qc.invalidateQueries({ queryKey: ["portal"] });
      setReason("");
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            refuse.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("portal.documents.refuseTitle")}</DialogTitle>
            <DialogDescription>{t("portal.documents.refuseHelp")}</DialogDescription>
          </DialogHeader>
          <Field id="rf-reason" label={t("portal.documents.reason")}>
            <textarea
              id="rf-reason"
              required
              minLength={3}
              maxLength={1000}
              className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={reason.trim().length < 3 || refuse.isPending}
            >
              {t("portal.documents.refuse")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
