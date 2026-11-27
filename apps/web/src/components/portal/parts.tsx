/** Peças do portal do cliente: linha de tarefa, barra de progresso e conversa. */
import { Avatar, Badge, Button, cn } from "@recpm/ui";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PortalTaskItem } from "../../lib/portal";

export function PortalTaskRow({ task }: { task: PortalTaskItem }) {
  const { t, i18n } = useTranslation();
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeZone: "UTC" });
  return (
    <Link
      to="/cliente/tarefas/$id"
      params={{ id: task.id }}
      className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/50"
    >
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate font-medium">{task.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {[
            task.taskType,
            task.clientDeliveryDate &&
              t("portal.task.delivery", { date: df.format(new Date(task.clientDeliveryDate)) }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <Badge
        variant={task.awaitingClient ? "default" : task.isDone ? "secondary" : "outline"}
        className="shrink-0"
      >
        {task.awaitingClient ? t("portal.task.awaitingYou") : task.statusLabel}
      </Badge>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation();
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="grid gap-1">
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t("portal.progress")}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{t("portal.progressText", { done, total, pct })}</span>
    </div>
  );
}

type Comment = {
  id: string;
  author: string | null;
  mine: boolean;
  fromClient: boolean;
  body: string;
  createdAt: string;
};

/** Conversa com a equipe (só o que a equipe marcou como visível, mais o que eu escrevi). */
export function Conversation({
  comments,
  onSend,
  pending,
}: {
  comments: Comment[];
  onSend: (body: string) => Promise<unknown>;
  pending: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [body, setBody] = useState("");
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="grid gap-3">
      {comments.length ? (
        <ul className="grid gap-3">
          {comments.map((c) => (
            <li key={c.id} className={cn("flex gap-2", c.mine && "flex-row-reverse")}>
              <Avatar name={c.author ?? "?"} className="size-7 shrink-0" />
              <div
                className={cn(
                  "grid max-w-[85%] gap-1 rounded-lg border px-3 py-2 text-sm",
                  c.mine ? "border-primary/30 bg-primary/10" : "bg-card",
                )}
              >
                <span className="text-xs text-muted-foreground">
                  {c.author ?? "—"} · {df.format(new Date(c.createdAt))}
                </span>
                <p className="whitespace-pre-wrap break-words">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("portal.conversation.empty")}</p>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!body.trim()) return;
          await onSend(body.trim());
          setBody("");
        }}
      >
        <textarea
          className="min-h-10 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm"
          rows={2}
          maxLength={5000}
          placeholder={t("portal.conversation.placeholder")}
          aria-label={t("portal.conversation.placeholder")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button
          type="submit"
          size="icon"
          disabled={pending || !body.trim()}
          aria-label={t("portal.conversation.send")}
        >
          <Send />
        </Button>
      </form>
    </div>
  );
}
