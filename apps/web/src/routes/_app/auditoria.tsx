/**
 * Log de auditoria (§6.15): só leitura, para admins. Filtros por pessoa, entidade, ação, período
 * e texto; paginação por cursor ("Carregar mais").
 */
import { Badge, Button, Card, EmptyState, Field, Input, Select, Skeleton } from "@recpm/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import { api, unwrap } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";

const Search = z.object({
  actorId: z.string().optional(),
  entity: z.string().optional(),
  action: z.string().optional(),
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
type Filters = z.infer<typeof Search>;

export const Route = createFileRoute("/_app/auditoria")({
  validateSearch: Search,
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("tenant.audit")) throw redirect({ to: "/" });
  },
  component: Audit,
});

function Audit() {
  const { t, i18n } = useTranslation();
  const f = Route.useSearch();
  const navigate = useNavigate({ from: "/auditoria" });
  const [text, setText] = useState(f.q ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const set = (p: Partial<Filters>) =>
    void navigate({ search: (s: Filters) => ({ ...s, ...p }), replace: true });
  const q = useInfiniteQuery({
    queryKey: ["audit", f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.audit.$get({
          query: {
            ...(f.actorId ? { actorId: f.actorId } : {}),
            ...(f.entity ? { entity: f.entity } : {}),
            ...(f.action ? { action: f.action } : {}),
            ...(f.q ? { q: f.q } : {}),
            ...(f.from ? { from: f.from } : {}),
            ...(f.to ? { to: f.to } : {}),
            ...(pageParam ? { before: pageParam } : {}),
            limit: "50",
          },
        }),
      ),
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const facets = q.data?.pages[0]?.facets;
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const dt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "medium" });
  const label = (kind: "entity" | "action", v: string) => {
    const k = `audit.${kind}s.${v.replace(/\./g, "_")}`;
    const tr = t(k);
    return tr === k ? v : tr;
  };
  return (
    <>
      <PageHeader title={t("audit.title")} description={t("audit.subtitle")} />
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
        <form
          className="sm:col-span-2 lg:col-span-1"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: text.trim() || undefined });
          }}
        >
          <Field id="au-q" label={t("audit.search")}>
            <Input
              id="au-q"
              type="search"
              placeholder={t("audit.searchPlaceholder")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => set({ q: text.trim() || undefined })}
            />
          </Field>
        </form>
        <Field id="au-actor" label={t("audit.actor")}>
          <Select
            id="au-actor"
            value={f.actorId ?? ""}
            onChange={(e) => set({ actorId: e.target.value || undefined })}
          >
            <option value="">{t("audit.all")}</option>
            {facets?.actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.id.slice(0, 8)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="au-entity" label={t("audit.entity")}>
          <Select
            id="au-entity"
            value={f.entity ?? ""}
            onChange={(e) => set({ entity: e.target.value || undefined })}
          >
            <option value="">{t("audit.all")}</option>
            {facets?.entities.map((x) => (
              <option key={x} value={x}>
                {label("entity", x)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="au-action" label={t("audit.action")}>
          <Select
            id="au-action"
            value={f.action ?? ""}
            onChange={(e) => set({ action: e.target.value || undefined })}
          >
            <option value="">{t("audit.all")}</option>
            {facets?.actions.map((x) => (
              <option key={x} value={x}>
                {label("action", x)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id="au-from" label={t("audit.from")}>
            <Input
              id="au-from"
              type="date"
              value={f.from ?? ""}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
          </Field>
          <Field id="au-to" label={t("audit.to")}>
            <Input
              id="au-to"
              type="date"
              value={f.to ?? ""}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </Field>
        </div>
      </Card>
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : q.isError ? (
        <p className="text-destructive">{errorMessage(t, q.error)}</p>
      ) : !rows.length ? (
        <EmptyState icon={<ScrollText className="size-6" />} title={t("audit.empty")} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8" />
                <th className="px-3 py-2 font-medium">{t("audit.when")}</th>
                <th className="px-3 py-2 font-medium">{t("audit.actor")}</th>
                <th className="px-3 py-2 font-medium">{t("audit.action")}</th>
                <th className="px-3 py-2 font-medium">{t("audit.entity")}</th>
                <th className="px-3 py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const expanded = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr className="align-top">
                      <td className="pl-2 pt-1.5">
                        {r.details && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-expanded={expanded}
                            aria-label={t("audit.details")}
                            onClick={() => setOpen(expanded ? null : r.id)}
                          >
                            {expanded ? <ChevronDown /> : <ChevronRight />}
                          </Button>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                        {dt.format(new Date(r.createdAt))}
                      </td>
                      <td className="px-3 py-2">
                        {r.actor.name ?? t("audit.system")}
                        {r.impersonated && (
                          <Badge variant="outline" className="ml-2">
                            {t("audit.impersonated")}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="secondary">{label("action", r.action)}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-muted-foreground">{label("entity", r.entity)}</span>
                        {r.entityLabel ? ` · ${r.entityLabel}` : ""}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.ip ?? "—"}</td>
                    </tr>
                    {expanded && r.details && (
                      <tr>
                        <td />
                        <td colSpan={5} className="px-3 pb-3">
                          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
                            {JSON.stringify(r.details, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            {t("audit.loadMore")}
          </Button>
        </div>
      )}
    </>
  );
}
