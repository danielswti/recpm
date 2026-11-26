/**
 * Mapa central de permissões (RBAC). Fonte única para:
 *  - a API (middleware `requirePermission`), e
 *  - a UI (`can()` para esconder/mostrar ações e itens de menu).
 *
 * Escopo fino (funcionario só vê projetos dos quais é membro; cliente só o próprio cliente)
 * é aplicado nas consultas e reforçado pelo RLS — aqui fica só "pode ou não pode a ação".
 */
import type { TenantRole } from "./roles";

export const PERMISSIONS = [
  // Tenant e administração
  "tenant.settings",
  "tenant.branding",
  "tenant.billing",
  "tenant.apiKeys",
  "tenant.export",
  "tenant.audit",
  "catalogs.manage",
  // Pessoas
  "members.read",
  "members.invite",
  "members.manage",
  // Clientes
  "clients.read",
  "clients.manage",
  // Projetos
  "projects.read",
  "projects.readAll",
  "projects.manage",
  // Tarefas
  "tasks.read",
  "tasks.readAll",
  "tasks.create",
  "tasks.manage",
  "tasks.approve",
  "tasks.archive",
  "tasks.requestArchive",
  // Tempo
  "time.track",
  "time.approve",
  "workingNow.view",
  // Financeiro e relatórios
  "finance.read",
  "finance.manage",
  "reports.read",
  "productivity.own",
  "productivity.team",
  // Colaboração
  "calendar.read",
  "calendar.manage",
  "chat.use",
  // Portal do cliente
  "portal.access",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = PERMISSIONS;

const GESTOR: readonly Permission[] = ALL.filter(
  (p) =>
    !p.startsWith("tenant.") && // sem cobrança, branding, chaves de API, exportações, auditoria
    p !== "catalogs.manage" &&
    p !== "members.manage" &&
    p !== "portal.access",
);

const FUNCIONARIO: readonly Permission[] = [
  "members.read",
  "clients.read",
  "projects.read",
  "tasks.read",
  "tasks.create",
  "tasks.requestArchive",
  "time.track",
  "productivity.own",
  "calendar.read",
  "chat.use",
];

/** O portal do cliente usa o mesmo mapa; o escopo "só o próprio cliente" vem do RLS. */
const CLIENTE: readonly Permission[] = [
  "portal.access",
  "projects.read",
  "tasks.read",
  "tasks.create",
  "tasks.manage",
];

export const ROLE_PERMISSIONS: Record<TenantRole, ReadonlySet<Permission>> = {
  admin: new Set(ALL.filter((p) => p !== "portal.access")),
  gestor: new Set(GESTOR),
  funcionario: new Set(FUNCIONARIO),
  cliente: new Set(CLIENTE),
};

export const can = (role: TenantRole | null | undefined, permission: Permission): boolean =>
  !!role && ROLE_PERMISSIONS[role].has(permission);
