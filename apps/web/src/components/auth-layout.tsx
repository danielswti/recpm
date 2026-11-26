import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@recpm/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

/** Moldura das telas públicas (login, cadastro, senha, convite). */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <Link to="/" className="flex items-center gap-2 text-lg font-semibold">
        <img src="/favicon.svg" alt="" className="size-8" />
        Rec PM
      </Link>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      {footer ? <div className="text-sm text-muted-foreground">{footer}</div> : null}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "success";
  children: ReactNode;
}) {
  const cls = {
    info: "border-primary/30 bg-primary/10",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
    success: "border-success/40 bg-success/10",
  }[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-sm ${cls}`}
    >
      {children}
    </div>
  );
}
