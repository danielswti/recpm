import { zodResolver } from "@hookform/resolvers/zod";
import { createWorkspaceSchema, slugify } from "@recpm/shared";
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Building2, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { AuthLayout, Notice } from "../components/auth-layout";
import { api, unwrap } from "../lib/api";
import { authClient, ba } from "../lib/auth-client";
import { errorMessage } from "../lib/errors";
import { fieldError, invalid } from "../lib/forms";
import { requireUser } from "../lib/guards";

/** Escolha do workspace ativo (e criação de um novo). */
export const Route = createFileRoute("/workspaces")({
  beforeLoad: ({ context, location }) => requireUser(context.queryClient, location.href),
  component: Workspaces,
});

function Workspaces() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["workspaces"], queryFn: () => ba(authClient.organization.list()) });

  const select = useMutation({
    mutationFn: (organizationId: string) => ba(authClient.organization.setActive({ organizationId })),
    onSuccess: async () => {
      await qc.invalidateQueries();
      await navigate({ to: "/" });
    },
  });

  return (
    <AuthLayout title={t("workspaces.title")} description={t("workspaces.subtitle")}>
      <div className="grid gap-3">
        {select.error ? <Notice tone="error">{errorMessage(t, select.error)}</Notice> : null}
        {list.isPending ? (
          <>
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </>
        ) : !list.data?.length ? (
          <EmptyState icon={<Building2 />} title={t("workspaces.empty")} />
        ) : (
          list.data.map((w) => (
            <Card key={w.id} className="p-0">
              <button
                type="button"
                onClick={() => select.mutate(w.id)}
                disabled={select.isPending}
                className="flex w-full items-center gap-3 rounded-xl p-4 text-left hover:bg-accent"
              >
                <Building2 className="size-5 text-muted-foreground" />
                <span className="grid flex-1">
                  <span className="font-medium">{w.name}</span>
                  <span className="text-xs text-muted-foreground">{w.slug}</span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            </Card>
          ))
        )}
        <CreateWorkspaceDialog />
      </div>
    </AuthLayout>
  );
}

function CreateWorkspaceDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const form = useForm({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: { name: "", slug: "" },
  });
  const e = form.formState.errors;
  const create = useMutation({
    mutationFn: (v: { name: string; slug: string }) => unwrap(api.workspaces.$post({ json: v })),
    onSuccess: async () => {
      await qc.invalidateQueries();
      await navigate({ to: "/" });
    },
  });
  const nameField = form.register("name");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus /> {t("workspaces.create")}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t("workspaces.createTitle")}</DialogTitle>
          <DialogDescription>{t("workspaces.createDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4" noValidate>
          {create.error ? <Notice tone="error">{errorMessage(t, create.error)}</Notice> : null}
          <Field id="ws-name" label={t("signup.workspaceName")} error={e.name && t("validation.required")}>
            <Input
              id="ws-name"
              {...invalid("ws-name", e.name)}
              {...nameField}
              onChange={(ev) => {
                void nameField.onChange(ev);
                if (!slugTouched) form.setValue("slug", slugify(ev.target.value));
              }}
            />
          </Field>
          <Field
            id="ws-slug"
            label={t("signup.workspaceSlug")}
            error={fieldError(t, e.slug)}
            hint={t("signup.slugHint")}
          >
            <Input
              id="ws-slug"
              autoCapitalize="none"
              spellCheck={false}
              {...invalid("ws-slug", e.slug)}
              {...form.register("slug", { onChange: () => setSlugTouched(true) })}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {t("workspaces.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
