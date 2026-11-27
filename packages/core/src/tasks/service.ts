/**
 * Regras de tarefa compartilhadas pela API e pelo worker (§6.3): criação (com cota do plano),
 * movimentação no Kanban com as regras do fluxo, histórico e notificações.
 * Tudo roda dentro da transação do tenant (RLS), recebida de quem chama.
 */
import { type AppDb, type AppTx, schema, withTenant } from "@recpm/db";

type PlatformDb = AppDb;

import type { AdjustmentInput, Permission, RecurrenceRuleInput } from "@recpm/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { consumeTaskQuota, type QuotaResult } from "../billing/quota";
import { DomainError } from "../errors";
import { stopTaskTimers } from "../time/service";
import { rankBetween } from "./rank";
import { nextOccurrence } from "./recurrence";

const s = schema;

export type Actor = {
  tenantId: string;
  /** null = sistema (worker). */
  userId: string | null;
  name?: string | null;
  role?: string | null;
  impersonatorId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  can: (p: Permission) => boolean;
};

export const systemActor = (tenantId: string): Actor => ({
  tenantId,
  userId: null,
  name: "Sistema",
  can: () => true,
});

export async function audit(
  tx: AppTx,
  actor: Actor,
  e: {
    entity: string;
    entityId?: string | null;
    entityLabel?: string | null;
    action: string;
    details?: Record<string, unknown>;
  },
) {
  await tx.insert(s.auditLogs).values({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    actorName: actor.name ?? null,
    actorRole: actor.role ?? null,
    impersonatorId: actor.impersonatorId ?? null,
    entity: e.entity,
    entityId: e.entityId ?? null,
    entityLabel: e.entityLabel ?? null,
    action: e.action,
    details: (e.details ?? null) as never,
    ip: actor.ip ?? null,
    requestId: actor.requestId ?? null,
  });
}

export async function notify(
  tx: AppTx,
  tenantId: string,
  userIds: (string | null | undefined)[],
  n: { type: string; title: string; message?: string; referenceType?: string; referenceId?: string },
  except?: string | null,
) {
  const ids = [...new Set(userIds.filter((u): u is string => !!u && u !== except))];
  if (!ids.length) return;
  await tx.insert(s.notifications).values(
    ids.map((userId) => ({
      tenantId,
      userId,
      type: n.type,
      title: n.title,
      message: n.message ?? null,
      referenceType: n.referenceType ?? null,
      referenceId: n.referenceId ?? null,
    })),
  );
}

/** Colunas ativas na ordem do fluxo. */
export const activeColumns = (tx: AppTx) =>
  tx
    .select()
    .from(s.kanbanColumns)
    .where(eq(s.kanbanColumns.active, true))
    .orderBy(asc(s.kanbanColumns.position));

/** Último rank de uma coluna (no projeto, ou entre as avulsas). Ordem binária, como a das chaves. */
async function lastRank(tx: AppTx, projectId: string | null, statusKey: string) {
  const [r] = await tx
    .select({ rank: s.tasks.rank })
    .from(s.tasks)
    .where(
      and(
        eq(s.tasks.statusKey, statusKey),
        projectId ? eq(s.tasks.projectId, projectId) : isNull(s.tasks.projectId),
        isNull(s.tasks.deletedAt),
      ),
    )
    .orderBy(sql`${s.tasks.rank} COLLATE "C" DESC`)
    .limit(1);
  return r?.rank ?? null;
}

/** Projeto visível para o ator? Funcionário só vê projetos dos quais é membro. */
export async function assertProjectAccess(tx: AppTx, actor: Actor, projectId: string) {
  const [p] = await tx
    .select({ id: s.projects.id, archived: s.projects.archived })
    .from(s.projects)
    .where(and(eq(s.projects.id, projectId), isNull(s.projects.deletedAt)));
  if (!p) throw new DomainError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
  if (!actor.can("projects.readAll") && actor.userId) {
    const [m] = await tx
      .select({ u: s.projectMembers.userId })
      .from(s.projectMembers)
      .where(and(eq(s.projectMembers.projectId, projectId), eq(s.projectMembers.userId, actor.userId)));
    if (!m) throw new DomainError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
  }
  return p;
}

