/** Papéis dentro de um tenant (Membership.role). O papel de plataforma (super_admin) fica em users.role. */
export const TENANT_ROLES = ["admin", "gestor", "funcionario", "cliente"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** Papéis da equipe interna (todos menos o cliente do portal). */
export const STAFF_ROLES = ["admin", "gestor", "funcionario"] as const satisfies readonly TenantRole[];

export const isTenantRole = (v: unknown): v is TenantRole =>
  typeof v === "string" && (TENANT_ROLES as readonly string[]).includes(v);

/** Quem pode convidar quem: ninguém convida alguém acima de si. */
export const INVITABLE_ROLES: Record<TenantRole, readonly TenantRole[]> = {
  admin: ["admin", "gestor", "funcionario", "cliente"],
  gestor: ["funcionario", "cliente"],
  funcionario: [],
  cliente: [],
};
