/**
 * Versão limpa do contratado × entregue para mandar ao cliente: sem menu, tema claro,
 * pronta para imprimir ou salvar em PDF pelo navegador.
 */
import { Button, Skeleton } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { CxdTable } from "../components/reports/cxd-table";
import { errorMessage } from "../lib/errors";
import { requireUser } from "../lib/guards";
import { workspaceQuery } from "../lib/queries";
import { contractedDeliveredQuery, thisMonth } from "../lib/reports";

export const Route = createFileRoute("/relatorio/contratado-entregue")({
  validateSearch: z.object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional(),
    clientId: z.string().optional(),
  }),
  beforeLoad: ({ context, location }) => requireUser(context.queryClient, location.href),
  component: PrintableCxd,
});

function PrintableCxd() {
  const { t, i18n } = useTranslation();
  const search = Route.useSearch();
  const month = search.month ?? thisMonth();
  const q = useQuery(contractedDeliveredQuery(month, search.clientId));
  const ws = useQuery(workspaceQuery);
  const monthName = new Intl.DateTimeFormat(i18n.language, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-15T12:00:00Z`));
  const label = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  // página para o cliente: sempre clara
  useEffect(() => {
    const root = document.documentElement;
    const had = root.classList.contains("dark");
    root.classList.remove("dark");
    return () => {
      if (had) root.classList.add("dark");
    };
  }, []);
  const d = q.data;
  const single = d?.clients.length === 1 ? d.clients[0] : null;
  return (
    <div className="min-h-dvh bg-white text-neutral-900">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b pb-4">
          <div>
            <p className="text-sm text-neutral-500">{ws.data?.name ?? ""}</p>
            <h1 className="text-2xl font-semibold">{t("reports.cxd.title")}</h1>
            <p className="text-sm text-neutral-600">
              {label}
              {single?.client ? ` · ${single.client.name}` : ""}
            </p>
          </div>
          <Button variant="outline" className="print:hidden" onClick={() => window.print()}>
            <Printer /> {t("reports.cxd.print")}
          </Button>
        </header>
        {q.isError ? (
          <p className="text-red-600">{errorMessage(t, q.error)}</p>
        ) : !d ? (
          <Skeleton className="h-40" />
        ) : !d.clients.length ? (
          <p className="text-neutral-500">{t("reports.cxd.empty")}</p>
        ) : (
          <div className="grid gap-8">
            {d.clients.map((c) => (
              <section
                key={c.client?.id ?? "none"}
                className="relative min-w-0 break-inside-avoid overflow-x-auto"
              >
                {!single && (
                  <h2 className="mb-2 font-semibold">
                    {c.client ? `${c.client.code} · ${c.client.name}` : t("reports.noClient")}
                  </h2>
                )}
                {!!c.projects.length && (
                  <p className="mb-2 text-xs text-neutral-500">{c.projects.map((p) => p.name).join(" · ")}</p>
                )}
                <CxdTable categories={d.categories} cells={c.cells} total={c.total} print />
              </section>
            ))}
            <footer className="border-t pt-3 text-xs text-neutral-500">
              {t("reports.cxd.printFoot", {
                date: new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: "short",
                  timeStyle: "short",
                }).format(new Date()),
              })}
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
