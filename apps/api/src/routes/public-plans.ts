/**
 * Planos públicos para o site e a página de preços (sem login). Os planos ficam no banco e o
 * super_admin pode editá-los, então o site sempre mostra o que está valendo.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { schema } from "@recpm/db";
import { PLAN_FEATURES } from "@recpm/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { router } from "../lib/router";

const s = schema;
const PublicPlan = z
  .object({
    slug: z.string(),
    name: z.string(),
    priceMonthlyCents: z.number(),
    priceIsStartingAt: z.boolean(),
    currency: z.string(),
    trialDays: z.number(),
    limits: z.object({
      tasksPerCycle: z.number().nullable(),
      maxUsers: z.number().nullable(),
      storageGb: z.number(),
    }),
    features: z.object(
      Object.fromEntries(PLAN_FEATURES.map((f) => [f, z.boolean()])) as Record<
        (typeof PLAN_FEATURES)[number],
        z.ZodBoolean
      >,
    ),
  })
  .openapi("PublicPlan");

export const publicPlanRoutes = (deps: Deps) =>
  router().openapi(
    createRoute({
      method: "get",
      path: "/public/plans",
      tags: ["Planos"],
      summary: "Planos públicos e preços (sem login)",
      security: [],
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(PublicPlan) }) } },
        },
      },
    }),
    async (c) => {
      const rows = await deps.dbs.platformDb
        .select()
        .from(s.plans)
        .where(and(eq(s.plans.isPublic, true), eq(s.plans.active, true)))
        .orderBy(asc(s.plans.sortOrder));
      c.header("cache-control", "public, max-age=300");
      return c.json(
        {
          data: rows.map((p) => ({
            slug: p.slug,
            name: p.name,
            priceMonthlyCents: p.priceMonthlyCents,
            priceIsStartingAt: p.priceIsStartingAt,
            currency: p.currency,
            trialDays: p.trialDays,
            limits: {
              tasksPerCycle: p.limits.tasksPerCycle,
              maxUsers: p.limits.maxUsers,
              storageGb: p.limits.storageGb,
            },
            features: p.features,
          })),
        },
        200,
      );
    },
  );
