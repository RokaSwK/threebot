import type { Run, ThreadShell } from "./types";

// A side chat is T3's hidden fork of a thread: it shares the thread's context and
// worktree, runs beside it, and stays out of every list. Threebot opens one in a sheet.

const SIDE_COMMAND = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i;
const BUSY = ["preparing", "starting", "running", "waiting"];
const FINISHED = ["waiting", "completed"];
const BLOCKS_BRING_BACK = ["preparing", "starting", "running"];

export const isSideChat = (thread?: Pick<ThreadShell, "lineage"> | null) => thread?.lineage?.sideChat === true;

export function parseSideCommand(text: string) {
  const match = SIDE_COMMAND.exec(text.trim());
  return match ? { prompt: (match[1] ?? "").trim() } : null;
}

/** T3 refuses side chats of side chats and subagents; linked machines report their own support. */
export function canStartSideChat(thread?: ThreadShell | null) {
  return !!thread && !isSideChat(thread) && thread.lineage.relationshipToParent !== "subagent" && !thread.environmentId;
}

export function sideChatsOf(threads: Record<string, ThreadShell>, parentThreadId: string) {
  return Object.values(threads)
    .filter((thread) => isSideChat(thread) && thread.lineage.parentThreadId === parentThreadId && !thread.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function sideChatTitle(prompt: string) {
  const line = prompt.trim().split("\n")[0].trim();
  if (!line) return "Side chat";
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

export const threadBusy = (thread?: ThreadShell | null) =>
  !!thread && (!!thread.activeRunId || BUSY.includes(thread.activityRunStatus ?? thread.status));

/** The newest finished reply, unless a newer run is still going. Matches T3's merge-back rule. */
export function bringBackRun(runs: Pick<Run, "id" | "ordinal" | "status">[]) {
  const latest = runs.filter((run) => FINISHED.includes(run.status)).sort((a, b) => b.ordinal - a.ordinal)[0];
  if (!latest) return null;
  return runs.some((run) => run.ordinal > latest.ordinal && BLOCKS_BRING_BACK.includes(run.status)) ? null : latest;
}

/** What the pill above the composer says about a closed side chat; null keeps it out of the way. */
export function sideChatSignal(thread: ThreadShell) {
  if (thread.pendingRuntimeRequest) return "Needs you";
  if (threadBusy(thread)) return "Working";
  const finished = thread.latestRunCompletedAt;
  return finished && (!thread.lastVisitedAt || finished > thread.lastVisitedAt) ? "Replied" : null;
}
