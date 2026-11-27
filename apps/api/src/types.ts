import type { AppTx, TenantContext } from "@recpm/db";
import type { Permission, TenantRole } from "@recpm/shared";
import type { Auth } from "./auth/auth";

export type SessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

export type TenantScope = {
  tenantId: string;
  userId: string;
  role: TenantRole;
  clientId: string | null;
  status: "active" | "read_only" | "suspended";
  /** Abre a transação com o contexto RLS deste request. */
  tx: <T>(fn: (tx: AppTx) => Promise<T>) => Promise<T>;
  context: TenantContext;
};

export type AppEnv = {
  Variables: {
    requestId: string;
    auth: Auth;
    session: SessionData | null;
    tenant: TenantScope;
    permission?: Permission;
  };
};
