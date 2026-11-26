import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { schema, withTenant } from "@recpm/db";
import { PERMISSIONS, ROLE_PERMISSIONS, TENANT_ROLES } from "@recpm/shared";
import { and, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { requireSession } from "../middleware/session";
import type { AppEnv } from "../types";

const Me = z
  .object({
    user: z.object({
      id: z.uuid(),
      name: z.string(),
      email: z.string(),
      image: z.string().nullable(),
      locale: z.string(),
      timezone: z.string(),
      twoFactorEnabled: z.boolean(),
      platformRole: z.string(),
    }),
    tenant: z
      .object({
        id: z.uuid(),
        name: z.string(),
        slug: z.string(),
        role: z.enum(TENANT_ROLES),
        permissions: z.array(z.enum(PERMISSIONS)),
      })
      .nullable(),
  })
  .openapi("Me");

const getMe = createRoute({
  method: "get",
  path: "/me",
  tags: ["Sessão"],
  summary: "Usuário logado, workspace ativo, papel e permissões",
  responses: { 200: { description: "OK", content: { "application/json": { schema: Me } } } },
});

export const meRoutes = (deps: Deps) => {
  const r = new OpenAPIHono<AppEnv>();
  r.use("/me", requireSession);
  return r.openapi(getMe, async (c) => {
    const { user, session } = c.var.session!;
    const u = user as typeof user & {
      locale?: string;
      timezone?: string;
      twoFactorEnabled?: boolean;
      role?: string;
    };
    const tenantId = session.activeOrganizationId ?? null;

    let tenant: z.infer<typeof Me>["tenant"] = null;
    if (tenantId) {
      const row = await withTenant(deps.dbs.appDb, { tenantId, userId: user.id }, async (tx) => {
        const [m] = await tx
          .select({ role: schema.memberships.role, active: schema.memberships.active })
          .from(schema.memberships)
          .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.userId, user.id)));
        const [t] = await tx
          .select({ name: schema.tenants.name, slug: schema.tenants.slug })
          .from(schema.tenants);
        return m?.active && t ? { ...t, role: m.role } : null;
      });
      if (row) tenant = { id: tenantId, ...row, permissions: [...ROLE_PERMISSIONS[row.role]] };
    }

    return c.json(
      {
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          image: u.image ?? null,
          locale: u.locale ?? "pt-BR",
          timezone: u.timezone ?? "America/Sao_Paulo",
          twoFactorEnabled: !!u.twoFactorEnabled,
          platformRole: u.role ?? "user",
        },
        tenant,
      },
      200,
    );
  });
};
