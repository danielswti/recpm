/**
 * Usuários do workspace (§3, §6.7): lista (equipe ou portal), perfil de trabalho, papel,
 * ativar/desativar e envio de redefinição de senha.
 * Leitura: `members.read`. Mudanças: `members.manage` (só admin).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { assertSeatAvailable } from "@recpm/core";
import { type AppTx, schema } from "@recpm/db";
import { EMPLOYMENT_TYPES, memberProfileInput, SENIORITY_LEVELS, TENANT_ROLES } from "@recpm/shared";
import { and, asc, count, eq, ne } from "drizzle-orm";
import type { Deps } from "../deps";
import { audit, diff } from "../lib/audit";
import { AppError, isFkViolation } from "../lib/errors";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;
const tags = ["Pessoas"];

const BusinessHours = z.object({
  days: z.record(z.string(), z.array(z.object({ start: z.string(), end: z.string() }))),
});

const Member = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: z.enum(TENANT_ROLES),
    clientId: z.uuid().nullable(),
    clientName: z.string().nullable(),
    jobTitle: z.string().nullable(),
    level: z.enum(SENIORITY_LEVELS).nullable(),
    employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
    sectorId: z.uuid().nullable(),
    defaultTaskRoleId: z.uuid().nullable(),
    isAccountManager: z.boolean(),
    hourlyCostCents: z.number().nullable(),
    phone: z.string().nullable(),
    whatsapp: z.string().nullable(),
    birthday: z.string().nullable(),
    hireDate: z.string().nullable(),
    timezone: z.string().nullable(),
    businessHours: BusinessHours.nullable(),
    twoFactorEnabled: z.boolean(),
    active: z.boolean(),
    deactivatedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Member");

const ProfileBody = z.object(memberProfileInput.shape).openapi("MemberProfileInput");
const IdParam = z.object({ id: z.uuid() });
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});

const notFound = () => new AppError(404, "NOT_FOUND", "Usuário não encontrado.");

async function load(tx: AppTx, opts: { id?: string; kind?: "team" | "clients" | "all" } = {}) {
  const rows = await tx
    .select({ m: s.memberships, u: s.users, clientName: s.clients.name })
    .from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
    .leftJoin(s.clients, eq(s.clients.id, s.memberships.clientId))
    .where(
      and(
        opts.id ? eq(s.memberships.id, opts.id) : undefined,
        opts.kind === "team"
          ? ne(s.memberships.role, "cliente")
          : opts.kind === "clients"
            ? eq(s.memberships.role, "cliente")
            : undefined,
      ),
    )
    .orderBy(asc(s.users.name));
  return rows.map(({ m, u, clientName }) => ({
    id: m.id,
    userId: u.id,
    name: u.name,
    email: u.email,
    image: u.image,
    role: m.role,
    clientId: m.clientId,
    clientName,
    jobTitle: m.jobTitle,
    level: m.level,
    employmentType: m.employmentType,
    sectorId: m.sectorId,
    defaultTaskRoleId: m.defaultTaskRoleId,
    isAccountManager: m.isAccountManager,
    hourlyCostCents: m.hourlyCostCents,
    phone: m.phone,
    whatsapp: m.whatsapp,
    birthday: m.birthday,
    hireDate: m.hireDate,
    timezone: m.timezone,
    businessHours: (m.businessHours as z.infer<typeof BusinessHours> | null) ?? null,
    twoFactorEnabled: u.twoFactorEnabled,
    active: m.active,
    deactivatedAt: m.deactivatedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  }));
}

const one = async (tx: AppTx, id: string) => {
  const [m] = await load(tx, { id });
  if (!m) throw notFound();
  return m;
};

/** Pelo menos um admin ativo precisa sobrar. */
async function assertOtherAdmin(tx: AppTx, exceptId: string) {
  const [r] = await tx
    .select({ n: count() })
    .from(s.memberships)
    .where(
      and(eq(s.memberships.role, "admin"), eq(s.memberships.active, true), ne(s.memberships.id, exceptId)),
    );
  if (!r?.n)
    throw new AppError(409, "LAST_ADMIN", "O workspace precisa de pelo menos um administrador ativo.");
}

