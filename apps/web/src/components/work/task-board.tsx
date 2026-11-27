/**
 * Kanban de tarefas (@dnd-kit): arrastar entre colunas e reordenar. A ordem vai para a API como
 * vizinhos (afterId/beforeId) e vira uma chave fracionária: reordenar = 1 UPDATE.
 * Ir para "Ajustes" pede o motivo antes de mover. Erro do fluxo (ex.: só o aprovador tira da
 * aprovação) desfaz o movimento e mostra a mensagem.
 */

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AdjustmentInput } from "@recpm/shared";
import { cn } from "@recpm/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { BoardColumn, TaskItem } from "../../lib/work";
import { AdjustmentDialog } from "./adjustment-dialog";
import { TaskCard } from "./task-card";

type Lanes = Record<string, string[]>;

const lanesOf = (columns: BoardColumn[], tasks: TaskItem[]): Lanes => {
  const out: Lanes = Object.fromEntries(columns.map((c) => [c.key, [] as string[]]));
  for (const t of tasks) out[t.statusKey]?.push(t.id);
  return out;
};

export function TaskBoard({
  columns,
  tasks,
  showProject = true,
  onOpen,
}: {
  columns: BoardColumn[];
  tasks: TaskItem[];
  showProject?: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const byId = useMemo(() => new Map(tasks.map((x) => [x.id, x])), [tasks]);
  const [lanes, setLanes] = useState<Lanes>(() => lanesOf(columns, tasks));
  const [activeId, setActiveId] = useState<string | null>(null);
  const origin = useRef<string | null>(null);
  const [pendingAdjust, setPendingAdjust] = useState<{
    id: string;
    from: string;
    afterId: string | null;
    beforeId: string | null;
  } | null>(null);

  // Sincroniza com o servidor quando não há arrasto em andamento.
  useEffect(() => {
    if (!activeId && !pendingAdjust) setLanes(lanesOf(columns, tasks));
  }, [columns, tasks, activeId, pendingAdjust]);

  const move = useMutation({
    mutationFn: (v: {
      id: string;
      statusKey: string;
      afterId: string | null;
      beforeId: string | null;
      adjustment?: AdjustmentInput;
    }) =>
      unwrap(
        api.tasks[":id"].move.$post({
          param: { id: v.id },
          json: {
            statusKey: v.statusKey,
            afterId: v.afterId,
            beforeId: v.beforeId,
            adjustment: v.adjustment,
          },
        }),
      ),
    onError: (e) => {
      toast.error(errorMessage(t, e));
      setLanes(lanesOf(columns, tasks));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const laneOf = (id: string) => (id in lanes ? id : Object.keys(lanes).find((k) => lanes[k]!.includes(id)));

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    origin.current = laneOf(id) ?? null;
  };

  const onDragOver = (e: DragOverEvent) => {
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over) return;
    const from = laneOf(id);
    const to = laneOf(over);
    if (!from || !to || from === to) return;
    setLanes((l) => {
      const src = l[from]!.filter((x) => x !== id);
      const dst = [...l[to]!];
      const idx = over in l ? dst.length : Math.max(0, dst.indexOf(over));
      dst.splice(idx, 0, id);
      return { ...l, [from]: src, [to]: dst };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    setActiveId(null);
    const from = origin.current;
    origin.current = null;
    if (!over || !from) {
      setLanes(lanesOf(columns, tasks));
      return;
    }
    const to = laneOf(id)!;
    let list = lanes[to]!;
    // reordenação dentro da mesma coluna
    if (over !== id && !(over in lanes) && laneOf(over) === to) {
      const a = list.indexOf(id);
      const b = list.indexOf(over);
      if (a !== b) {
        list = [...list];
        list.splice(a, 1);
        list.splice(b, 0, id);
        setLanes((l) => ({ ...l, [to]: list }));
      }
    }
    const i = list.indexOf(id);
    const afterId = list[i - 1] ?? null;
    const beforeId = list[i + 1] ?? null;
    const task = byId.get(id);
    const original = lanesOf(columns, tasks)[from]!;
    const unchanged = from === to && original.indexOf(id) === i;
    if (unchanged) return;
    if (to === "ajustes" && from !== "ajustes") {
      setPendingAdjust({ id, from, afterId, beforeId });
      return;
    }
    if (task) move.mutate({ id, statusKey: to, afterId, beforeId });
  };

  const active = activeId ? byId.get(activeId) : null;
  const visible = columns.filter((c) => c.visible !== false);

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        // rolagem automática só bem perto da borda (o quadro tem muitas colunas)
        autoScroll={{ threshold: { x: 0.08, y: 0.15 }, acceleration: 6 }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          setLanes(lanesOf(columns, tasks));
        }}
      >
        <section className="relative flex gap-3 overflow-x-auto pb-4" aria-label={t("tasks.board")}>
          {visible.map((col) => (
            <Lane key={col.key} col={col} ids={lanes[col.key] ?? []}>
              {(lanes[col.key] ?? []).map((id) => {
                const task = byId.get(id);
                return task ? (
                  <SortableCard key={id} task={task} showProject={showProject} onOpen={onOpen} />
                ) : null;
              })}
            </Lane>
          ))}
        </section>
        <DragOverlay>
          {active ? <TaskCard task={active} showProject={showProject} dragging /> : null}
        </DragOverlay>
      </DndContext>
      <AdjustmentDialog
        open={!!pendingAdjust}
        title={t("tasks.adjustment.title")}
        forceClient={pendingAdjust?.from === "aguardando_cliente"}
        pending={move.isPending}
        onClose={() => {
          setPendingAdjust(null);
          setLanes(lanesOf(columns, tasks));
        }}
        onConfirm={(adjustment) => {
          const p = pendingAdjust!;
          move.mutate(
            { id: p.id, statusKey: "ajustes", afterId: p.afterId, beforeId: p.beforeId, adjustment },
            { onSettled: () => setPendingAdjust(null) },
          );
        }}
      />
    </>
  );
}

function Lane({ col, ids, children }: { col: BoardColumn; ids: string[]; children: React.ReactNode }) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: col.key });
  return (
    <section
      aria-label={col.label}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl border bg-muted/40",
        isOver && "border-primary/60 bg-primary/5",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className="size-2.5 rounded-full" style={{ background: col.color ?? "#94a3b8" }} aria-hidden />
        <h3 className="truncate text-sm font-semibold">
          {col.emoji ? `${col.emoji} ` : ""}
          {col.label}
        </h3>
        {col.isApproval && (
          <span className="rounded bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
            {t("tasks.approval")}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{ids.length}</span>
      </header>
      <SortableContext id={col.key} items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">
          {children}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableCard({
  task,
  showProject,
  onOpen,
}: {
  task: TaskItem;
  showProject: boolean;
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: os attributes do useSortable dão role e tabIndex; pelo teclado, o título do card é um botão
    // biome-ignore lint/a11y/useKeyWithClickEvents: Enter/Espaço iniciam o arrasto pelo teclado; abrir fica no botão do título
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("cursor-grab touch-none active:cursor-grabbing", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
      // clique (sem arrastar) em qualquer ponto do card abre a gaveta
      onClick={() => onOpen(task.id)}
    >
      <TaskCard task={task} showProject={showProject} onOpen={onOpen} />
    </div>
  );
}
