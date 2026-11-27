/** Nova conversa (direta ou grupo) e configurações do grupo (nome, foto, participantes, sair). */
import {
  Avatar,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, UserMinus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { type Conversation, conversationsQuery } from "../../lib/comms";
import { errorMessage } from "../../lib/errors";
import { membersQuery, meQuery } from "../../lib/queries";
import { uploadFile } from "../../lib/work";
import { ConversationAvatar } from "./chat-panel";

function PeoplePicker({
  selected,
  onToggle,
  exclude,
  single,
}: {
  selected: string[];
  onToggle: (id: string) => void;
  exclude: string[];
  single?: boolean;
}) {
  const { t } = useTranslation();
  const members = useQuery(membersQuery("team"));
  const [q, setQ] = useState("");
  const people = (members.data?.data ?? []).filter(
    (m) =>
      m.active !== false &&
      !exclude.includes(m.userId) &&
      (!q || m.name.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div className="grid gap-2">
      <Input
        type="search"
        placeholder={t("chat.searchPeople")}
        aria-label={t("chat.searchPeople")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="max-h-64 overflow-y-auto rounded-md border" aria-label={t("chat.people")}>
        {people.map((m) => {
          const on = selected.includes(m.userId);
          return (
            <li key={m.userId}>
              <button
                type="button"
                aria-pressed={single ? undefined : on}
                onClick={() => onToggle(m.userId)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
                  on && "bg-primary/10",
                )}
              >
                <Avatar name={m.name} src={m.image} className="size-7" />
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate">{m.name}</span>
                  {m.jobTitle && <span className="truncate text-xs text-muted-foreground">{m.jobTitle}</span>}
                </span>
                {on && <Check className="size-4 text-primary" />}
              </button>
            </li>
          );
        })}
        {!people.length && (
          <li className="p-4 text-center text-sm text-muted-foreground">{t("chat.noPeople")}</li>
        )}
      </ul>
    </div>
  );
}

export function NewConversationDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useQuery(meQuery).data;
  const [mode, setMode] = useState<"dm" | "grupo">("dm");
  const [name, setName] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: (userIds: string[]) =>
      unwrap(
        api.chat.conversations.$post({
          json: mode === "dm" ? { type: "dm", userId: userIds[0]! } : { type: "grupo", name, userIds },
        }),
      ),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: conversationsQuery.queryKey });
      onCreated(c.id);
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")}>
        <DialogHeader>
          <DialogTitle>{t("chat.new")}</DialogTitle>
          <DialogDescription>{t("chat.newHint")}</DialogDescription>
        </DialogHeader>
        {/* biome-ignore lint/a11y/useSemanticElements: grupo de botões de alternância */}
        <div className="flex gap-1 rounded-md border p-1" role="group" aria-label={t("chat.new")}>
          {(["dm", "grupo"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={mode === k}
              onClick={() => {
                setMode(k);
                setPeople([]);
              }}
              className={cn(
                "flex-1 rounded px-2 py-1.5 text-sm",
                mode === k ? "bg-accent font-medium" : "text-muted-foreground",
              )}
            >
              {t(`chat.kinds.${k}`)}
            </button>
          ))}
        </div>
        {mode === "grupo" && (
          <Field id="group-name" label={t("chat.groupName")}>
            <Input id="group-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <PeoplePicker
          single={mode === "dm"}
          selected={people}
          exclude={me ? [me.user.id] : []}
          onToggle={(id) =>
            mode === "dm"
              ? create.mutate([id])
              : setPeople((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
          }
        />
        {mode === "grupo" && (
          <DialogFooter>
            <Button
              disabled={!name.trim() || !people.length || create.isPending}
              onClick={() => create.mutate(people)}
            >
              {t("chat.createGroup", { count: people.length })}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function GroupDialog({
  conv,
  onClose,
  onLeft,
}: {
  conv: Conversation;
  onClose: () => void;
  onLeft: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useQuery(meQuery).data;
  const [name, setName] = useState(conv.name);
  const [adding, setAdding] = useState<string[]>([]);
  const refresh = () => qc.invalidateQueries({ queryKey: conversationsQuery.queryKey });
  const onErr = (e: unknown) => toast.error(errorMessage(t, e));
  const update = useMutation({
    mutationFn: (json: { name?: string; photoFileId?: string | null }) =>
      unwrap(api.chat.conversations[":id"].$patch({ param: { id: conv.id }, json })),
    onSuccess: () => {
      toast.success(t("chat.groupSaved"));
      void refresh();
    },
    onError: onErr,
  });
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.chat.conversations[":id"].participants.$post({
          param: { id: conv.id },
          json: { userIds: adding },
        }),
      ),
    onSuccess: () => {
      setAdding([]);
      void refresh();
    },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      unwrapVoid(
        api.chat.conversations[":id"].participants[":userId"].$delete({ param: { id: conv.id, userId } }),
      ),
    onSuccess: (_, userId) => {
      void refresh();
      if (userId === me?.user.id) {
        onClose();
        onLeft();
      }
    },
    onError: onErr,
  });
  const photo = async (f: File | undefined) => {
    if (!f) return;
    try {
      update.mutate({ photoFileId: await uploadFile(f) });
    } catch (e) {
      onErr(e);
    }
  };
  const admin = conv.type === "grupo" && conv.isAdmin;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {conv.type === "projeto" ? t("chat.projectChat") : t("chat.groupSettings")}
          </DialogTitle>
          <DialogDescription>
            {admin ? t("chat.groupAdminHint") : t("chat.groupMemberHint")}
          </DialogDescription>
        </DialogHeader>
        {admin && (
          <div className="flex items-end gap-3">
            <label className="relative cursor-pointer" aria-label={t("chat.groupPhoto")}>
              <ConversationAvatar c={conv} className="size-14" />
              <span className="absolute -bottom-1 -right-1 grid size-6 place-items-center rounded-full border bg-background">
                <ImagePlus className="size-3.5" />
              </span>
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => photo(e.target.files?.[0])}
              />
            </label>
            <Field id="group-rename" label={t("chat.groupName")} className="flex-1">
              <Input
                id="group-rename"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Button
              variant="outline"
              disabled={!name.trim() || name === conv.name || update.isPending}
              onClick={() => update.mutate({ name })}
            >
              {t("common.save")}
            </Button>
          </div>
        )}
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">{t("chat.members", { count: conv.participants.length })}</h3>
          <ul className="grid gap-1">
            {conv.participants.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                <Avatar name={p.name} src={p.image} className="size-7" />
                <span className="min-w-0 flex-1 truncate">
                  {p.name}
                  {p.isAdmin && (
                    <span className="ml-1 text-xs text-muted-foreground">· {t("chat.admin")}</span>
                  )}
                </span>
                {admin && p.id !== me?.user.id && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("chat.removePerson", { name: p.name })}
                    onClick={() => remove.mutate(p.id)}
                  >
                    <UserMinus />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
        {admin && (
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">{t("chat.addPeople")}</h3>
            <PeoplePicker
              selected={adding}
              exclude={conv.participants.map((p) => p.id)}
              onToggle={(id) => setAdding((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
            />
            <Button
              className="justify-self-end"
              disabled={!adding.length || add.isPending}
              onClick={() => add.mutate()}
            >
              {t("chat.addCount", { count: adding.length })}
            </Button>
          </section>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => me && remove.mutate(me.user.id)}
          >
            {t("chat.leave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
