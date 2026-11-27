import { useQuery } from "@tanstack/react-query";
import { entitlementsQuery } from "./queries";

/** Entitlements do workspace ativo (plano, recursos, uso). Espelha o PlanGuard da API. */
export const useEntitlements = () => useQuery(entitlementsQuery);
