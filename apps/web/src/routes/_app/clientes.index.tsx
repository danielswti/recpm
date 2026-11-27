import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  Skeleton,
} from "@recpm/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Building2, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { ClientForm } from "../../components/client-form";
import { PageHeader } from "../../components/page-header";
import { api, unwrap } from "../../lib/api";
import { clientsQuery } from "../../lib/clients";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";

export const Route = createFileRoute("/_app/clientes/")({
  validateSearch: z.object({
    q: z.string().optional(),
    status: z.enum(["active", "inactive", "all"]).optional(),
    page: z.number().int().min(1).optional(),
  }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("clients.read")) throw redirect({ to: "/" });
  },
  component: Clients,
});

function Clients() {
  const { t, i18n } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/clientes/" });
  const { data: me } = useQuery(meQuery);
  const canManage = !!me?.tenant?.permissions.includes("clients.manage");
  const [q, setQ] = useState(search.q ?? "");
  const [creating, setCreating] = useState(false);
  const list = useQuery({ ...clientsQuery(search), placeholderData: keepPreviousData });
  const num = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const page = search.page ?? 1;

  return (
    <>
      <PageHeader
        title={t("clients.title")}
        description={t("clients.subtitle")}
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("clients.new")}
            </Button>
          ) : null
        }
      />
      <form
        className="mb-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate({ search: (s) => ({ ...s, q: q || undefined, page: undefined }) });
        }}
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t("clients.search")}
            aria-label={t("clients.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select
          className="sm:w-48"
          aria-label={t("clients.filter")}
          value={search.status ?? "active"}
          onChange={(e) =>
            void navigate({
              search: (s) => ({ ...s, status: e.target.value as "active", page: undefined }),
            })
          }
        >
          {(["active", "inactive", "all"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`clients.status.${s}`)}
            </option>
          ))}
        </Select>
      </form>

      {list.isPending ? (
        <Card className="grid gap-2 p-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </Card>
      ) : list.isError ? (
        <p className="text-destructive">{errorMessage(t, list.error)}</p>
      ) : !list.data.data.length ? (
        <EmptyState
          icon={<Building2 className="size-6" />}
          title={search.q ? t("clients.noResults") : t("clients.empty")}
          description={search.q ? undefined : t("clients.emptyText")}
          action={
            canManage && !search.q ? (
              <Button onClick={() => setCreating(true)}>
                <Plus /> {t("clients.new")}
              </Button>
            ) : null
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("clients.cols.client")}</th>
                <th className="px-4 py-2 font-medium">{t("clients.cols.contact")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("clients.cols.projects")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("clients.cols.hours")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("clients.cols.portal")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.data.data.map((c) => (
                <tr key={c.id} className="hover:bg-accent/40">
                  <td className="px-4 py-3">
                    <Link to="/clientes/$id" params={{ id: c.id }} className="grid hover:underline">
                      <span className="font-medium">
                        {c.name} {!c.active && <Badge variant="secondary">{t("clients.inactive")}</Badge>}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{c.code}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <div className="truncate">{c.email ?? "—"}</div>
                    <div className="text-xs">{c.phone ?? ""}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {c.activeProjectCount}
                    <span className="text-muted-foreground"> / {c.projectCount}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {c.hours.contracted ? (
                      <span className={c.hours.remaining < 0 ? "text-destructive" : undefined}>
                        {t("clients.hoursLeft", { h: num.format(c.hours.remaining) })}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.portalUserCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {list.data && list.data.total > list.data.pageSize && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => void navigate({ search: (s) => ({ ...s, page: page - 1 }) })}
          >
            {t("platform.prev")}
          </Button>
          <span className="text-muted-foreground">
            {t("platform.pageOf", { page, pages: Math.ceil(list.data.total / list.data.pageSize) })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page * list.data.pageSize >= list.data.total}
            onClick={() => void navigate({ search: (s) => ({ ...s, page: page + 1 }) })}
          >
            {t("platform.next")}
          </Button>
        </div>
      )}
      {creating && <NewClientDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function NewClientDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (json: Parameters<typeof api.clients.$post>[0]["json"]) =>
      unwrap(api.clients.$post({ json })),
    onSuccess: async (c) => {
      toast.success(t("clients.created", { name: c.name }));
      await qc.invalidateQueries({ queryKey: ["clients"] });
      await navigate({ to: "/clientes/$id", params: { id: c.id } });
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")} className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("clients.new")}</DialogTitle>
        </DialogHeader>
        <ClientForm
          submitLabel={t("clients.create")}
          pending={create.isPending}
          error={create.error ? errorMessage(t, create.error) : null}
          onSubmit={(v) => create.mutate(v as never)}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
