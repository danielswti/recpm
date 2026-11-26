import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { schema } from "@recpm/db";
import { TENANT_ROLES } from "@recpm/shared";
import { asc, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";
import type { AppEnv } from "../types";

const Member = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: z.enum(TENANT_ROLES),
    jobTitle: z.string().nullable(),
    active: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Member");

const listMembers = createRoute({
  method: "get",
  path: "/members",
  tags: ["Pessoas"],
  summary: "Membros do workspace ativo",
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(Member) }) } },
    },
  },
});

export const memberRoutes = (deps: Deps) => {
  const r = new OpenAPIHono<AppEnv>();
  r.use("/members", requireTenant(deps.dbs), requirePermission("members.read"));
  return r.openapi(listMembers, async (c) => {
    const rows = await c.var.tenant.tx((tx) =>
      tx
        .select({
          id: schema.memberships.id,
          userId: schema.memberships.userId,
          name: schema.users.name,
          email: schema.users.email,
          image: schema.users.image,
          role: schema.memberships.role,
          jobTitle: schema.memberships.jobTitle,
          active: schema.memberships.active,
          createdAt: schema.memberships.createdAt,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .orderBy(asc(schema.users.name)),
    );
    return c.json({ data: rows.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) }, 200);
  });
};
