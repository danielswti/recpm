import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { useTheme } from "../lib/theme";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: NotFound,
});

function Root() {
  const theme = useTheme((s) => s.theme);
  return (
    <>
      <Outlet />
      <Toaster theme={theme} position="top-right" richColors closeButton />
    </>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-5xl font-bold text-muted-foreground">404</p>
      <Link to="/" className="text-primary underline-offset-4 hover:underline">
        {t("nav.dashboard")}
      </Link>
    </div>
  );
}
