import type { ThreadShell } from "./types";

/**
 * The threads a Bot made from a project could take as its main conversation: the project's top-level,
 * unarchived threads in the project's own folder (a thread in a separate worktree wouldn't see the Bot's files), newest first.
 */
export function mainThreadChoices(threads: ThreadShell[], projectId: string, workspaceRoot?: string) {
  const strip = (p: string) => p.replace(/\/+$/, "");
  return threads
    .filter((thread) => thread.projectId === projectId && !thread.archivedAt && (!thread.worktreePath || (workspaceRoot !== undefined && strip(thread.worktreePath) === strip(workspaceRoot))) && !thread.lineage?.parentThreadId && !thread.lineage?.sideChat)
    .sort((a, b) => (b.latestUserMessageAt ?? b.updatedAt ?? "").localeCompare(a.latestUserMessageAt ?? a.updatedAt ?? ""));
}
