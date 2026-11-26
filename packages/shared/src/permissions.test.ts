import { describe, expect, test } from "vitest";
import { can, PERMISSIONS, ROLE_PERMISSIONS } from "./permissions";
import { createWorkspaceSchema, slugify } from "./schemas";

describe("RBAC", () => {
  test("admin pode tudo da equipe, mas não é usuário do portal", () => {
    for (const p of PERMISSIONS) expect(can("admin", p)).toBe(p !== "portal.access");
  });
  test("gestor não mexe em cobrança, configurações nem catálogos", () => {
    expect(can("gestor", "tenant.billing")).toBe(false);
    expect(can("gestor", "tenant.settings")).toBe(false);
    expect(can("gestor", "catalogs.manage")).toBe(false);
    expect(can("gestor", "finance.manage")).toBe(true);
    expect(can("gestor", "tasks.approve")).toBe(true);
  });
  test("funcionario só a própria produtividade e pede arquivamento", () => {
    expect(can("funcionario", "productivity.own")).toBe(true);
    expect(can("funcionario", "productivity.team")).toBe(false);
    expect(can("funcionario", "tasks.archive")).toBe(false);
    expect(can("funcionario", "tasks.requestArchive")).toBe(true);
  });
  test("cliente só acessa o portal", () => {
    expect(can("cliente", "portal.access")).toBe(true);
    expect(can("cliente", "finance.read")).toBe(false);
    expect(can("cliente", "members.read")).toBe(false);
    expect(ROLE_PERMISSIONS.cliente.size).toBeLessThan(ROLE_PERMISSIONS.funcionario.size);
  });
  test("sem papel, nada", () => expect(can(null, "tasks.read")).toBe(false));
});

describe("slugs", () => {
  test("slugify remove acentos e espaços", () =>
    expect(slugify("Agência Ápice  Filmes!")).toBe("agencia-apice-filmes"));
  test("slug reservado é recusado", () => {
    expect(createWorkspaceSchema.safeParse({ name: "App", slug: "app" }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: "Ápice", slug: "apice" }).success).toBe(true);
  });
});
