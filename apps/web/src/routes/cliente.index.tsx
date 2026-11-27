import { Badge, Card, EmptyState, Skeleton } from "@recpm/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarClock, CheckCircle2, FileSignature, FolderKanban, Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PortalTaskRow, Progress } from "../components/portal/parts";
import { type PortalProject, portalHomeQuery } from "../lib/portal";

export const Route = createFileRoute("/cliente/")({ component: PortalHome });

function PortalHome() {
  const { t } = useTranslation();
  const q = useQuery(portalHomeQuery);
  if (q.isPending) return <Skeleton className="mt-4 h-64" />;
  if (!q.data) return null;
  const d = q.data;
  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("portal.home.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("portal.home.subtitle")}</p>
      </div>

      {(d.toSign > 0 || d.pendingDemands > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {d.toSign > 0 && (
            <Link to="/cliente/documentos">
              <Card className="flex items-center gap-3 border-primary/40 p-4 hover:bg-accent">
                <FileSignature className="size-5 text-primary" />
                <span className="text-sm font-medium">{t("portal.home.toSign", { count: d.toSign })}</span>
              </Card>
            </Link>
          )}
          {d.pendingDemands > 0 && (
            <Link to="/cliente/demandas">
              <Card className="flex items-center gap-3 p-4 hover:bg-accent">
                <Inbox className="size-5 text-muted-foreground" />
                <span className="text-sm">
                  {t("portal.home.pendingDemands", { count: d.pendingDemands })}
                </span>
              </Card>
            </Link>
          )}
        </div>
      )}

      <section className="grid gap-3">
        <h2 className="font-semibold">{t("portal.home.awaiting")}</h2>
        {d.awaiting.length ? (
          <Card className="divide-y">
            {d.awaiting.map((task) => (
              <PortalTaskRow key={task.id} task={task} />
            ))}
          </Card>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4" /> {t("portal.home.nothingAwaiting")}
          </p>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="font-semibold">{t("portal.home.projects")}</h2>
        {d.projects.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {d.projects.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<FolderKanban className="size-6" />} title={t("portal.home.noProjects")} />
        )}
      </section>
    </div>
  );
}

function ProjectCard({ p }: { p: PortalProject }) {
  const { t, i18n } = useTranslation();
  const df = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" });
  return (
    <Link to="/cliente/projetos/$id" params={{ id: p.id }} className="group">
      <Card className="grid h-full gap-3 p-4 group-hover:bg-accent/50">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 font-medium">{p.name}</h3>
          <Badge variant="outline">{t(`projects.status.${p.status}`)}</Badge>
        </div>
        {p.publicSummary && <p className="line-clamp-2 text-sm text-muted-foreground">{p.publicSummary}</p>}
        <Progress done={p.progress.done} total={p.progress.total} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {p.nextMilestone && (
            <span className="flex items-center gap-1">
              <CalendarClock className="size-3.5" />
              {p.nextMilestone.title} · {df.format(new Date(p.nextMilestone.date))}
            </span>
          )}
          {p.awaitingClient > 0 && (
            <span className="font-medium text-primary">
              {t("portal.home.awaitingCount", { count: p.awaitingClient })}
            </span>
          )}
        </div>
      </Card>
    </Link>
  );
}
