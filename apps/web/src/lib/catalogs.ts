import type { SimpleCatalog } from "@recpm/shared";
import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "./api";

export const catalogQuery = (kind: SimpleCatalog) =>
  queryOptions({
    queryKey: ["catalogs", kind],
    queryFn: () => unwrap(api.catalogs[":kind"].$get({ param: { kind } })),
  });
export const taskTypesQuery = queryOptions({
  queryKey: ["catalogs", "task-types"],
  queryFn: () => unwrap(api.catalogs["task-types"].$get()),
});
export const kanbanColumnsQuery = queryOptions({
  queryKey: ["catalogs", "kanban-columns"],
  queryFn: () => unwrap(api.catalogs["kanban-columns"].$get()),
});
export const briefingFormsQuery = queryOptions({
  queryKey: ["briefing-forms"],
  queryFn: () => unwrap(api["briefing-forms"].$get()),
});
export const briefingFormQuery = (id: string) =>
  queryOptions({
    queryKey: ["briefing-forms", id],
    queryFn: () => unwrap(api["briefing-forms"][":id"].$get({ param: { id } })),
  });

export type CatalogItem = Awaited<
  ReturnType<NonNullable<ReturnType<typeof catalogQuery>["queryFn"]>>
>["data"][number];
export type TaskType = Awaited<ReturnType<NonNullable<typeof taskTypesQuery.queryFn>>>["data"][number];
export type KanbanColumn = Awaited<
  ReturnType<NonNullable<typeof kanbanColumnsQuery.queryFn>>
>["data"][number];
