import { z } from "zod";
import { TENANT_ROLES } from "./roles";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
/** Subdomínios que nunca podem virar slug de tenant. */
export const RESERVED_SLUGS = new Set([
  "app",
  "api",
  "www",
  "admin",
  "cliente",
  "portal",
  "assinar",
  "verificar",
  "static",
  "assets",
  "mail",
  "status",
]);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_RE, "slug_invalido")
  .refine((s) => !RESERVED_SLUGS.has(s), "slug_reservado");

export const passwordSchema = z.string().min(10, "senha_curta").max(128);

/** Criação do workspace (tenant) por um usuário já autenticado. */
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: slugSchema,
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const inviteMemberSchema = z
  .object({
    email: z.email(),
    role: z.enum(TENANT_ROLES),
    clientId: z.uuid().optional(),
  })
  .refine((v) => (v.role === "cliente") === !!v.clientId, {
    message: "cliente_requer_clientId",
    path: ["clientId"],
  });
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/** Transforma um nome em sugestão de slug ("Agência Ápice" → "agencia-apice"). */
export const slugify = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
