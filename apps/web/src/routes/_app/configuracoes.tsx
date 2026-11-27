/**
 * Configurações do workspace (§6.12, parte que não é catálogo): operação (fuso, horário padrão,
 * SLA de cobrança), pesos de produtividade, marca, assistente de IA e chaves de API.
 */
import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Copy, KeyRound, Plus, Trash2, Upload } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { ColorInput, ConfirmDialog } from "../../components/confirm-dialog";
import { PageHeader } from "../../components/page-header";
import { DAYS, type Week, WeekHoursEditor } from "../../components/week-hours";
import { api, unwrap, unwrapVoid } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { apiKeysQuery, settingsQuery, type WorkspaceSettings } from "../../lib/time";
import { downloadUrl, uploadFile } from "../../lib/work";

const TABS = ["operation", "productivity", "branding", "ai", "api-keys"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/configuracoes")({
  validateSearch: z.object({ tab: z.enum(TABS).optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("tenant.settings")) throw redirect({ to: "/" });
  },
  component: Settings,
});

function Settings() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const tab = search.tab ?? "operation";
  const navigate = useNavigate({ from: "/configuracoes" });
  const q = useQuery(settingsQuery);
  return (
    <>
      <PageHeader title={t("settings.title")} description={t("settings.subtitle")} />
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <Select
          className="md:hidden"
          aria-label={t("settings.section")}
          value={tab}
          onChange={(e) => void navigate({ search: { tab: e.target.value as Tab } })}
        >
          {TABS.map((k) => (
            <option key={k} value={k}>
              {t(`settings.tabs.${k}`)}
            </option>
          ))}
        </Select>
        <nav aria-label={t("settings.section")} className="hidden flex-col gap-0.5 md:flex">
          {TABS.map((k) => (
            <Link
              key={k}
              to="/configuracoes"
              search={{ tab: k }}
              className={cn(
                "rounded-md px-3 py-2 text-sm hover:bg-accent",
                tab === k && "bg-primary/15 font-medium text-primary hover:bg-primary/20",
              )}
            >
              {t(`settings.tabs.${k}`)}
            </Link>
          ))}
          <Link
            to="/cadastros"
            className="mt-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
          >
            {t("settings.catalogsLink")}
          </Link>
        </nav>
        <section className="min-w-0">
          <header className="mb-4">
            <h2 className="text-lg font-semibold">{t(`settings.tabs.${tab}`)}</h2>
            <p className="text-sm text-muted-foreground">{t(`settings.help.${tab}`)}</p>
          </header>
          {!q.data ? (
            q.isError ? (
              <p className="text-destructive">{errorMessage(t, q.error)}</p>
            ) : (
              <Skeleton className="h-64" />
            )
          ) : tab === "operation" ? (
            <Operation s={q.data} />
          ) : tab === "productivity" ? (
            <Productivity s={q.data} />
          ) : tab === "branding" ? (
            <Branding s={q.data} />
          ) : tab === "ai" ? (
            <Ai s={q.data} />
          ) : (
            <ApiKeys />
          )}
        </section>
      </div>
    </>
  );
}

/** Salva uma seção e põe a resposta no cache. */
function useSave<T>(fn: (v: T) => Promise<WorkspaceSettings>) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(settingsQuery.queryKey, data);
      void qc.invalidateQueries({ queryKey: ["workspace"] });
      void qc.invalidateQueries({ queryKey: ["time"] });
      toast.success(t("settings.saved"));
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
}

function Form({
  children,
  onSubmit,
  pending,
}: {
  children: ReactNode;
  onSubmit: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card className="p-4 md:p-6">
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
        <div>
          <Button type="submit" disabled={pending}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

const TIMEZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["America/Sao_Paulo"];
  }
})();