export type NewTask = {
  title: string;
  projectId?: string | null;
  phaseId?: string | null;
  description?: { type: "doc"; content?: unknown[] } | null;
  descriptionText?: string | null;
  statusKey?: string;
  assigneeId?: string | null;
  mainRoleId?: string | null;
  taskTypeId?: string | null;
  approverId?: string | null;
  assignees?: { userId: string; roleId?: string | null }[];
  tagIds?: string[];
  driveLink?: string | null;
  deadline?: string | Date | null;
  deadlineHasTime?: boolean;
  clientDeliveryDate?: string | null;
  priority?: "baixa" | "media" | "alta";
  visibleToClient?: boolean;
  estimatedHours?: number | null;
  pieceQuantity?: number;
  recurrence?: "diaria" | "semanal" | "mensal" | null;
  recurrenceRule?: RecurrenceRuleInput | null;
  recurrenceParentId?: string | null;
  checklist?: string[];
  /** Não avisar os envolvidos (duplicação em lote). */
  silent?: boolean;
  /** Pular a checagem de acesso ao projeto (quem chama já checou). */
  trusted?: boolean;
  source?: "ui" | "recurrence" | "duplicate" | "api" | "portal" | "portal_demand" | "import";
};

export async function tenantTimezone(tx: AppTx) {
  const [t] = await tx.select({ tz: s.tenants.timezone }).from(s.tenants);
  return t?.tz ?? "America/Sao_Paulo";
}

/**
 * Cria uma tarefa consumindo 1 da cota do ciclo (402 se esgotada). Aplica o tipo de tarefa
 * (horas estimadas e checklist padrão), garante o responsável entre os envolvidos e
 * agenda a próxima geração se for recorrente.
 */
