/** Consultas do portal do cliente e da fila de demandas da equipe. */
import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "./api";

export const portalHomeQuery = queryOptions({
  queryKey: ["portal", "home"],
  queryFn: () => unwrap(api.portal.home.$get()),
});
export const portalProjectQuery = (id: string) =>
  queryOptions({
    queryKey: ["portal", "project", id],
    queryFn: () => unwrap(api.portal.projects[":id"].$get({ param: { id } })),
  });
export const portalTaskQuery = (id: string) =>
  queryOptions({
    queryKey: ["portal", "task", id],
    queryFn: () => unwrap(api.portal.tasks[":id"].$get({ param: { id } })),
  });
export const portalDemandsQuery = queryOptions({
  queryKey: ["portal", "demands"],
  queryFn: () => unwrap(api.portal.demands.$get()),
});
export const portalDocumentsQuery = queryOptions({
  queryKey: ["portal", "documents"],
  queryFn: () => unwrap(api.portal.documents.$get()),
});
export const demandsQuery = (status: "pending" | "accepted" | "rejected" | "all") =>
  queryOptions({
    queryKey: ["demands", status],
    queryFn: () => unwrap(api.demands.$get({ query: { status } })),
  });

export type PortalHome = Awaited<ReturnType<typeof portalHomeQuery.queryFn & {}>>;
export type PortalProject = PortalHome["projects"][number];
export type PortalTaskItem = PortalHome["awaiting"][number];
export type PortalDemands = Awaited<ReturnType<NonNullable<typeof portalDemandsQuery.queryFn>>>;
export type BriefingForm = PortalDemands["forms"][number];
export type TeamDemand = Awaited<
  ReturnType<NonNullable<ReturnType<typeof demandsQuery>["queryFn"]>>
>["data"][number];
export type PortalDocument = Awaited<
  ReturnType<NonNullable<typeof portalDocumentsQuery.queryFn>>
>["data"][number];