function Operation({ s }: { s: WorkspaceSettings }) {
  const { t } = useTranslation();
  const [tz, setTz] = useState(s.timezone);
  const [sla, setSla] = useState(String(s.operation.clientChaseSlaBusinessHours));
  const [idle, setIdle] = useState(String(s.operation.idleCardHours));
  const [week, setWeek] = useState<Week>(() =>
    Object.fromEntries(DAYS.map((d) => [d, s.operation.defaultBusinessHours.days[d] ?? []])),
  );
  const save = useSave(() =>
    unwrap(
      api.settings.operation.$put({
        json: {
          timezone: tz,
          clientChaseSlaBusinessHours: Number(sla),
          idleCardHours: Number(idle),
          defaultBusinessHours: { days: week as never },
        },
      }),
    ),
  );
  const zones = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES];
  return (
    <Form onSubmit={() => save.mutate(undefined)} pending={save.isPending}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="op-tz" label={t("settings.operation.timezone")}>
          <Select id="op-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="op-sla" label={t("settings.operation.sla")} hint={t("settings.operation.slaHint")}>
          <Input
            id="op-sla"
            type="number"
            min={1}
            max={500}
            required
            value={sla}
            onChange={(e) => setSla(e.target.value)}
          />
        </Field>
        <Field id="op-idle" label={t("settings.operation.idle")} hint={t("settings.operation.idleHint")}>
          <Input
            id="op-idle"
            type="number"
            min={1}
            max={1000}
            required
            value={idle}
            onChange={(e) => setIdle(e.target.value)}
          />
        </Field>
      </div>
      <fieldset className="grid gap-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("settings.operation.hours")}</legend>
        <p className="text-xs text-muted-foreground">{t("settings.operation.hoursHint")}</p>
        <WeekHoursEditor value={week} onChange={setWeek} />
      </fieldset>
    </Form>
  );
}

type Weights = WorkspaceSettings["productivityWeights"];
const W_FIELDS = {
  production: ["perPiece", "perBusinessHour", "onTimeBonus", "reworkPenalty"],
  accountManagement: ["perClientChase", "perShootBooked", "perPiece", "perIdleCard", "idleCardPenaltyCap"],
} as const;

