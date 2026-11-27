import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "./api";

export type ClientFilters = { q?: string; status?: "active" | "inactive" | "all"; page?: number };

export const clientsQuery = (f: ClientFilters) =>
  queryOptions({
    queryKey: ["clients", "list", f],
    queryFn: () =>
      unwrap(
        api.clients.$get({
          query: { q: f.q, status: f.status ?? "active", page: String(f.page ?? 1), pageSize: "50" },
        }),
      ),
  });
export const clientQuery = (id: string) =>
  queryOptions({
    queryKey: ["clients", id],
    queryFn: () => unwrap(api.clients[":id"].$get({ param: { id } })),
  });
export const portalUsersQuery = (id: string) =>
  queryOptions({
    queryKey: ["clients", id, "portal-users"],
    queryFn: () => unwrap(api.clients[":id"]["portal-users"].$get({ param: { id } })),
  });

export type Client = Awaited<ReturnType<NonNullable<ReturnType<typeof clientQuery>["queryFn"]>>>;

/** 11222333000181 → 11.222.333/0001-81; 52998224725 → 529.982.247-25 */
export const formatDocument = (d: string | null) => {
  if (!d) return "";
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return d;
};
