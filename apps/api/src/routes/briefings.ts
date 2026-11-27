/**
 * Formulários de briefing (§5, §6.12): construtor com campos ordenados, duplicar e desativar.
 * Apagar é lógico (deletedAt): respostas antigas guardam o snapshot dos campos.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { type AppTx, schema } from "@recpm/db";
import { BRIEFING_FIELD_TYPES, briefingFieldInput, briefingFormInput } from "@recpm/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Deps } from "../deps";
import { audit } from "../lib/audit";
import { AppError, isFkViolation } from "../lib/errors";
import { router } from "../lib/router";
import { requirePermission } from "../middleware/rbac";
import { requireTenant } from "../middleware/tenant";

const s = schema;
const tags = ["Cadastros"];

const Field = z
  .object({
    id: z.uuid(),
    label: z.string(),
    type: z.enum(BRIEFING_FIELD_TYPES),
    options: z.array(z.string()),
    allowOther: z.boolean(),
    required: z.boolean(),
    help: z.string().nullable(),
  })
  .openapi("BriefingField");
const Summary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    taskTypeId: z.uuid().nullable(),
    projectTypeId: z.uuid().nullable(),
    active: z.boolean(),
    fieldCount: z.number(),
    updatedAt: z.string(),
  })
  .openapi("BriefingFormSummary");
const Form = Summary.extend({ fields: z.array(Field) }).openapi("BriefingForm");

const FieldBody = z.object(briefingFieldInput.shape);
const FormBody = z
  .object({ ...briefingFormInput.shape, fields: z.array(FieldBody).max(100) })
  .openapi("BriefingFormInput");
const IdParam = z.object({ id: z.uuid() });
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});

const notFound = () => new AppError(404, "NOT_FOUND", "Formulário não encontrado.");

async function load(tx: AppTx, id?: string) {
  const forms = await tx
    .select()
    .from(s.briefingForms)
    .where(and(isNull(s.briefingForms.deletedAt), id ? eq(s.briefingForms.id, id) : undefined))
    .orderBy(asc(s.briefingForms.name));
  if (!forms.length) return [];
  const fields = await tx
    .select()
    .from(s.briefingFields)
    .where(
      inArray(
        s.briefingFields.formId,
        forms.map((f) => f.id),
      ),
    )
    .orderBy(asc(s.briefingFields.position));
  return forms.map((f) => {
    const own = fields.filter((x) => x.formId === f.id);
    return {
      id: f.id,
      name: f.name,
      description: f.description,
      taskTypeId: f.taskTypeId,
      projectTypeId: f.projectTypeId,
      active: f.active,
      fieldCount: own.length,
      updatedAt: f.updatedAt.toISOString(),
      fields: own.map((x) => ({
        id: x.id,
        label: x.label,
        type: x.type,
        options: x.options,
        allowOther: x.allowOther,
        required: x.required,
        help: x.help,
      })),
    };
  });
}

/** Valida as regras dos campos (opções em campos de escolha) que o schema OpenAPI não carrega. */
const parseFields = (fields: unknown) => {
  const r = z.array(briefingFieldInput).safeParse(fields);
  if (!r.success) throw new AppError(400, "VALIDATION", r.error.issues[0]?.message ?? "Campos inválidos.");
  return r.data;
};

async function writeFields(tx: AppTx, tenantId: string, formId: string, fields: z.infer<typeof FieldBody>[]) {
  await tx.delete(s.briefingFields).where(eq(s.briefingFields.formId, formId));
  if (fields.length)
    await tx.insert(s.briefingFields).values(
      fields.map((f, position) => ({
        tenantId,
        formId,
        label: f.label,
        type: f.type,
        options: f.type === "escolha_unica" || f.type === "caixas" ? f.options : [],
        allowOther: f.allowOther,
        required: f.required,
        help: f.help ?? null,
        position,
      })),
    );
}

const refError = (e: unknown) => {
  if (isFkViolation(e))
    return new AppError(400, "INVALID_REFERENCE", "Tipo de tarefa ou de projeto inválido.");
  return e;
};