function Productivity({ s }: { s: WorkspaceSettings }) {
  const { t } = useTranslation();
  const [w, setW] = useState<Weights>(s.productivityWeights);
  const save = useSave(() => unwrap(api.settings.productivity.$put({ json: w })));
  return (
    <Form onSubmit={() => save.mutate(undefined)} pending={save.isPending}>
      {(Object.keys(W_FIELDS) as (keyof typeof W_FIELDS)[]).map((group) => (
        <fieldset key={group} className="grid gap-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{t(`settings.productivity.${group}`)}</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {W_FIELDS[group].map((f) => (
              <Field key={f} id={`w-${group}-${f}`} label={t(`settings.productivity.fields.${group}.${f}`)}>
                <Input
                  id={`w-${group}-${f}`}
                  type="number"
                  step="0.5"
                  min={-1000}
                  max={1000}
                  required
                  value={String((w[group] as Record<string, number>)[f])}
                  onChange={(e) =>
                    setW((x) => ({ ...x, [group]: { ...x[group], [f]: Number(e.target.value) } }))
                  }
                />
              </Field>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="text-xs text-muted-foreground">{t("settings.productivity.note")}</p>
    </Form>
  );
}

function Branding({ s }: { s: WorkspaceSettings }) {
  const { t } = useTranslation();
  const [b, setB] = useState(s.branding);
  const [uploading, setUploading] = useState<null | "logo" | "favicon">(null);
  const save = useSave(() =>
    unwrap(
      api.settings.branding.$put({
        json: {
          primaryColor: b.primaryColor,
          secondaryColor: b.secondaryColor,
          chatColor: b.chatColor,
          logoFileId: b.logoFileId,
          faviconFileId: b.faviconFileId,
        },
      }),
    ),
  );
  const upload = async (kind: "logo" | "favicon", file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error(t("settings.branding.imageOnly"));
    setUploading(kind);
    try {
      const id = await uploadFile(file);
      setB((x) => ({ ...x, [kind === "logo" ? "logoFileId" : "faviconFileId"]: id }));
    } catch (e) {
      toast.error(errorMessage(t, e));
    } finally {
      setUploading(null);
    }
  };
  return (
    <Form onSubmit={() => save.mutate(undefined)} pending={save.isPending || !!uploading}>
      <div className="grid gap-4 sm:grid-cols-3">
        {(["primaryColor", "secondaryColor", "chatColor"] as const).map((k) => (
          <Field key={k} id={`br-${k}`} label={t(`settings.branding.${k}`)}>
            <ColorInput id={`br-${k}`} value={b[k]} onChange={(v) => setB((x) => ({ ...x, [k]: v }))} />
          </Field>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {(["logo", "favicon"] as const).map((kind) => {
          const id = kind === "logo" ? b.logoFileId : b.faviconFileId;
          return (
            <div key={kind} className="grid gap-2">
              <span className="text-sm font-medium">{t(`settings.branding.${kind}`)}</span>
              <div className="flex items-center gap-3">
                <div className="grid size-16 place-items-center overflow-hidden rounded-md border bg-muted">
                  {id ? (
                    <img src={downloadUrl(id)} alt="" className="max-h-full max-w-full object-contain" />
                  ) : null}
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
                  <Upload className="size-4" />
                  {uploading === kind ? t("files.uploading") : t("settings.branding.upload")}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    className="sr-only"
                    onChange={(e) => void upload(kind, e.target.files?.[0])}
                  />
                </label>
                {id && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setB((x) => ({ ...x, [kind === "logo" ? "logoFileId" : "faviconFileId"]: null }))
                    }
                  >
                    {t("common.remove")}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.branding.note")}</p>
    </Form>
  );
}

function Ai({ s }: { s: WorkspaceSettings }) {
  const { t } = useTranslation();
  const [a, setA] = useState({
    enabled: s.ai.enabled,
    assistantName: s.ai.assistantName ?? "",
    baseUrl: s.ai.baseUrl ?? "",
    model: s.ai.model ?? "",
  });
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const save = useSave(() =>
    unwrap(
      api.settings.ai.$put({
        json: {
          enabled: a.enabled,
          assistantName: a.assistantName.trim() || null,
          baseUrl: a.baseUrl.trim() || null,
          model: a.model.trim() || null,
          ...(clearKey ? { apiKey: null } : key.trim() ? { apiKey: key.trim() } : {}),
        },
      }),
    ).then((r) => {
      setKey("");
      setClearKey(false);
      return r;
    }),
  );
  return (
    <Form onSubmit={() => save.mutate(undefined)} pending={save.isPending}>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={a.enabled}
          onChange={(e) => setA((x) => ({ ...x, enabled: e.target.checked }))}
        />
        {t("settings.ai.enabled")}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="ai-name" label={t("settings.ai.name")}>
          <Input
            id="ai-name"
            maxLength={40}
            value={a.assistantName}
            onChange={(e) => setA((x) => ({ ...x, assistantName: e.target.value }))}
          />
        </Field>
        <Field id="ai-model" label={t("settings.ai.model")} hint={t("settings.ai.modelHint")}>
          <Input
            id="ai-model"
            maxLength={100}
            value={a.model}
            onChange={(e) => setA((x) => ({ ...x, model: e.target.value }))}
          />
        </Field>
        <Field id="ai-url" label={t("settings.ai.baseUrl")} hint={t("settings.ai.baseUrlHint")}>
          <Input
            id="ai-url"
            type="url"
            placeholder="https://api.openai.com/v1"
            value={a.baseUrl}
            onChange={(e) => setA((x) => ({ ...x, baseUrl: e.target.value }))}
          />
        </Field>
        <Field
          id="ai-key"
          label={t("settings.ai.key")}
          hint={s.ai.keyConfigured ? t("settings.ai.keySet") : t("settings.ai.keyMissing")}
        >
          <Input
            id="ai-key"
            type="password"
            autoComplete="off"
            placeholder={s.ai.keyConfigured ? "••••••••••••" : ""}
            value={key}
            disabled={clearKey}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
      </div>
      {s.ai.keyConfigured && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
          {t("settings.ai.clearKey")}
        </label>
      )}
      <p className="text-xs text-muted-foreground">{t("settings.ai.note")}</p>
    </Form>
  );
}

function ApiKeys() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(apiKeysQuery);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<{ id: string; name: string } | null>(null);
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short" });
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.settings["api-keys"].$post({ json: { name: name.trim(), expiresAt: expires || null } })),
    onSuccess: (r) => {
      setCreating(false);
      setName("");
      setExpires("");
      setShown(r.key);
      void qc.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => unwrapVoid(api.settings["api-keys"][":id"].$delete({ param: { id } })),
    onSuccess: () => {
      setRevoke(null);
      toast.success(t("settings.apiKeys.revoked"));
      void qc.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  return (
    <div className="grid gap-4">
      <div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> {t("settings.apiKeys.new")}
        </Button>
      </div>
      {q.isPending ? (
        <Skeleton className="h-32" />
      ) : !q.data?.data.length ? (
        <EmptyState
          icon={<KeyRound className="size-6" />}
          title={t("settings.apiKeys.empty")}
          description={t("settings.apiKeys.emptyText")}
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("settings.apiKeys.name")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.apiKeys.prefix")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.apiKeys.createdBy")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.apiKeys.lastUsed")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.apiKeys.expires")}</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {q.data.data.map((k) => (
                <tr key={k.id}>
                  <td className="px-3 py-2 font-medium">{k.name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{k.prefix}_…</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {k.createdBy ?? "—"} · {df.format(new Date(k.createdAt))}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {k.lastUsedAt ? df.format(new Date(k.lastUsedAt)) : t("settings.apiKeys.never")}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {k.expiresAt ? (
                      df.format(new Date(k.expiresAt))
                    ) : (
                      <Badge variant="outline">{t("settings.apiKeys.noExpiry")}</Badge>
                    )}
                  </td>
                  <td className="px-2">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={t("settings.apiKeys.revoke", { name: k.name })}
                      onClick={() => setRevoke({ id: k.id, name: k.name })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">{t("settings.apiKeys.note")}</p>

      <Dialog open={creating} onOpenChange={(o) => !o && setCreating(false)}>
        <DialogContent closeLabel={t("common.cancel")}>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("settings.apiKeys.new")}</DialogTitle>
              <DialogDescription>{t("settings.apiKeys.newHelp")}</DialogDescription>
            </DialogHeader>
            <Field id="key-name" label={t("settings.apiKeys.name")}>
              <Input
                id="key-name"
                required
                minLength={2}
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field id="key-exp" label={t("settings.apiKeys.expiresOptional")}>
              <Input id="key-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {t("settings.apiKeys.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!shown} onOpenChange={(o) => !o && setShown(null)}>
        <DialogContent closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("settings.apiKeys.createdTitle")}</DialogTitle>
            <DialogDescription>{t("settings.apiKeys.createdHelp")}</DialogDescription>
          </DialogHeader>
          <code className="break-all rounded-md border bg-muted p-3 text-xs">{shown}</code>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(shown ?? "");
                toast.success(t("settings.apiKeys.copied"));
              }}
            >
              <Copy /> {t("settings.apiKeys.copy")}
            </Button>
            <Button type="button" onClick={() => setShown(null)}>
              {t("settings.apiKeys.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!revoke}
        title={t("settings.apiKeys.revokeTitle")}
        description={t("settings.apiKeys.revokeText", { name: revoke?.name ?? "" })}
        confirmLabel={t("settings.apiKeys.revokeConfirm")}
        pending={del.isPending}
        onClose={() => setRevoke(null)}
        onConfirm={() => revoke && del.mutate(revoke.id)}
      />
    </div>
  );
}