export const memberRoutes = (deps: Deps) => {
  const r = router();
  r.use("/members", requireTenant(deps.dbs), requirePermission("members.read"));
  r.use("/members/*", requireTenant(deps.dbs), requirePermission("members.read"));
  r.on(["POST", "PATCH"], "/members/*", requirePermission("members.manage"));

  return r
    .openapi(
      createRoute({
        method: "get",
        path: "/members",
        tags,
        summary: "Membros do workspace ativo",
        request: { query: z.object({ kind: z.enum(["team", "clients", "all"]).default("all") }) },
        responses: { 200: ok(z.object({ data: z.array(Member) })) },
      }),
      async (c) => {
        const { kind } = c.req.valid("query");
        return c.json({ data: await c.var.tenant.tx((tx) => load(tx, { kind })) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/members/{id}",
        tags,
        summary: "Membro",
        request: { params: IdParam },
        responses: { 200: ok(Member) },
      }),
      async (c) => c.json(await c.var.tenant.tx((tx) => one(tx, c.req.valid("param").id)), 200),
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/members/{id}",
        tags,
        summary: "Editar perfil de trabalho e papel",
        request: {
          params: IdParam,
          body: { content: { "application/json": { schema: ProfileBody } }, required: true },
        },
        responses: { 200: ok(Member) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const b = c.req.valid("json");
        const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
        try {
          const member = await c.var.tenant.tx(async (tx) => {
            const before = await one(tx, id);
            if (b.role && b.role !== before.role) {
              if (before.role === "cliente")
                throw new AppError(
                  400,
                  "PORTAL_ROLE_FIXED",
                  "Usuários do portal do cliente não mudam de papel.",
                );
              if (before.userId === c.var.tenant.userId)
                throw new AppError(409, "OWN_ROLE", "Você não pode mudar o próprio papel.");
              if (before.role === "admin") await assertOtherAdmin(tx, id);
            }
            await tx
              .update(s.memberships)
              .set({ ...patch, updatedAt: new Date() })
              .where(eq(s.memberships.id, id));
            const changes = diff(before, patch);
            if (Object.keys(changes).length)
              await audit(c, tx, {
                entity: "member",
                entityId: id,
                entityLabel: before.name,
                action: changes.role ? "role_change" : "update",
                details: changes,
              });
            return one(tx, id);
          });
          return c.json(member, 200);
        } catch (e) {
          if (isFkViolation(e)) throw new AppError(400, "INVALID_REFERENCE", "Setor ou função inválidos.");
          throw e;
        }
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/members/{id}/deactivate",
        tags,
        summary: "Desativar acesso (o histórico de trabalho continua)",
        request: { params: IdParam },
        responses: { 200: ok(Member) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const member = await c.var.tenant.tx(async (tx) => {
          const m = await one(tx, id);
          if (m.userId === c.var.tenant.userId)
            throw new AppError(409, "OWN_ACCOUNT", "Você não pode desativar o próprio acesso.");
          if (m.role === "admin") await assertOtherAdmin(tx, id);
          if (m.active) {
            await tx
              .update(s.memberships)
              .set({ active: false, deactivatedAt: new Date(), updatedAt: new Date() })
              .where(eq(s.memberships.id, id));
            await audit(c, tx, { entity: "member", entityId: id, entityLabel: m.name, action: "deactivate" });
          }
          return one(tx, id);
        });
        return c.json(member, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/members/{id}/reactivate",
        tags,
        summary: "Reativar acesso (respeita o limite de usuários do plano)",
        request: { params: IdParam },
        responses: { 200: ok(Member) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const member = await c.var.tenant.tx(async (tx) => {
          const m = await one(tx, id);
          if (!m.active) {
            await assertSeatAvailable(tx, m.role, { includePending: false });
            await tx
              .update(s.memberships)
              .set({ active: true, deactivatedAt: null, updatedAt: new Date() })
              .where(eq(s.memberships.id, id));
            await audit(c, tx, { entity: "member", entityId: id, entityLabel: m.name, action: "reactivate" });
          }
          return one(tx, id);
        });
        return c.json(member, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/members/{id}/reset-password",
        tags,
        summary: "Enviar e-mail de redefinição de senha ao usuário",
        request: { params: IdParam },
        responses: { 204: { description: "Enviado" } },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const m = await c.var.tenant.tx(async (tx) => {
          const m = await one(tx, id);
          if (!m.active)
            throw new AppError(409, "MEMBER_INACTIVE", "Reative o usuário antes de redefinir a senha.");
          await audit(c, tx, {
            entity: "member",
            entityId: id,
            entityLabel: m.name,
            action: "password_reset_sent",
          });
          return m;
        });
        await c.var.auth.api.requestPasswordReset({
          body: { email: m.email, redirectTo: `${deps.env.WEB_URL}/redefinir-senha` },
        });
        return c.body(null, 204);
      },
    );
};
