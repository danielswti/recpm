import { useQuery } from "@tanstack/react-query";
import { catalogQuery, kanbanColumnsQuery, taskTypesQuery } from "../../lib/catalogs";
import { membersQuery } from "../../lib/queries";
import { projectsQuery } from "../../lib/work";

/** Listas usadas pelos formulários de projeto/tarefa (pessoas, tipos, tags, colunas, projetos). */
export function useLookups(opts: { projects?: boolean } = {}) {
  const members = useQuery(membersQuery("team"));
  const types = useQuery(taskTypesQuery);
  const tags = useQuery(catalogQuery("tags"));
  const columns = useQuery(kanbanColumnsQuery);
  const projects = useQuery({ ...projectsQuery({}), enabled: opts.projects !== false });
  return {
    people: (members.data?.data ?? []).filter((m) => m.active),
    types: (types.data?.data ?? []).filter((x) => x.active && x.usableAsType),
    tags: (tags.data?.data ?? []).filter((x) => x.active),
    columns: (columns.data?.data ?? []).filter((c) => c.active).sort((a, b) => a.position - b.position),
    projects: projects.data?.data ?? [],
  };
}