export async function createTask(
  tx: AppTx,
  actor: Actor,
  input: NewTask,
): Promise<{ id: string; quota: QuotaResult }> {
  if (input.projectId && !input.trusted) await assertProjectAccess(tx, actor, input.projectId);
  if (!!input.recurrence !== !!input.recurrenceRule)
    throw new DomainError(400, "RECURRENCE_RULE_REQUIRED", "Recorrência precisa de regra.");

  const cols = await activeColumns(tx);
  // Sem coluna: "A fazer" (a coluna "Demandas" é a entrada do portal do cliente).
  const col = input.statusKey
    ? cols.find((c) => c.key === input.statusKey)
    : (cols.find((c) => c.key === "a_fazer") ?? cols.find((c) => c.key !== "demandas") ?? cols[0]);
  if (!col) throw new DomainError(400, "INVALID_STATUS", "Coluna inválida.");

  let estimatedHours = input.estimatedHours ?? null;
  let checklist = input.checklist;
  if (input.taskTypeId) {
    const [type] = await tx.select().from(s.taskTypes).where(eq(s.taskTypes.id, input.taskTypeId));
    if (!type) throw new DomainError(400, "INVALID_REFERENCE", "Tipo de tarefa inválido.");
    if (input.estimatedHours === undefined) estimatedHours = type.defaultEstimatedHours;
    if (!checklist) {
      const items = await tx
        .select({ text: s.taskTypeChecklistItems.text })
        .from(s.taskTypeChecklistItems)
        .where(eq(s.taskTypeChecklistItems.taskTypeId, type.id))
        .orderBy(asc(s.taskTypeChecklistItems.position));
      checklist = items.map((i) => i.text);
    }
  }

  const quota = await consumeTaskQuota(tx);
  const now = new Date();
  const deadline = input.deadline ? new Date(input.deadline) : null;
  const tz = input.recurrence ? await tenantTimezone(tx) : null;
  const nextGenerationAt =
    input.recurrence && input.recurrenceRule && tz
      ? nextOccurrence(input.recurrence, input.recurrenceRule, now, tz, now)
      : null;

  const [task] = await tx
    .insert(s.tasks)
    .values({
      tenantId: actor.tenantId,
      projectId: input.projectId ?? null,
      phaseId: input.phaseId ?? null,
      title: input.title,
      description: input.description ?? null,
      descriptionText: input.descriptionText ?? null,
      statusKey: col.key,
      rank: rankBetween(await lastRank(tx, input.projectId ?? null, col.key), null),
      assigneeId: input.assigneeId ?? null,
      mainRoleId: input.mainRoleId ?? null,
      taskTypeId: input.taskTypeId ?? null,
      approverId: input.approverId ?? null,
      createdById: actor.userId,
      source: input.source ?? "ui",
      driveLink: input.driveLink || null,
      deadline,
      originalDeadline: deadline,
      deadlineHasTime: input.deadlineHasTime ?? false,
      clientDeliveryDate: input.clientDeliveryDate ?? null,
      completedAt: col.isFinal ? now : null,
      priority: input.priority ?? "media",
      visibleToClient: input.visibleToClient ?? false,
      estimatedHours,
      pieceQuantity: input.pieceQuantity ?? 1,
      recurrence: input.recurrence ?? null,
      recurrenceRule: input.recurrenceRule ?? null,
      recurrenceParentId: input.recurrenceParentId ?? null,
      nextGenerationAt,
    })
    .returning({ id: s.tasks.id });
  const id = task!.id;

  const people = new Map<string, string | null>();
  for (const a of input.assignees ?? []) people.set(a.userId, a.roleId ?? null);
  if (input.assigneeId && !people.has(input.assigneeId))
    people.set(input.assigneeId, input.mainRoleId ?? null);
  if (people.size)
    await tx
      .insert(s.taskAssignees)
      .values(
        [...people].map(([userId, roleId]) => ({ tenantId: actor.tenantId, taskId: id, userId, roleId })),
      );
  if (input.tagIds?.length)
    await tx
      .insert(s.taskTags)
      .values([...new Set(input.tagIds)].map((tagId) => ({ tenantId: actor.tenantId, taskId: id, tagId })));
  if (checklist?.length)
    await tx
      .insert(s.taskSubitems)
      .values(checklist.map((text, position) => ({ tenantId: actor.tenantId, taskId: id, text, position })));

  await audit(tx, actor, {
    entity: "task",
    entityId: id,
    entityLabel: input.title,
    action: "create",
    details: { to: col.key, toLabel: col.label, source: input.source ?? "ui" },
  });
  if (!input.silent)
    await notify(
      tx,
      actor.tenantId,
      [...people.keys()],
      {
        type: "tarefa_atribuida",
        title: `Nova tarefa: ${input.title}`,
        referenceType: "task",
        referenceId: id,
      },
      actor.userId,
    );
  return { id, quota };
}

export type TaskRow = typeof s.tasks.$inferSelect;

export async function loadTask(tx: AppTx, id: string): Promise<TaskRow> {
  const [t] = await tx
    .select()
    .from(s.tasks)
    .where(and(eq(s.tasks.id, id), isNull(s.tasks.deletedAt)));
  if (!t) throw new DomainError(404, "TASK_NOT_FOUND", "Tarefa não encontrada.");
  return t;
}

/** Envolvido = responsável, participante, criador ou aprovador. */
export async function isInvolved(tx: AppTx, t: TaskRow, userId: string | null) {
  if (!userId) return false;
  if ([t.assigneeId, t.createdById, t.approverId].includes(userId)) return true;
  const [a] = await tx
    .select({ u: s.taskAssignees.userId })
    .from(s.taskAssignees)
    .where(and(eq(s.taskAssignees.taskId, t.id), eq(s.taskAssignees.userId, userId)));
  return !!a;
}

/** Ver a tarefa: quem vê todas, envolvidos, ou membros do projeto. */
export async function assertCanSee(tx: AppTx, actor: Actor, t: TaskRow) {
  if (actor.can("tasks.readAll")) return;
  if (await isInvolved(tx, t, actor.userId)) return;
  if (t.projectId && actor.userId) {
    const [m] = await tx
      .select({ u: s.projectMembers.userId })
      .from(s.projectMembers)
      .where(and(eq(s.projectMembers.projectId, t.projectId), eq(s.projectMembers.userId, actor.userId)));
    if (m) return;
  }
  throw new DomainError(404, "TASK_NOT_FOUND", "Tarefa não encontrada.");
}

