/**
 * Contratado × entregue (§6.5): no mês escolhido, por cliente e para todos, peças contratadas
 * (itens de contrato dos projetos mensais vigentes), entregues, em andamento e a começar,
 * por categoria de relatório. Exporta e abre uma página limpa para mandar ao cliente.
 */
import { Button, Card, EmptyState, Input, Select } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, Scale } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PageHeader } from "../../components/page-header";
import { CxdTable } from "../../components/reports/cxd-table";
import { ExportMenu, HelpPanel, LoadingGrid, Stat } from "../../components/reports/report-ui";
import { clientsQuery } from "../../lib/clients";
import { errorMessage } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { contractedDeliveredQuery, thisMonth } from "../../lib/reports";

export const Route = createFileRoute("/_app/contratado-entregue")({
  validateSearch: z.object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional(),
    clientId: z.string().optional(),
  }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me?.tenant?.permissions.includes("reports.read")) throw redirect({ to: "/" });
  },
  component: ContractedDelivered,
});

function ContractedDelivered() {
  const { t, i18n } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/contratado-entregue" });
  const month = search.month ?? thisMonth();
  const q = useQuery(contractedDeliveredQuery(month, search.clientId));
  const clients = useQuery(clientsQuery({ status: "all" }));
  const d = q.data;
  const n = (v: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(v);
  const printHref = `/relatorio/contratado-entregue?month=${month}${search.clientId ? `&clientId=${search.clientId}` : ""}`;

  return (
    <>
      <PageHeader title={t("reports.cxd.title")} description={t("reports.cxd.subtitle")} />
      <div className="mb-6 flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs text-muted-foreground">
          {t("reports.month")}
          <Input
            type="month"
            className="w-44"
            value={month}
            onChange={(e) =>
              e.target.value && void navigate({ search: (s) => ({ ...s, month: e.target.value }) })
            }
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          {t("reports.client")}
          <Select
            className="w-52"
            value={search.clientId ?? ""}
            onChange={(e) =>
              void navigate({ search: (s) => ({ ...s, clientId: e.target.value || undefined }) })
            }
          >
            <option value="">{t("reports.allClients")}</option>
            {clients.data?.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href={printHref} target="_blank" rel="noreferrer">
              <ExternalLink /> {t("reports.cxd.clientPage")}
            </a>
          </Button>
          <ExportMenu report="contracted-delivered" params={{ month, clientId: search.clientId }} />
        </div>
      </div>
      <HelpPanel title={t("reports.help.title")}>
        <ul className="list-disc pl-5">
          <li>{t("reports.cxd.help.contracted")}</li>
          <li>{t("reports.cxd.help.delivered")}</li>
          <li>{t("reports.cxd.help.inProgress")}</li>
          <li>{t("reports.cxd.help.toStart")}</li>
          <li>{t("reports.cxd.help.others")}</li>
        </ul>
      </HelpPanel>
      {q.isError ? (
        <p className="text-destructive">{errorMessage(t, q.error)}</p>
      ) : !d ? (
        <LoadingGrid />
      ) : !d.clients.length ? (
        <EmptyState
          icon={<Scale className="size-6" />}
          title={t("reports.cxd.empty")}
          description={t("reports.cxd.emptyText")}
        />
      ) : (
        <div className="grid gap-4">
          {!!d.warnings.length && (
            <Card className="border-amber-500/40 bg-amber-500/10 p-4 text-sm" role="status">
              <p className="mb-1 flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4 text-amber-600" />{" "}
                {t("reports.cxd.warning", { count: d.warnings.length })}
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {d.warnings.map((w) => (
                  <li key={w.projectId}>
                    <Link
                      to="/projetos/$id"
                      params={{ id: w.projectId }}
                      className="underline-offset-4 hover:underline"
                    >
                      {w.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t("reports.cxd.contracted")} value={n(d.all.total.contracted)} />
            <Stat label={t("reports.cxd.delivered")} value={d.all.total.delivered} />
            <Stat label={t("reports.cxd.inProgress")} value={d.all.total.inProgress} />
            <Stat label={t("reports.cxd.toStart")} value={n(d.all.total.toStart)} />
          </div>
          {d.clients.length > 1 && (
            <Card className="relative min-w-0 overflow-x-auto">
              <p className="px-4 pt-3 text-sm font-medium">{t("reports.allClients")}</p>
              <CxdTable categories={d.categories} cells={d.all.cells} total={d.all.total} />
            </Card>
          )}
          {d.clients.map((c) => (
            <Card key={c.client?.id ?? "none"} className="relative min-w-0 overflow-x-auto">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-3">
                <h2 className="font-semibold">
                  {c.client ? (
                    <Link to="/clientes/$id" params={{ id: c.client.id }} className="hover:underline">
                      <span className="font-mono text-xs text-muted-foreground">{c.client.code}</span>{" "}
                      {c.client.name}
                    </Link>
                  ) : (
                    t("reports.noClient")
                  )}
                </h2>
                {!!c.projects.length && (
                  <span className="truncate text-xs text-muted-foreground">
                    {c.projects.map((p) => p.name).join(" · ")}
                  </span>
                )}
                {c.client && (
                  <button
                    type="button"
                    className="ml-auto text-xs text-primary hover:underline"
                    onClick={() => void navigate({ search: (s) => ({ ...s, clientId: c.client!.id }) })}
                  >
                    {t("reports.cxd.onlyThis")}
                  </button>
                )}
              </div>
              <CxdTable categories={d.categories} cells={c.cells} total={c.total} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
