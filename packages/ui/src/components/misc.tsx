import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../cn";

export const Skeleton = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("animate-pulse rounded-md bg-muted", className)} {...p} />
);

const badgeVariants = cva("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "border-transparent bg-primary/15 text-primary",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      outline: "text-foreground",
      success: "border-transparent bg-success/15 text-success",
      destructive: "border-transparent bg-destructive/15 text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
});

export const Badge = ({
  className,
  variant,
  ...p
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) => (
  <span className={cn(badgeVariants({ variant }), className)} {...p} />
);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

export function Avatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  return (
    <AvatarPrimitive.Root
      className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full bg-muted", className)}
    >
      {src ? <AvatarPrimitive.Image src={src} alt="" className="aspect-square size-full" /> : null}
      <AvatarPrimitive.Fallback className="flex size-full items-center justify-center bg-primary/20 text-xs font-semibold text-primary">
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-10 text-center">
      {icon ? <div className="text-muted-foreground [&_svg]:size-8">{icon}</div> : null}
      <div className="grid gap-1">
        <p className="font-medium">{title}</p>
        {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
