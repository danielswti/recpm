import { MutationCache, QueryClient, queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "./api";
import { limitCodeOf, useUpgradeModal } from "./upgrade-modal";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
  // Limite do plano em qualquer ação → modal de upgrade (além do erro local da tela).
  mutationCache: new MutationCache({
    onError: (e) => {
      const code = limitCodeOf(e);
      if (code) useUpgradeModal.getState().open(code);
    },
  }),
});

/** Sessão + workspace ativo + permissões. `null` = não autenticado. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    const r = await api.me.$get();
    if ((r.status as number) === 401) return null;
    return unwrap(Promise.resolve(r));
  },
  staleTime: 60_000,
});

export const workspaceQuery = queryOptions({
  queryKey: ["workspace"],
  queryFn: () => unwrap(api.workspace.$get()),
});

export const membersQuery = queryOptions({
  queryKey: ["members"],
  queryFn: () => unwrap(api.members.$get()),
});

export type Me = NonNullable<Awaited<ReturnType<NonNullable<typeof meQuery.queryFn>>>>;

export const entitlementsQuery = queryOptions({
  queryKey: ["entitlements"],
  queryFn: () => unwrap(api.entitlements.$get()),
  staleTime: 60_000,
});

export const billingQuery = queryOptions({
  queryKey: ["billing"],
  queryFn: () => unwrap(api.billing.$get()),
});