export const briefingRoutes = (deps: Deps) => {
  const r = router();
  r.use("/briefing-forms/*", requireTenant(deps.dbs));
  r.use("/briefing-forms", requireTenant(deps.dbs));
  r.on(
    ["POST", "PUT", "DELETE"],
    ["/briefing-forms", "/briefing-forms/*"],
    requirePermission("catalogs.manage"),
  );

  return r
    .openapi(
      createRoute({
        method: "get",
        path: "/briefing-forms",
        tags,
        summary: "Formulários de briefing",
        responses: { 200: ok(z.object({ data: z.array(Summary) })) },
      }),
      async (c) => {
        const forms = await c.var.tenant.tx((tx) => load(tx));
        return c.json({ data: forms.map(({ fields: _f, ...f }) => f) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/briefing-forms/{id}",
        tags,
        summary: "Formulário com os campos",
        request: { params: IdParam },
        responses: { 200: ok(Form) },
      }),
      async (c) => {
        const [form] = await c.var.tenant.tx((tx) => load(tx, c.req.valid("param").id));
        if (!form) throw notFound();
        return c.json(form, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/briefing-forms",
        tags,
        summary: "Criar formulário",
        request: { body: { content: { "application/json": { schema: FormBody } }, required: true } },
        responses: { 201: ok(Form, "Criado") },
      }),
      async (c) => {
        const { fields, ...b } = c.req.valid("json");
        const valid = parseFields(fields);
        const { tenantId } = c.var.tenant;
        try {
          const form = await c.var.tenant.tx(async (tx) => {
            const [row] = await tx
              .insert(s.briefingForms)
              .values({
                tenantId,
                name: b.name,
                description: b.description ?? null,
                taskTypeId: b.taskTypeId ?? null,
                projectTypeId: b.projectTypeId ?? null,
                active: b.active ?? true,
              })
              .returning();
            await writeFields(tx, tenantId, row!.id, valid);
            await audit(c, tx, {
              entity: "briefing_form",
              entityId: row!.id,
              entityLabel: b.name,
              action: "create",
            });
            return (await load(tx, row!.id))[0]!;
          });
          return c.json(form, 201);
        } catch (e) {
          throw refError(e);
        }
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/briefing-forms/{id}",
        tags,
        summary: "Salvar formulário (substitui os campos)",
        request: {
          params: IdParam,
          body: { content: { "application/json": { schema: FormBody } }, required: true },
        },
        responses: { 200: ok(Form) },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const { fields, ...b } = c.req.valid("json");
        const valid = parseFields(fields);
        try {
          const form = await c.var.tenant.tx(async (tx) => {
            const [before] = await load(tx, id);
            if (!before) throw notFound();
            await tx
              .update(s.briefingForms)
              .set({
                name: b.name,
                description: b.description ?? null,
                taskTypeId: b.taskTypeId ?? null,
                projectTypeId: b.projectTypeId ?? null,
                active: b.active ?? before.active,
                updatedAt: new Date(),
              })
              .where(eq(s.briefingForms.id, id));
            await writeFields(tx, c.var.tenant.tenantId, id, valid);
            await audit(c, tx, {
              entity: "briefing_form",
              entityId: id,
              entityLabel: b.name,
              action: "update",
              details: { from: before.fieldCount, to: valid.length, field: "fields" },
            });
            return (await load(tx, id))[0]!;
          });
          return c.json(form, 200);
        } catch (e) {
          throw refError(e);
        }
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/briefing-forms/{id}/duplicate",
        tags,
        summary: "Duplicar formulário (cópia inativa)",
        request: { params: IdParam },
        responses: { 201: ok(Form, "Criado") },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const { tenantId } = c.var.tenant;
        const form = await c.var.tenant.tx(async (tx) => {
          const [src] = await load(tx, id);
          if (!src) throw notFound();
          const [row] = await tx
            .insert(s.briefingForms)
            .values({
              tenantId,
              name: `${src.name} (cópia)`,
              description: src.description,
              taskTypeId: src.taskTypeId,
              projectTypeId: src.projectTypeId,
              active: false,
            })
            .returning();
          await writeFields(tx, tenantId, row!.id, src.fields);
          await audit(c, tx, {
            entity: "briefing_form",
            entityId: row!.id,
            entityLabel: row!.name,
            action: "duplicate",
            details: { sourceId: id },
          });
          return (await load(tx, row!.id))[0]!;
        });
        return c.json(form, 201);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/briefing-forms/{id}",
        tags,
        summary: "Apagar formulário (as respostas já enviadas continuam)",
        request: { params: IdParam },
        responses: { 204: { description: "Apagado" } },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await c.var.tenant.tx(async (tx) => {
          const [f] = await tx
            .update(s.briefingForms)
            .set({ deletedAt: new Date(), active: false })
            .where(and(eq(s.briefingForms.id, id), isNull(s.briefingForms.deletedAt)))
            .returning({ name: s.briefingForms.name });
          if (!f) throw notFound();
          await audit(c, tx, {
            entity: "briefing_form",
            entityId: id,
            entityLabel: f.name,
            action: "delete",
          });
        });
        return c.body(null, 204);
      },
    );
};
