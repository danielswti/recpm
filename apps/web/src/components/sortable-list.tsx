import { cn } from "@recpm/ui";
import { GripVertical } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Lista reordenável: arrastar pela alça (mouse ou toque, via pointer events) ou, com a alça em
 * foco, setas ↑/↓ do teclado. `onReorder` recebe os ids na nova ordem só quando a ordem muda.
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
  itemLabel,
  disabled,
  className,
}: {
  items: T[];
  onReorder: (ids: string[]) => void;
  renderItem: (item: T) => ReactNode;
  itemLabel: (item: T) => string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [order, setOrder] = useState(items);
  const [dragging, setDragging] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    if (!dragging) setOrder(items);
  }, [items, dragging]);

  const commit = (next: T[]) => {
    const ids = next.map((i) => i.id);
    if (ids.join() !== items.map((i) => i.id).join()) onReorder(ids);
  };

  const move = (from: number, to: number, list = order) => {
    if (to < 0 || to >= list.length || from === to) return list;
    const next = [...list];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it!);
    return next;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(id);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLLIElement>(":scope > li")];
    const target = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY <= b.bottom;
    });
    const from = order.findIndex((i) => i.id === dragging);
    if (target >= 0 && target !== from) setOrder((o) => move(from, target, o));
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(null);
    commit(order);
  };
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (disabled || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const to = e.key === "ArrowUp" ? index - 1 : index + 1;
    const next = move(index, to);
    if (next === order) return;
    setOrder(next);
    commit(next);
    setAnnounce(
      t("sortable.moved", { name: itemLabel(order[index]!), position: to + 1, total: order.length }),
    );
    requestAnimationFrame(() =>
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-handle]")[to]?.focus(),
    );
  };

  return (
    <>
      <ul ref={listRef} className={cn("divide-y", className)}>
        {order.map((item, i) => (
          <li
            key={item.id}
            className={cn(
              "flex items-center gap-2 bg-card px-2 py-2",
              dragging === item.id && "relative z-10 shadow-md ring-1 ring-primary/40",
            )}
          >
            <button
              type="button"
              data-handle
              disabled={disabled}
              aria-label={t("sortable.handle", { name: itemLabel(item) })}
              className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
              onPointerDown={(e) => onPointerDown(e, item.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <GripVertical className="size-4" />
            </button>
            <div className="min-w-0 flex-1">{renderItem(item)}</div>
          </li>
        ))}
      </ul>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </>
  );
}
