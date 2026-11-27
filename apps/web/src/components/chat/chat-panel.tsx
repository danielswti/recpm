/**
 * Chat (§6.9): lista de conversas + conversa aberta. Usado na página /chat e no widget flutuante.
 * Diretas, grupos, conversa do projeto e assistente de IA; não lidas, fixar, marcar como não lida,
 * "digitando…", anexos, foto e participantes do grupo.
 */
import {
  Avatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  FolderKanban,
  Loader2,
  MessageSquarePlus,
  MoreVertical,
  Paperclip,
  Pin,
  PinOff,
  Send,
  Settings2,
  Users,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import {
  badgeCount,
  type ChatMessage,
  type Conversation,
  conversationsQuery,
  messagesQuery,
  useTypingNames,
} from "../../lib/comms";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { downloadUrl, uploadFile } from "../../lib/work";
import { GroupDialog, NewConversationDialog } from "./chat-dialogs";

export function ConversationAvatar({ c, className }: { c: Conversation; className?: string }) {
  if (c.type === "ia")
    return (
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary",
          className,
        )}
      >
        <Bot className="size-4" />
      </span>
    );
  if (c.type === "projeto")
    return (
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
          className,
        )}
      >
        <FolderKanban className="size-4" />
      </span>
    );
  if (c.type === "grupo" && !c.photoFileId)
    return (
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-full bg-secondary", className)}>
        <Users className="size-4" />
      </span>
    );
  const other = c.type === "dm" ? c.participants.find((p) => p.name === c.name) : null;
  return (
    <Avatar
      name={c.name}
      src={c.photoFileId ? downloadUrl(c.photoFileId) : (other?.image ?? null)}
      className={cn("size-9", className)}
    />
  );
}