/** Editar/mover: gestores (tasks.manage) ou quem está envolvido. */
export async function assertCanEdit(tx: AppTx, actor: Actor, t: TaskRow) {
  if (actor.can("tasks.manage")) return;
  if (await isInvolved(tx, t, actor.userId)) return;
  await assertCanSee(tx, actor, t);
  throw new DomainError(403, "FORBIDDEN", "Só quem participa da tarefa pode alterá-la.");
}

const canApprove = (actor: Actor, t: TaskRow) =>
  actor.can("tasks.approve") || (!!actor.userId && t.approverId === actor.userId);

export type Move = {
  statusKey: string;
  afterId?: string | null;
  beforeId?: string | null;
  adjustment?: AdjustmentInput;
};

/**
 * Move o card aplicando as regras do fluxo:
 * - sair de uma coluna de aprovação exige poder aprovar (aprovador da tarefa ou tasks.approve);
 * - entrar em `ajustes` exige motivo (vindo de `aguardando_cliente`, o ajuste é do cliente);
 * - sair de `ajustes` resolve os ajustes abertos;
 * - entrar numa coluna de aprovação avisa o aprovador (ou o atendimento do projeto, ou os gestores);
 * - a coluna final marca `completedAt`; sair dela limpa;
 * - mudar de coluna atualiza `statusSince` e grava o histórico.
 */
export async function moveTask(
  tx: AppTx,
  actor: Actor,
  id: string,
  move: Move,
  opts: { skipEditCheck?: boolean } = {},
) {
  const t = await loadTask(tx, id);
  if (t.archived) throw new DomainError(409, "TASK_ARCHIVED", "Tarefa arquivada.");
  if (!opts.skipEditCheck) await assertCanEdit(tx, actor, t);
  const cols = await activeColumns(tx);
  const from = (await tx.select().from(s.kanbanColumns).where(eq(s.kanbanColumns.key, t.statusKey)))[0];
  const to = cols.find((c) => c.key === move.statusKey);
  if (!to) throw new DomainError(400, "INVALID_STATUS", "Coluna inválida.");
  const changed = to.key !== t.statusKey;
  const now = new Date();

  if (changed && from?.isApproval && !canApprove(actor, t))
    throw new DomainError(403, "APPROVAL_REQUIRED", "Só o aprovador pode tirar a tarefa da aprovação.");

  if (changed && to.key === "ajustes") {
    if (!move.adjustment)
      throw new DomainError(400, "ADJUSTMENT_REASON_REQUIRED", "Informe o motivo do ajuste.");
    const [reason] = await tx
      .select({ id: s.adjustmentReasons.id })
      .from(s.adjustmentReasons)
      .where(and(eq(s.adjustmentReasons.id, move.adjustment.reasonId), eq(s.adjustmentReasons.active, true)));
    if (!reason) throw new DomainError(400, "INVALID_REFERENCE", "Motivo de ajuste inválido.");
    const kind = t.statusKey === "aguardando_cliente" ? "client" : move.adjustment.kind;
    await tx.insert(s.taskAdjustments).values({
      tenantId: actor.tenantId,
      taskId: t.id,
      reasonId: reason.id,
      kind,
      description: move.adjustment.description ?? null,
      createdBy: actor.userId,
      responsibleId: t.assigneeId,
    });
  }
  if (changed && t.statusKey === "ajustes")
    await tx
      .update(s.taskAdjustments)
      .set({ resolvedAt: now, resolvedBy: actor.userId })
      .where(and(eq(s.taskAdjustments.taskId, t.id), isNull(s.taskAdjustments.resolvedAt)));

  // Ordem: entre o card de cima (afterId) e o de baixo (beforeId), ou no fim da coluna.
  const neighbor = async (nid?: string | null) => {
    if (!nid) return null;
    const [n] = await tx
      .select({ rank: s.tasks.rank, statusKey: s.tasks.statusKey })
      .from(s.tasks)
      .where(eq(s.tasks.id, nid));
    return n && n.statusKey === to.key ? n.rank : null;
  };
  let above = await neighbor(move.afterId);
  let below = await neighbor(move.beforeId);
  if (!above && !below) above = await lastRank(tx, t.projectId, to.key);
  if (above && below && above >= below) below = null;
  if (above === t.rank || below === t.rank) {
    // vizinho é o próprio card: nada a reordenar
    above = above === t.rank ? null : above;
    below = below === t.rank ? null : below;
  }
  const rank = rankBetween(above, below);

  await tx
    .update(s.tasks)
    .set({
      statusKey: to.key,
      rank,
      ...(changed
        ? { statusSince: now, completedAt: to.isFinal ? now : null, chaseSlaNotifiedAt: null }
        : {}),
      updatedAt: now,
    })
    .where(eq(s.tasks.id, t.id));

  // Concluir para os timers ("Estou nessa") da tarefa.
  if (changed && to.isFinal) await stopTaskTimers(tx, t.id, now);

  if (changed) {
    await audit(tx, actor, {
      entity: "task",
      entityId: t.id,
      entityLabel: t.title,
      action: "status_change",
      details: {
        from: t.statusKey,
        to: to.key,
        fromLabel: from?.label ?? t.statusKey,
        toLabel: to.label,
        ...(move.adjustment && to.key === "ajustes" ? { adjustment: move.adjustment } : {}),
      },
    });
    if (to.isApproval) {
      let targets: string[] = t.approverId ? [t.approverId] : [];
      if (!targets.length && t.projectId) {
        const [p] = await tx
          .select({ m: s.projects.managerId })
          .from(s.projects)
          .where(eq(s.projects.id, t.projectId));
        if (p?.m) targets = [p.m];
      }
      if (!targets.length)
        targets = (
          await tx
            .select({ u: s.memberships.userId })
            .from(s.memberships)
            .where(and(inArray(s.memberships.role, ["admin", "gestor"]), eq(s.memberships.active, true)))
        ).map((r) => r.u);
      await notify(
        tx,
        actor.tenantId,
        targets,
        {
          type: "tarefa_aprovacao_pendente",
          title: `Aprovação pendente: ${t.title}`,
          referenceType: "task",
          referenceId: t.id,
        },
        actor.userId,
      );
    }
    if (to.key === "ajustes")
      await notify(
        tx,
        actor.tenantId,
        [t.assigneeId],
        {
          type: "tarefa_ajuste",
          title: `Ajuste pedido: ${t.title}`,
          referenceType: "task",
          referenceId: t.id,
        },
        actor.userId,
      );
  }
  return { from: t.statusKey, to: to.key };
}

