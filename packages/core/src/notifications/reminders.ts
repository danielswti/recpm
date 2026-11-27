/**
 * Avisos de prazo (§6.10): "vence nas próximas 24 h" e "venceu", uma vez por prazo.
 * Mudar o prazo limpa as marcas (rotas de tarefa), então o aviso volta a valer para o novo prazo.
 */
import { type AppDb, type AppTx, schema, withTenant } from "@recpm/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { notify } from "../tasks/service";

const s = schema;
const DAY = 86_400_000;

const open = and(
  isNull(s.tasks.completedAt),
  isNull(s.tasks.deletedAt),
  eq(s.tasks.archived, false),
  sql`${s.tasks.deadline} IS NOT NULL`,
);
const dueSoon = (now: Date) =>
  and(
    isNull(s.tasks.deadlineReminderAt),
    sql`${s.tasks.deadline} > ${now}`,
    sql`${s.tasks.deadline} <= ${new Date(now.getTime() + DAY)}`,
  );
const overdue = (now: Date) => and(isNull(s.tasks.overdueNotifiedAt), sql`${s.tasks.deadline} <= ${now}`);

export async function sendDeadlineReminders(tx: AppTx, tenantId: string, now = new Date()) {
  const rows = await tx
    .select({
      id: s.tasks.id,
      title: s.tasks.title,
      assigneeId: s.tasks.assigneeId,
      deadline: s.tasks.deadline,
      reminded: s.tasks.deadlineReminderAt,
      managerId: s.projects.managerId,
    })
    .from(s.tasks)
    .leftJoin(s.projects, eq(s.projects.id, s.tasks.projectId))
    .where(and(open, or(dueSoon(now), overdue(now))))
    .limit(500);
  if (!rows.length) return 0;
  const parts = await tx
    .select({ taskId: s.taskAssignees.taskId, userId: s.taskAssignees.userId })
    .from(s.taskAssignees)
    .where(
      inArray(
        s.taskAssignees.taskId,
        rows.map((r) => r.id),
      ),
    );
  let n = 0;
  for (const r of rows) {
    const people = [r.assigneeId, ...parts.filter((p) => p.taskId === r.id).map((p) => p.userId)];
    const late = r.deadline! <= now;
    if (late) {
      await notify(tx, tenantId, [...people, r.managerId], {
        type: "prazo_vencido",
        title: `Prazo vencido: ${r.title}`,
        referenceType: "task",
        referenceId: r.id,
      });
      // quem passou direto do "faltam 24 h" para o atraso não recebe os dois depois
      await tx
        .update(s.tasks)
        .set({ overdueNotifiedAt: now, deadlineReminderAt: r.reminded ?? now })
        .where(eq(s.tasks.id, r.id));
    } else {
      await notify(tx, tenantId, people, {
        type: "prazo_proximo",
        title: `Vence em menos de 24 h: ${r.title}`,
        referenceType: "task",
        referenceId: r.id,
      });
      await tx.update(s.tasks).set({ deadlineReminderAt: now }).where(eq(s.tasks.id, r.id));
    }
    n++;
  }
  return n;
}

/** Job do worker (a cada 15 min): tenants com prazos a avisar, cada um no próprio contexto. */
export async function runDeadlineReminders(dbs: { platformDb: AppDb; appDb: AppDb }, now = new Date()) {
  const due = await dbs.platformDb
    .selectDistinct({ tenantId: s.tasks.tenantId })
    .from(s.tasks)
    .where(and(open, or(dueSoon(now), overdue(now))));
  let notified = 0;
  for (const { tenantId } of due)
    notified += await withTenant(dbs.appDb, { tenantId, actor: "system" }, (tx) =>
      sendDeadlineReminders(tx, tenantId, now),
    );
  return { tenants: due.length, notified };
}