export function ChatPanel({
  activeId,
  onSelect,
  compact,
}: {
  activeId: string | null;
  onSelect: (id: string | null) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const list = useQuery(conversationsQuery);
  const active = list.data?.data.find((c) => c.id === activeId) ?? null;
  // compacto (widget e celular): uma coluna por vez
  return (
    <div className={cn("flex h-full min-h-0 overflow-hidden", !compact && "rounded-lg border")}>
      <div
        className={cn(
          "flex min-h-0 w-full flex-col",
          compact
            ? activeId
              ? "hidden"
              : "flex"
            : activeId
              ? "hidden md:flex md:w-80 md:shrink-0 md:border-r"
              : "md:w-80 md:shrink-0 md:border-r",
        )}
      >
        <ConversationList activeId={activeId} onSelect={onSelect} />
      </div>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          activeId ? "flex" : compact ? "hidden" : "hidden md:flex",
        )}
      >
        {active ? (
          <Thread key={active.id} conv={active} compact={compact} onBack={() => onSelect(null)} />
        ) : activeId && list.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : (
          <div className="grid flex-1 place-items-center p-6">
            <EmptyState title={t("chat.pickTitle")} description={t("chat.pickHint")} />
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationList({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery(conversationsQuery);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const openAi = useMutation({
    mutationFn: () => unwrap(api.chat.ai.$post()),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: conversationsQuery.queryKey });
      onSelect(c.id);
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const state = useMutation({
    mutationFn: ({ id, ...json }: { id: string; read?: boolean; pinned?: boolean }) =>
      unwrapVoid(api.chat.conversations[":id"].state.$post({ param: { id }, json })),
    onSettled: () => qc.invalidateQueries({ queryKey: conversationsQuery.queryKey }),
  });
  const items = (list.data?.data ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  const time = (iso: string) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return new Intl.DateTimeFormat(
      i18n.language,
      today ? { timeStyle: "short" } : { day: "2-digit", month: "2-digit" },
    ).format(d);
  };
  return (
    <>
      <div className="flex items-center gap-1.5 border-b p-2">
        <Input
          type="search"
          placeholder={t("chat.search")}
          aria-label={t("chat.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-9"
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("chat.assistant")}
          title={t("chat.assistant")}
          disabled={openAi.isPending}
          onClick={() => openAi.mutate()}
        >
          <Bot />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("chat.new")}
          title={t("chat.new")}
          onClick={() => setCreating(true)}
        >
          <MessageSquarePlus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="grid gap-2 p-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : !items.length ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {q ? t("chat.noMatch") : t("chat.empty")}
          </p>
        ) : (
          <ul aria-label={t("chat.conversations")}>
            {items.map((c) => {
              const unread = c.unread > 0 || c.markedUnread;
              return (
                <li key={c.id} className={cn("group relative", c.id === activeId && "bg-accent")}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 pr-9 text-left hover:bg-accent/60"
                  >
                    <ConversationAvatar c={c} />
                    <span className="grid min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className={cn("min-w-0 truncate text-sm", unread && "font-semibold")}>
                          {c.name}
                        </span>
                        {c.pinned && (
                          <Pin
                            className="size-3 shrink-0 text-muted-foreground"
                            aria-label={t("chat.pinned")}
                          />
                        )}
                        {c.lastMessage && (
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                            {time(c.lastMessage.at)}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-1">
                        <span
                          className={cn(
                            "truncate text-xs",
                            unread ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {c.lastMessage
                            ? `${c.type !== "dm" && c.lastMessage.authorName ? `${c.lastMessage.authorName.split(" ")[0]}: ` : ""}${c.lastMessage.body || t("chat.attachmentOrDeleted")}`
                            : t(`chat.kinds.${c.type}`)}
                        </span>
                        {unread && (
                          <span className="ml-auto grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                            {c.unread ? badgeCount(c.unread) : ""}
                            <span className="sr-only">{t("chat.unread")}</span>
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={t("chat.options", { name: c.name })}
                      className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100 data-[state=open]:opacity-100"
                    >
                      <MoreVertical className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => state.mutate({ id: c.id, pinned: !c.pinned })}>
                        {c.pinned ? <PinOff /> : <Pin />} {t(c.pinned ? "chat.unpin" : "chat.pin")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          if (unread) state.mutate({ id: c.id, read: true });
                          else {
                            if (c.id === activeId) onSelect(null);
                            state.mutate({ id: c.id, read: false });
                          }
                        }}
                      >
                        {t(unread ? "chat.markRead" : "chat.markUnread")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {creating && (
        <NewConversationDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onSelect(id);
          }}
        />
      )}
    </>
  );
}

function Thread({ conv, compact, onBack }: { conv: Conversation; compact?: boolean; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useQuery(meQuery).data;
  const msgs = useQuery(messagesQuery(conv.id));
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [settings, setSettings] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const typing = useTypingNames(conv.id);
  const all = useMemo(() => {
    const seen = new Set<string>();
    return [...older, ...(msgs.data?.data ?? [])].filter((m) => !seen.has(m.id) && seen.add(m.id));
  }, [older, msgs.data]);

  // lê ao abrir e quando chegam mensagens novas
  const unread = conv.unread > 0 || conv.markedUnread;
  useEffect(() => {
    if (!unread || !msgs.data) return;
    void unwrapVoid(
      api.chat.conversations[":id"].state.$post({ param: { id: conv.id }, json: { read: true } }),
    ).then(() => qc.invalidateQueries({ queryKey: conversationsQuery.queryKey }));
  }, [unread, msgs.data, conv.id, qc]);

  // rola para o fim quando chega mensagem nova
  const lastId = msgs.data?.data.at(-1)?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && lastId) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  const loadOlder = async () => {
    const first = all[0];
    if (!first) return;
    const el = scroller.current;
    const prevH = el?.scrollHeight ?? 0;
    const r = await unwrap(
      api.chat.conversations[":id"].messages.$get({
        param: { id: conv.id },
        query: { before: first.createdAt, limit: "50" } as never,
      }),
    );
    setOlder((o) => [...r.data, ...o]);
    setHasOlder(r.hasMore);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - prevH;
    });
  };

  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.chat.conversations[":id"].messages.$post({
          param: { id: conv.id },
          json: { body: text.trim(), fileIds: files.map((f) => f.id) },
        }),
      ),
    onSuccess: (r) => {
      setText("");
      setFiles([]);
      qc.setQueryData(messagesQuery(conv.id).queryKey, (old) =>
        old
          ? { ...old, data: [...old.data, ...r.data.filter((m) => !old.data.some((o) => o.id === m.id))] }
          : old,
      );
      void qc.invalidateQueries({ queryKey: conversationsQuery.queryKey });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const submit = () => {
    if ((!text.trim() && !files.length) || send.isPending || uploading) return;
    send.mutate();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    if (conv.type !== "ia" && Date.now() - lastTyping.current > 2500) {
      lastTyping.current = Date.now();
      void api.chat.conversations[":id"].typing.$post({ param: { id: conv.id } }).catch(() => {});
    }
  };
  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list).slice(0, 10 - files.length)) {
        const id = await uploadFile(f);
        setFiles((s) => [...s, { id, name: f.name }]);
      }
    } catch (e) {
      toast.error(errorMessage(t, e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const dayFmt = new Intl.DateTimeFormat(i18n.language, { weekday: "short", day: "numeric", month: "short" });
  const timeFmt = new Intl.DateTimeFormat(i18n.language, { timeStyle: "short" });
  const subtitle =
    conv.type === "ia"
      ? t("chat.aiHint")
      : conv.type === "dm"
        ? t("chat.kinds.dm")
        : t("chat.members", { count: conv.participants.length });
  const thinking = send.isPending && conv.type === "ia";

  return (
    <>
      <header className="flex items-center gap-2 border-b px-2 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("chat.back")}
          onClick={onBack}
          className={compact ? undefined : "md:hidden"}
        >
          <ArrowLeft />
        </Button>
        <ConversationAvatar c={conv} className="size-8" />
        <div className="grid min-w-0 flex-1 leading-tight">
          <h2 className="truncate text-sm font-semibold">{conv.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {typing.length ? t("chat.typing", { names: typing.join(", ") }) : subtitle}
          </p>
        </div>
        {conv.project && (
          <Button variant="ghost" size="icon" asChild>
            <Link to="/projetos/$id" params={{ id: conv.project.id }} aria-label={t("chat.openProject")}>
              <FolderKanban />
            </Link>
          </Button>
        )}
        {(conv.type === "grupo" || conv.type === "projeto") && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("chat.groupSettings")}
            onClick={() => setSettings(true)}
          >
            <Settings2 />
          </Button>
        )}
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
        {msgs.isPending ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            {(hasOlder ?? msgs.data?.hasMore) && (
              <div className="mb-3 text-center">
                <Button variant="ghost" size="sm" onClick={loadOlder}>
                  {t("chat.loadOlder")}
                </Button>
              </div>
            )}
            {!all.length && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {conv.type === "ia" ? t("chat.aiEmpty") : t("chat.noMessages")}
              </p>
            )}
            <ol className="grid gap-1.5">
              {all.map((m, i) => {
                const prev = all[i - 1];
                const newDay =
                  !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
                const mine = m.author?.id === me?.user.id;
                const grouped =
                  !newDay && prev?.author?.id === m.author?.id && prev?.authorType === m.authorType;
                return (
                  <li key={m.id} className="grid">
                    {newDay && (
                      <p className="my-2 text-center text-[11px] uppercase tracking-wide text-muted-foreground">
                        {dayFmt.format(new Date(m.createdAt))}
                      </p>
                    )}
                    <Bubble
                      m={m}
                      mine={mine}
                      showAuthor={!grouped && !mine && conv.type !== "dm"}
                      time={timeFmt.format(new Date(m.createdAt))}
                      aiName={conv.type === "ia" ? conv.name : t("chat.assistant")}
                    />
                  </li>
                );
              })}
              {thinking && (
                <li className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> {t("chat.aiThinking", { name: conv.name })}
                </li>
              )}
            </ol>
          </>
        )}
      </div>
      <form
        className="border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {files.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
              >
                <Paperclip className="size-3" />
                <span className="max-w-40 truncate">{f.name}</span>
                <button
                  type="button"
                  aria-label={t("chat.removeFile", { name: f.name })}
                  onClick={() => setFiles((s) => s.filter((x) => x.id !== f.id))}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1.5">
          {conv.type !== "ia" && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => attach(e.target.files)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("chat.attach")}
                disabled={uploading || files.length >= 10}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
              </Button>
            </>
          )}
          <textarea
            aria-label={t("chat.message")}
            placeholder={conv.type === "ia" ? t("chat.askAi") : t("chat.write")}
            rows={1}
            maxLength={10_000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            className="max-h-32 min-h-9 flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-sm field-sizing-content"
          />
          <Button
            type="submit"
            size="icon"
            aria-label={t("chat.send")}
            disabled={send.isPending || uploading || (!text.trim() && !files.length)}
          >
            <Send />
          </Button>
        </div>
      </form>
      {settings && <GroupDialog conv={conv} onClose={() => setSettings(false)} onLeft={onBack} />}
    </>
  );
}

function Bubble({
  m,
  mine,
  showAuthor,
  time,
  aiName,
}: {
  m: ChatMessage;
  aiName: string;
  mine: boolean;
  showAuthor: boolean;
  time: string;
}) {
  const { t } = useTranslation();
  if (m.authorType === "system")
    return (
      <p className="mx-auto max-w-[90%] rounded-md bg-amber-500/10 px-3 py-1.5 text-center text-xs text-amber-800 dark:text-amber-300">
        {m.body}
      </p>
    );
  const ai = m.authorType === "assistant";
  return (
    <div
      className={cn("flex max-w-[85%] flex-col gap-0.5", mine ? "items-end justify-self-end" : "items-start")}
    >
      {showAuthor && (
        <span className="px-1 text-[11px] text-muted-foreground">{ai ? aiName : m.author?.name}</span>
      )}
      <div
        className={cn(
          "min-w-0 max-w-full rounded-2xl px-3 py-1.5 text-sm",
          mine
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : ai
              ? "rounded-bl-sm bg-primary/10"
              : "rounded-bl-sm bg-muted",
          m.deleted && "italic opacity-70",
        )}
      >
        {m.deleted ? (
          t("chat.deleted")
        ) : (
          <>
            {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
            {m.attachments.length > 0 && (
              <ul className="mt-1 grid gap-1">
                {m.attachments.map((a) => (
                  <li key={a.id}>
                    {a.mimeType.startsWith("image/") ? (
                      <a href={downloadUrl(a.id)} target="_blank" rel="noreferrer">
                        <img
                          src={downloadUrl(a.id)}
                          alt={a.name}
                          className="max-h-48 rounded-md"
                          loading="lazy"
                        />
                      </a>
                    ) : (
                      <a
                        href={downloadUrl(a.id)}
                        className="flex items-center gap-1 underline underline-offset-2"
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Paperclip className="size-3 shrink-0" /> <span className="truncate">{a.name}</span>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <span className="px-1 text-[10px] text-muted-foreground">
        {time}
        {m.editedAt && !m.deleted ? ` · ${t("chat.edited")}` : ""}
        {m.toolCalls?.length ? ` · ${t("chat.usedTools", { count: m.toolCalls.length })}` : ""}
      </span>
    </div>
  );
}
