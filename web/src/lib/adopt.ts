import type { ThreadShell } from "./types";

/** The threads a Bot made from a project could take as its main conversation: the project's top-level, unarchived threads, newest first. */
export function mainThreadChoices(threads: ThreadShell[], projectId: string) {
  return threads
    .filter((thread) => thread.projectId === projectId && !thread.archivedAt && !thread.lineage?.parentThreadId && !thread.lineage?.sideChat)
    .sort((a, b) => (b.latestUserMessageAt ?? b.updatedAt ?? "").localeCompare(a.latestUserMessageAt ?? a.updatedAt ?? ""));
}
