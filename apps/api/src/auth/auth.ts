/**
 * Better Auth: e-mail/senha (argon2id), Google OAuth, 2FA (TOTP), organizações = tenants,
 * convites, reset de senha e plugin admin (super_admin + personificação auditada).
 *
 * O adapter roda no pool do papel `recpm_auth` (ignora RLS, mas só tem GRANT nas tabelas de
 * autenticação). A criação de tenant NÃO passa pelo Better Auth: é feita pela rota
 * POST /api/v1/workspaces numa transação única com os padrões do tenant.
 */

import { assertSeatAvailable, DomainError } from "@recpm/core";
import { schema, withTenant } from "@recpm/db";
import { INVITABLE_ROLES, isTenantRole } from "@recpm/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc as platformAdminAc, userAc as platformUserAc } from "better-auth/plugins/admin/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { and, desc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Deps } from "../deps";
import { hashPassword, verifyPassword } from "../lib/password";
import { redisSecondaryStorage } from "../lib/redis";
import { invitationEmail, resetPasswordEmail, verifyEmailEmail } from "./emails";

/** Permissões dos endpoints nativos de organização do Better Auth, por papel do tenant. */
const ac = createAccessControl(defaultStatements);
export const orgRoles = {
  admin: ac.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: [],
    ac: [],
  }),
  gestor: ac.newRole({ organization: [], member: [], invitation: ["create", "cancel"], team: [], ac: [] }),
  funcionario: ac.newRole({ organization: [], member: [], invitation: [], team: [], ac: [] }),
  cliente: ac.newRole({ organization: [], member: [], invitation: [], team: [], ac: [] }),
};