/** Aprovar: da coluna de aprovação para a próxima coluna ativa do fluxo. */
export async function approveTask(tx: AppTx, actor: Actor, id: string) {
  const t = await loadTask(tx, id);
  const cols = await activeColumns(tx);
  const i = cols.findIndex((c) => c.key === t.statusKey);
  if (i < 0 || !cols[i]!.isApproval)
    throw new DomainError(409, "NOT_IN_APPROVAL", "A tarefa não está em aprovação.");
  if (!canApprove(actor, t)) throw new DomainError(403, "APPROVAL_REQUIRED", "Só o aprovador pode aprovar.");
  const next = cols[i + 1];
  if (!next) throw new DomainError(409, "NO_NEXT_COLUMN", "Não há coluna depois da aprovação.");
  return moveTask(tx, actor, id, { statusKey: next.key }, { skipEditCheck: true });
}

/** Reprovar: volta para `ajustes` com o motivo obrigatório. */
export async function rejectTask(tx: AppTx, actor: Actor, id: string, adjustment: AdjustmentInput) {
  const t = await loadTask(tx, id);
  const [col] = await tx.select().from(s.kanbanColumns).where(eq(s.kanbanColumns.key, t.statusKey));
  if (!col?.isApproval) throw new DomainError(409, "NOT_IN_APPROVAL", "A tarefa não está em aprovação.");
  if (!canApprove(actor, t)) throw new DomainError(403, "APPROVAL_REQUIRED", "Só o aprovador pode reprovar.");
  return moveTask(tx, actor, id, { statusKey: "ajustes", adjustment }, { skipEditCheck: true });
}

/**
 * Gera as instâncias vencidas das tarefas recorrentes de UM tenant (chamado pelo worker dentro do
 * withTenant). Cada instância consome cota; se a cota acabou, a geração fica para o próximo ciclo
 * (a série não avança) e devolve `blocked`.
 */
