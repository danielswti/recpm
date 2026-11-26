import type { ComponentProps } from "react";
import { cn } from "../cn";

export const Card = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("rounded-xl border bg-card text-card-foreground shadow-xs", className)} {...p} />
);
export const CardHeader = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("grid gap-1.5 p-6", className)} {...p} />
);
export const CardTitle = ({ className, ...p }: ComponentProps<"h2">) => (
  <h2 className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...p} />
);
export const CardDescription = ({ className, ...p }: ComponentProps<"p">) => (
  <p className={cn("text-sm text-muted-foreground", className)} {...p} />
);
export const CardContent = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("p-6 pt-0", className)} {...p} />
);
export const CardFooter = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("flex items-center p-6 pt-0", className)} {...p} />
);
