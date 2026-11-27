/** Projetos e tarefas: consultas, tipos e utilidades compartilhadas pelas telas. */
import type { ProjectStatus } from "@recpm/shared";
import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "./api";

export type ProjectListFilters = {
  q?: string;
  status?: ProjectStatus;
  clientId?: string;
  managerId?: string;
  archived?: boolean;
};

const str = (o: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
      .map(([k, v]) => [k, String(v)]),
  );

export const projectsQuery = (f: ProjectListFilters = {}) =>
  queryOptions({
    queryKey: ["projects", "list", f],
    queryFn: () => unwrap(api.projects.$get({ query: { ...str(f), pageSize: "500" } as never })),
  });
export const projectQuery = (id: string) =>
  queryOptions({
    queryKey: ["projects", id],
    queryFn: () => unwrap(api.projects[":id"].$get({ param: { id } })),
  });
export const projectCommentsQuery = (id: string) =>
  queryOptions({
    queryKey: ["projects", id, "comments"],
    queryFn: () => unwrap(api.projects[":id"].comments.$get({ param: { id } })),
  });
export const projectFilesQuery = (id: string) =>
  queryOptions({
    queryKey: ["projects", id, "files"],
    queryFn: () => unwrap(api.projects[":id"].files.$get({ param: { id } })),
  });
export const projectColumnsQuery = (id: string) =>
  queryOptions({
    queryKey: ["projects", id, "columns"],
    queryFn: () => unwrap(api.projects[":id"].columns.$get({ param: { id } })),
  });

export type TaskListFilters = {
  scope?: "mine" | "team" | "all";
  status?: string;
  overdue?: boolean;
  due24h?: boolean;
  waitingClient?: boolean;
  projectId?: string;
  clientId?: string;
  assigneeId?: string;
  typeId?: string;
  priority?: "baixa" | "media" | "alta";
  archived?: boolean;
  archiveRequested?: boolean;
  q?: string;
  sort?: "deadline" | "board" | "recent" | "priority";
};

export const tasksQuery = (f: TaskListFilters = {}) =>
  queryOptions({
    queryKey: ["tasks", "list", f],
    queryFn: () => unwrap(api.tasks.$get({ query: { ...str(f), pageSize: "500" } as never })),
  });
export const taskQuery = (id: string) =>
  queryOptions({
    queryKey: ["tasks", id],
    queryFn: () => unwrap(api.tasks[":id"].$get({ param: { id } })),
  });
export const taskFeedbackQuery = (id: string) =>
  queryOptions({
    queryKey: ["tasks", id, "feedback"],
    queryFn: () => unwrap(api.tasks[":id"].feedback.$get({ param: { id } })),
  });
export const taskHistoryQuery = (id: string) =>
  queryOptions({
    queryKey: ["tasks", id, "history"],
    queryFn: () => unwrap(api.tasks[":id"].history.$get({ param: { id } })),
  });
export const tasksSummaryQuery = queryOptions({
  queryKey: ["tasks", "summary"],
  queryFn: () => unwrap(api.tasks.summary.$get()),
});

// biome-ignore lint/suspicious/noExplicitAny: extrai o tipo de retorno de qualquer queryFn
type Data<Q extends { queryFn?: any }> = Awaited<ReturnType<NonNullable<Q["queryFn"]>>>;
export type ProjectSummary = Data<ReturnType<typeof projectsQuery>>["data"][number];
export type Project = Data<ReturnType<typeof projectQuery>>;
export type TaskItem = Data<ReturnType<typeof tasksQuery>>["data"][number];
export type TaskDetail = Data<ReturnType<typeof taskQuery>>;
export type BoardColumn = {
  key: string;
  label: string;
  emoji: string | null;
  color: string | null;
  isFinal: boolean;
  isApproval: boolean;
  visible?: boolean;
};

export const PROJECT_STATUS_TONE: Record<
  ProjectStatus,
  "default" | "secondary" | "success" | "destructive" | "outline"
> = {
  planejamento: "secondary",
  ativo: "default",
  em_validacao: "outline",
  pausado: "destructive",
  entregue_suporte: "success",
  concluido: "success",
};

export const PRIORITY_DOT: Record<"baixa" | "media" | "alta", string> = {
  baixa: "bg-muted-foreground/50",
  media: "bg-amber-500",
  alta: "bg-destructive",
};

/** Prazo curto: "05/12" ou "05/12 18:00"; com ano se não for o atual. */
export function shortDeadline(iso: string, withTime: boolean, locale: string) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    ...(sameYear ? {} : { year: "2-digit" }),
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(d);
}

/** yyyy-mm-dd → dd/mm/aaaa sem mexer no fuso. */
export const calendarDate = (d: string | null | undefined, locale: string) =>
  d ? new Intl.DateTimeFormat(locale, { timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`)) : "";

/** ISO → valor de <input type="datetime-local"> (hora local). */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** <input type="datetime-local"> → ISO com o deslocamento local. */
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

/** Envia um arquivo direto ao bucket (URL pré-assinada) e confirma. Devolve o id do arquivo. */
export async function uploadFile(file: File) {
  const req = await unwrap(
    api.files.uploads.$post({
      json: { name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size },
    }),
  );
  const put = await fetch(req.uploadUrl, { method: "PUT", body: file, headers: req.headers });
  if (!put.ok) throw new Error("upload");
  await unwrap(api.files[":id"].complete.$post({ param: { id: req.fileId } }));
  return req.fileId;
}

export const downloadUrl = (fileId: string) => `/api/v1/files/${fileId}/download`;