export async function generateRecurringTasks(tx: AppTx, tenantId: string, now = new Date()) {
  const actor = systemActor(tenantId);
  const due = await tx
    .select()
    .from(s.tasks)
    .where(
      and(
        sql`${s.tasks.recurrence} IS NOT NULL`,
        sql`${s.tasks.nextGenerationAt} <= ${now}`,
        isNull(s.tasks.deletedAt),
        eq(s.tasks.archived, false),
      ),
    )
    .orderBy(asc(s.tasks.nextGenerationAt))
    .limit(200);
  const tz = await tenantTimezone(tx);
  let created = 0;
  let blocked = 0;
  for (const p of due) {
    const runAt = p.nextGenerationAt!;
    try {
      await tx.transaction(async (sp) => {
        const assignees = await sp
          .select({ userId: s.taskAssignees.userId, roleId: s.taskAssignees.roleId })
          .from(s.taskAssignees)
          .where(eq(s.taskAssignees.taskId, p.id));
        const tagIds = (
          await sp.select({ id: s.taskTags.tagId }).from(s.taskTags).where(eq(s.taskTags.taskId, p.id))
        ).map((r) => r.id);
        const checklist = (
          await sp
            .select({ text: s.taskSubitems.text })
            .from(s.taskSubitems)
            .where(eq(s.taskSubitems.taskId, p.id))
            .orderBy(asc(s.taskSubitems.position))
        ).map((r) => r.text);
        const rule = p.recurrenceRule ?? { interval: 1 };
        const deadline =
          rule.deadlineOffsetDays !== undefined
            ? new Date(runAt.getTime() + rule.deadlineOffsetDays * 86_400_000)
            : null;
        await createTask(sp as AppTx, actor, {
          title: p.title,
          projectId: p.projectId,
          phaseId: p.phaseId,
          description: p.description,
          descriptionText: p.descriptionText,
          assigneeId: p.assigneeId,
          mainRoleId: p.mainRoleId,
          taskTypeId: p.taskTypeId,
          approverId: p.approverId,
          assignees,
          tagIds,
          driveLink: p.driveLink,
          deadline,
          deadlineHasTime: deadline ? p.deadlineHasTime : false,
          priority: p.priority,
          visibleToClient: p.visibleToClient,
          estimatedHours: p.estimatedHours,
          pieceQuantity: p.pieceQuantity,
          recurrenceParentId: p.id,
          trusted: true,
          checklist,
          source: "recurrence",
        });
        const next = nextOccurrence(p.recurrence!, rule, runAt, tz, p.createdAt);
        await sp.update(s.tasks).set({ nextGenerationAt: next }).where(eq(s.tasks.id, p.id));
      });
      created++;
    } catch (e) {
      if (e instanceof DomainError && e.code === "PLAN_TASK_LIMIT_REACHED") {
        blocked++;
        continue;
      }
      throw e;
    }
  }
  return { created, blocked };
}

/**
 * Job de recorrência (worker, a cada 5 min): acha os tenants com séries vencidas (conexão de
 * plataforma, sem RLS) e gera as instâncias de cada um dentro do contexto do tenant.
 */
export async function runRecurrence(
  dbs: { platformDb: PlatformDb; appDb: AppDb },
  now = new Date(),
): Promise<{ tenants: number; created: number; blocked: number }> {
  const due = await dbs.platformDb
    .selectDistinct({ tenantId: s.tasks.tenantId })
    .from(s.tasks)
    .where(
      and(
        sql`${s.tasks.recurrence} IS NOT NULL`,
        sql`${s.tasks.nextGenerationAt} <= ${now}`,
        isNull(s.tasks.deletedAt),
        eq(s.tasks.archived, false),
      ),
    );
  let created = 0;
  let blocked = 0;
  for (const { tenantId } of due) {
    const r = await withTenant(dbs.appDb, { tenantId, actor: "system" }, (tx) =>
      generateRecurringTasks(tx, tenantId, now),
    );
    created += r.created;
    blocked += r.blocked;
  }
  return { tenants: due.length, created, blocked };
}
