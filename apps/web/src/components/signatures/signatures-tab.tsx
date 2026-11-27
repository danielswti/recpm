/**
 * Aba "Assinaturas" do projeto: pedidos de assinatura eletrônica com PDF, signatários,
 * envio dos links pessoais, reenvio, cancelamento e download do original ou do assinado.
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Copy,
  Download,
  FileSignature,
  FileUp,
  MailPlus,
  MoreHorizontal,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import {
  projectSignaturesQuery,
  SIGNATURE_TONE,
  SIGNER_TONE,
  type SignatureRequest,
} from "../../lib/finance";
import { meQuery } from "../../lib/queries";
import { uploadFile } from "../../lib/work";
import { ConfirmDialog, textareaClass } from "../confirm-dialog";

const when = (iso: string | null, locale: string) =>
  iso
    ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso))
    : "";

export function SignaturesTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const q = useQuery(projectSignaturesQuery(projectId));
  const { data: me } = useQuery(meQuery);
  const canManage = !!me?.tenant?.permissions.includes("projects.manage");
  const [creating, setCreating] = useState(false);

  if (q.isPending) return <Skeleton className="h-40 max-w-4xl" />;
  if (q.isError) return <p className="text-destructive">{errorMessage(t, q.error)}</p>;
  const newButton = canManage ? (
    <Button onClick={() => setCreating(true)}>
      <Plus /> {t("signatures.new")}
    </Button>
  ) : null;
  return (
    <div className="grid max-w-4xl grid-cols-[minmax(0,1fr)] gap-4">
      {q.data.data.length ? (
        <>
          <div className="flex justify-end">{newButton}</div>
          {q.data.data.map((r) => (
            <RequestCard key={r.id} req={r} canManage={canManage} projectId={projectId} />
          ))}
        </>
      ) : (
        <EmptyState
          icon={<FileSignature className="size-6" />}
          title={t("signatures.empty")}
          description={t("signatures.emptyText")}
          action={newButton}
        />
      )}
      {creating && <NewRequestDialog projectId={projectId} onClose={() => setCreating(false)} />}
    </div>
  );
}

function RequestCard({
  req: r,
  canManage,
  projectId,
}: {
  req: SignatureRequest;
  canManage: boolean;
  projectId: string;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"cancel" | "delete" | "send" | null>(null);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: projectSignaturesQuery(projectId).queryKey });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const verifyUrl = `${window.location.origin}/verificar/${r.verificationCode}`;
  const signedCount = r.signers.filter((s) => s.status === "assinou").length;
  const open = r.status === "enviado";
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3 border-b p-4">
        <div className="grid min-w-48 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{r.title}</h3>
            <Badge variant={SIGNATURE_TONE[r.status]}>{t(`signatures.status.${r.status}`)}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {r.documentName} ·{" "}
            {r.status === "rascunho"
              ? t("signatures.createdAt", { date: when(r.createdAt, i18n.language) })
              : r.completedAt
                ? t("signatures.completedAt", { date: when(r.completedAt, i18n.language) })
                : t("signatures.sentAt", { date: when(r.sentAt, i18n.language) })}
            {r.status !== "rascunho" &&
              ` · ${t("signatures.progress", { done: signedCount, total: r.signers.length })}`}
          </p>
          {r.status !== "rascunho" && (
            <p className="text-xs text-muted-foreground">
              {t("signatures.code")}: <span className="font-mono">{r.verificationCode}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {r.status === "rascunho" && canManage && (
            <Button size="sm" onClick={() => setConfirm("send")}>
              <Send /> {t("signatures.send")}
            </Button>
          )}
          {r.signedFileId && (
            <Button size="sm" variant="outline" asChild>
              <a href={`/api/v1/signatures/${r.id}/download`} target="_blank" rel="noreferrer">
                <Download /> {t("signatures.downloadSigned")}
              </a>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={t("signatures.actions")}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a href={`/api/v1/signatures/${r.id}/download?original=1`} target="_blank" rel="noreferrer">
                  <Download /> {t("signatures.downloadOriginal")}
                </a>
              </DropdownMenuItem>
              {r.status !== "rascunho" && (
                <>
                  <DropdownMenuItem
                    onSelect={() => {
                      void navigator.clipboard.writeText(verifyUrl);
                      toast.success(t("signatures.linkCopied"));
                    }}
                  >
                    <Copy /> {t("signatures.copyVerify")}
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={verifyUrl} target="_blank" rel="noreferrer">
                      <ShieldCheck /> {t("signatures.openVerify")}
                    </a>
                  </DropdownMenuItem>
                </>
              )}
              {canManage && open && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setConfirm("cancel")}>
                    <Ban /> {t("signatures.cancel")}
                  </DropdownMenuItem>
                </>
              )}
              {canManage && r.status === "rascunho" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={() => setConfirm("delete")}>
                    <Trash2 /> {t("common.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ul className="divide-y">
        {r.signers.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{s.name}</p>
              <p className="truncate text-xs text-muted-foreground">{s.email}</p>
            </div>
            <div className="grid justify-items-end gap-0.5 text-right">
              <Badge variant={SIGNER_TONE[s.status]}>{t(`signatures.signerStatus.${s.status}`)}</Badge>
              <span className="text-xs text-muted-foreground">
                {when(s.signedAt ?? s.refusedAt ?? s.viewedAt, i18n.language)}
              </span>
            </div>
            {canManage && open && (s.status === "pendente" || s.status === "visualizou") && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("signatures.resendTo", { name: s.name })}
                title={t("signatures.resend")}
                disabled={run.isPending}
                onClick={() =>
                  run.mutate(
                    () =>
                      unwrapVoid(
                        api.signatures[":id"].signers[":signerId"].resend.$post({
                          param: { id: r.id, signerId: s.id },
                        }),
                      ),
                    { onSuccess: () => toast.success(t("signatures.resent", { email: s.email })) },
                  )
                }
              >
                <MailPlus />
              </Button>
            )}
            {s.refuseReason && (
              <p className="basis-full text-xs text-destructive">
                {t("signatures.refuseReason")}: {s.refuseReason}
              </p>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirm === "send"}
        destructive={false}
        title={t("signatures.sendTitle")}
        description={t("signatures.sendText", { count: r.signers.length })}
        confirmLabel={t("signatures.send")}
        pending={run.isPending}
        onConfirm={() =>
          run.mutate(() => unwrap(api.signatures[":id"].send.$post({ param: { id: r.id } })), {
            onSuccess: () => toast.success(t("signatures.sent")),
          })
        }
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "cancel"}
        title={t("signatures.cancelTitle")}
        description={t("signatures.cancelText")}
        confirmLabel={t("signatures.cancel")}
        pending={run.isPending}
        onConfirm={() =>
          run.mutate(() => unwrap(api.signatures[":id"].cancel.$post({ param: { id: r.id } })))
        }
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={t("signatures.deleteTitle")}
        confirmLabel={t("common.delete")}
        pending={run.isPending}
        onConfirm={() => run.mutate(() => unwrapVoid(api.signatures[":id"].$delete({ param: { id: r.id } })))}
        onClose={() => setConfirm(null)}
      />
    </Card>
  );
}

function NewRequestDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [signers, setSigners] = useState([{ name: "", email: "" }]);
  const setSigner = (i: number, patch: Partial<{ name: string; email: string }>) =>
    setSigners((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("file");
      const documentFileId = await uploadFile(file);
      return unwrap(
        api.signatures.$post({
          json: {
            projectId,
            title: title.trim(),
            documentFileId,
            message: message.trim() || null,
            signers: signers.map((s) => ({ name: s.name.trim(), email: s.email.trim() })),
          },
        }),
      );
    },
    onSuccess: () => {
      toast.success(t("signatures.created"));
      void qc.invalidateQueries({ queryKey: projectSignaturesQuery(projectId).queryKey });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("signatures.new")}</DialogTitle>
          <DialogDescription>{t("signatures.newText")}</DialogDescription>
        </DialogHeader>
        <form
          id="sig-form"
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (file) create.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">{t("signatures.document")}</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
                <FileUp /> {file ? t("signatures.changePdf") : t("signatures.choosePdf")}
              </Button>
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                {file?.name ?? t("signatures.onlyPdf")}
              </span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              aria-label={t("signatures.choosePdf")}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                e.target.value = "";
                if (f && f.type !== "application/pdf") return void toast.error(t("errors.DOCUMENT_NOT_PDF"));
                setFile(f);
                if (f && !title) setTitle(f.name.replace(/\.pdf$/i, ""));
              }}
            />
          </div>
          <Field id="sig-title" label={t("signatures.title")}>
            <Input
              id="sig-title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field id="sig-message" label={t("signatures.message")} hint={t("signatures.messageHint")}>
            <textarea
              id="sig-message"
              className={textareaClass}
              rows={2}
              maxLength={2000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t("signatures.signers")}</legend>
            {signers.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: linhas editáveis sem id próprio
              <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Input
                  required
                  aria-label={t("signatures.signerName", { n: i + 1 })}
                  placeholder={t("signatures.name")}
                  value={s.name}
                  onChange={(e) => setSigner(i, { name: e.target.value })}
                />
                <Input
                  required
                  type="email"
                  className="col-start-1 sm:col-start-auto"
                  aria-label={t("signatures.signerEmail", { n: i + 1 })}
                  placeholder={t("signatures.email")}
                  value={s.email}
                  onChange={(e) => setSigner(i, { email: e.target.value })}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="col-start-2 row-span-2 row-start-1 self-center sm:col-start-3 sm:row-span-1"
                  disabled={signers.length === 1}
                  aria-label={t("signatures.removeSigner", { n: i + 1 })}
                  onClick={() => setSigners((xs) => xs.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              </div>
            ))}
            {signers.length < 20 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-self-start"
                onClick={() => setSigners((xs) => [...xs, { name: "", email: "" }])}
              >
                <Plus /> {t("signatures.addSigner")}
              </Button>
            )}
          </fieldset>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="sig-form" disabled={!file || create.isPending}>
            {t("signatures.saveDraft")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
