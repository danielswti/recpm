/**
 * Agenda (§5 "Calendar", §6.4).
 * Aniversários vêm de memberships.birthday e marcos de projeto vêm de projects/project_milestones:
 * ambos são eventos VIRTUAIS montados na consulta, não linhas aqui.
 * Datas que caem em fim de semana são deslocadas na apresentação (marcadas com ↻).
 */
import { sql } from "drizzle-orm";
import { boolean, date, index, pgTable, text, time, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pk, tfk, timestamps } from "./_columns";
import { users } from "./auth";
import { calendarEventSource, calendarEventType } from "./enums";
import { projects } from "./projects";
import { tenantId } from "./tenants";

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: pk(),
    tenantId: tenantId(),
    title: text().notNull(),
    description: text(),
    date: date().notNull(),
    /** NULL = dia inteiro. */
    time: time(),
    type: calendarEventType().notNull().default("outro"),
    yearlyRecurring: boolean().notNull().default(false),
    source: calendarEventSource().notNull().default("interno"),
    /** Para feriados importados: chave estável (ex.: "BR-2027-04-21") para não duplicar. */
    externalRef: text(),
    /** Conta como dia não útil no cálculo de horas úteis. */
    isDayOff: boolean().notNull().default(false),
    projectId: uuid(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    tfk("calendar_events_project_fk", t, t.projectId, projects).onDelete("cascade"),
    index("calendar_events_date_idx").on(t.tenantId, t.date),
    uniqueIndex("calendar_events_external_uq")
      .on(t.tenantId, t.externalRef)
      .where(sql`${t.externalRef} IS NOT NULL`),
  ],
);

/** Cache GLOBAL da BrasilAPI (1 busca por ano). Cada tenant importa o que escolher. */
export const publicHolidays = pgTable(
  "public_holidays",
  {
    id: pk(),
    date: date().notNull(),
    name: text().notNull(),
    /** 'national' | 'state' | … conforme a fonte. */
    scope: text().notNull().default("national"),
    /** UF quando scope = 'state'. */
    region: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex("public_holidays_uq").on(t.date, t.name, t.scope, sql`coalesce(${t.region}, '')`)],
);