export const createAuth = (deps: Deps) => {
  const { env, dbs, mailer, redis } = deps;

  const roleOf = async (tenantId: string, userId: string) => {
    const [m] = await dbs.authDb
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.userId, userId)));
    return m?.role ?? null;
  };

  /** Workspace ativo (não somente leitura) e limite de usuários do plano (convites pendentes contam no convite). */
  const seats = async (tenantId: string, role: string, includePending: boolean) => {
    try {
      await withTenant(dbs.appDb, { tenantId, actor: "system" }, async (tx) => {
        const [t] = await tx.select({ status: schema.tenants.status }).from(schema.tenants);
        if (t?.status !== "active")
          throw new DomainError(403, "TENANT_READ_ONLY", "Workspace em modo somente leitura.");
        await assertSeatAvailable(tx, role, { includePending });
      });
    } catch (e) {
      if (e instanceof DomainError)
        throw new APIError(e.status === 402 ? "PAYMENT_REQUIRED" : "FORBIDDEN", {
          code: e.code,
          message: e.message,
          ...e.details,
        });
      throw e;
    }
  };

  return betterAuth({
    appName: "Rec PM",
    baseURL: env.API_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.WEB_URL],
    database: drizzleAdapter(dbs.authDb, {
      provider: "pg",
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
        twoFactors: schema.twoFactors,
        tenants: schema.tenants,
        memberships: schema.memberships,
        invitations: schema.invitations,
      },
    }),
    secondaryStorage: redis ? redisSecondaryStorage(redis) : undefined,
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: "recpm",
      useSecureCookies: env.NODE_ENV === "production",
    },
    user: {
      modelName: "users",
      additionalFields: {
        locale: { type: "string", required: false, defaultValue: "pt-BR", input: true },
        timezone: { type: "string", required: false, defaultValue: "America/Sao_Paulo", input: true },
        termsAcceptedAt: { type: "date", required: false, input: false, returned: false },
        privacyAcceptedAt: { type: "date", required: false, input: false, returned: false },
      },
    },
    session: {
      modelName: "sessions",
      // sessões no Postgres (auditáveis, revogáveis) com cache no Valkey
      storeSessionInDatabase: true,
      expiresIn: 60 * 60 * 24 * 30, // "manter conectado": 30 dias, renovado com o uso
      updateAge: 60 * 60 * 24,
    },
    account: { modelName: "accounts", accountLinking: { enabled: true, trustedProviders: ["google"] } },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      password: { hash: hashPassword, verify: verifyPassword },
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        await mailer.send(resetPasswordEmail(user.email, user.name, url));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send(verifyEmailEmail(user.email, user.name, url));
      },
    },
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {},
    rateLimit: {
      enabled: env.NODE_ENV !== "test",
      storage: redis ? "secondary-storage" : "memory",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Nova sessão (login) já abre no workspace mais recente do usuário, se houver.
          before: async (session) => {
            const [m] = await dbs.authDb
              .select({ tenantId: schema.memberships.tenantId })
              .from(schema.memberships)
              .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
              .where(and(eq(schema.memberships.userId, session.userId), eq(schema.memberships.active, true)))
              .orderBy(desc(schema.memberships.createdAt))
              .limit(1);
            return { data: { ...session, activeOrganizationId: m?.tenantId ?? null } };
          },
        },
      },
      user: {
        create: {
          // O aceite é exigido na tela de cadastro (e no hook abaixo, para e-mail/senha).
          before: async (user) => ({
            data: { ...user, termsAcceptedAt: new Date(), privacyAcceptedAt: new Date() },
          }),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email" && ctx.body?.acceptTerms !== true) {
          throw new APIError("BAD_REQUEST", {
            code: "TERMS_NOT_ACCEPTED",
            message: "É preciso aceitar os termos e a política de privacidade.",
          });
        }
      }),
    },
    plugins: [
      twoFactor({ issuer: "Rec PM", schema: { twoFactor: { modelName: "twoFactors" } } }),
      admin({
        defaultRole: "user",
        adminRoles: ["super_admin"],
        roles: { user: platformUserAc, super_admin: platformAdminAc },
      }),
      organization({
        ac,
        roles: orgRoles,
        creatorRole: "admin",
        allowUserToCreateOrganization: false,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        cancelPendingInvitationsOnReInvite: true,
        schema: {
          session: { fields: { activeOrganizationId: "activeTenantId" } },
          organization: { modelName: "tenants" },
          member: {
            modelName: "memberships",
            fields: { organizationId: "tenantId" },
            additionalFields: { clientId: { type: "string", required: false, input: false } },
          },
          invitation: {
            modelName: "invitations",
            fields: { organizationId: "tenantId" },
            additionalFields: { clientId: { type: "string", required: false, input: true } },
          },
        },
        sendInvitationEmail: async ({ id, email, inviter, organization: org }) => {
          await mailer.send(
            invitationEmail(email, inviter.user.name, org.name, `${env.WEB_URL}/convite/${id}`),
          );
        },
        organizationHooks: {
          // Ninguém convida alguém acima de si; usuário do portal precisa de um cliente válido.
          beforeCreateInvitation: async ({ invitation, inviter }) => {
            const inviterRole = await roleOf(invitation.organizationId, inviter.id);
            if (
              !isTenantRole(invitation.role) ||
              !inviterRole ||
              !INVITABLE_ROLES[inviterRole].includes(invitation.role)
            ) {
              throw new APIError("FORBIDDEN", {
                code: "ROLE_NOT_INVITABLE",
                message: "Você não pode convidar alguém com este papel.",
              });
            }
            await seats(invitation.organizationId, invitation.role, true);
            const clientId = (invitation.clientId as string | undefined) ?? null;
            if ((invitation.role === "cliente") !== !!clientId) {
              throw new APIError("BAD_REQUEST", {
                code: "CLIENT_REQUIRED",
                message: "Convite de cliente precisa indicar o cliente.",
              });
            }
            if (clientId) {
              const found = await withTenant(
                dbs.appDb,
                { tenantId: invitation.organizationId, actor: "system" },
                (tx) =>
                  tx
                    .select({ id: schema.clients.id })
                    .from(schema.clients)
                    .where(eq(schema.clients.id, clientId)),
              );
              if (!found.length)
                throw new APIError("BAD_REQUEST", {
                  code: "CLIENT_NOT_FOUND",
                  message: "Cliente não encontrado.",
                });
            }
          },
          // Ao aceitar: respeita o limite de usuários do plano e herda o cliente do convite.
          beforeAddMember: async ({ member, user }) => {
            await seats(member.organizationId, member.role, false);
            if (member.role !== "cliente") return;
            const [inv] = await dbs.authDb
              .select({ clientId: schema.invitations.clientId })
              .from(schema.invitations)
              .where(
                and(
                  eq(schema.invitations.tenantId, member.organizationId),
                  eq(schema.invitations.email, user.email.toLowerCase()),
                  eq(schema.invitations.status, "pending"),
                ),
              );
            return { data: { ...member, clientId: inv?.clientId ?? null } };
          },
        },
      }),
    ],
  });
};

export type Auth = ReturnType<typeof createAuth>;
