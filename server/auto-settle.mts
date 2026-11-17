// T3 Code (0.1.8 and later) settles a thread that has been idle for a week. A Bot's main thread, its
// room threads and a routine's thread are long-lived and often quiet that long, and a settled main
// thread reads as "done" in T3's sidebar and hides its unread reply. Threebot turns auto-settle off for
// the threads it owns, the same switch as "Keep active" on a T3 thread. A thread the user settles by
// hand stays settled; the next message wakes it as usual.

/** A thread from T3's shell snapshot, as far as this file reads it. */
export type SettleThread = { id: string; archivedAt?: string | null; autoSettleDisabledAt?: string | null };
/** What a sweep needs from T3; T3Client and the gateway's adapter fit. */
export type SettleDeps = {
  threads: () => Promise<SettleThread[]>;
  dispatch: (command: object) => Promise<unknown>;
  log?: (message: string) => void;
};

/**
 * Turns auto-settle off for every owned thread that still has it on. A T3 without auto-settle sends
 * no `autoSettleDisabledAt` field, so its threads are left alone. Returns the threads switched.
 */
export async function keepThreadsActive(owned: Iterable<string | null | undefined>, { threads, dispatch, log = console.error }: SettleDeps): Promise<string[]> {
  const ids = new Set([...owned].filter((id): id is string => typeof id === "string" && id.length > 0));
  if (!ids.size) return [];
  const switched: string[] = [];
  for (const thread of await threads()) {
    if (!ids.has(thread.id) || thread.archivedAt || !("autoSettleDisabledAt" in thread) || thread.autoSettleDisabledAt) continue;
    try {
      await dispatch({ type: "thread.auto-settle.set", threadId: thread.id, enabled: false });
      switched.push(thread.id);
    } catch (error) {
      log(`[auto-settle] couldn't keep ${thread.id} active: ${(error as Error).message ?? error}`);
    }
  }
  return switched;
}

/** The fields of a T3 shell thread that `settleQuietThreads` reads. */
export type QuietThread = SettleThread & {
  projectId?: string | null;
  status?: string | null;
  activityRunStatus?: string | null;
  pendingRuntimeRequest?: unknown;
  pendingBackgroundTasks?: unknown[] | null;
  settledOverride?: string | null;
  settledAt?: string | null;
  pinnedAt?: string | null;
  snoozedUntil?: string | null;
  waitingForMergeAt?: string | null;
  limitRecovery?: unknown;
  usageLimitResetAt?: string | null;
  pullRequests?: { watch?: unknown }[] | null;
  latestRunCompletedAt?: string | null;
  latestUserMessageAt?: string | null;
  lineage?: { rootThreadId?: string | null; parentThreadId?: string | null } | null;
};
/** Which threads are the Bots': their main, room and routine threads, everything in a Bot's own project, and what descends from a main thread. */
export type BotOwnership = { threadIds: Iterable<string | null | undefined>; projectIds: Iterable<string | null | undefined>; rootIds: Iterable<string | null | undefined> };

/** A thread is quiet this long after its last change before it is settled, so a reply that just landed isn't settled under the user. */
export const QUIET_MS = 2 * 60_000;
const BUSY = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const set = (ids: Iterable<string | null | undefined>) => new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0));

/**
 * Settings → Beta → "Settle Bot threads in T3 Code". Settles every quiet Bot thread T3 still lists as
 * active, so T3's sidebar holds only the user's own threads. Settling in T3 also drops PR watches,
 * disarms usage-limit auto-resume and cancels queued wakes, so a thread with any of those, or one that
 * is busy, waiting on the user, pinned or snoozed, is left alone. A new message unsettles it as usual,
 * and the next sweep settles it again once it's quiet. Returns the threads settled.
 */
export async function settleQuietThreads(owned: BotOwnership, { threads, dispatch, log = console.error, now = Date.now() }: Omit<SettleDeps, "threads"> & { threads: () => Promise<QuietThread[]>; now?: number }): Promise<string[]> {
  const ids = set(owned.threadIds), projects = set(owned.projectIds), roots = set(owned.rootIds);
  if (!ids.size && !projects.size && !roots.size) return [];
  const later = (at: string | null | undefined, ms = 0) => !!at && Date.parse(at) + ms > now;
  const settled: string[] = [];
  for (const thread of await threads()) {
    const mine = ids.has(thread.id) || projects.has(thread.projectId ?? "") || roots.has(thread.lineage?.rootThreadId ?? "") || roots.has(thread.lineage?.parentThreadId ?? "");
    const isAlreadySettled = thread.settledOverride === "settled" || (thread.settledOverride !== "active" && Boolean(thread.settledAt));
    if (!mine || thread.archivedAt || isAlreadySettled || thread.pinnedAt) continue;
    if (thread.pendingRuntimeRequest || BUSY.has(thread.activityRunStatus ?? thread.status ?? "") || thread.pendingBackgroundTasks?.length) continue;
    if (thread.waitingForMergeAt || thread.limitRecovery || later(thread.usageLimitResetAt) || later(thread.snoozedUntil)) continue;
    if (thread.pullRequests?.some((link) => link.watch)) continue;
    // Not updatedAt: visits and Threebot's own auto-settle switch move it without anything happening.
    if (later(thread.latestRunCompletedAt, QUIET_MS) || later(thread.latestUserMessageAt, QUIET_MS)) continue;
    try {
      await dispatch({ type: "thread.settle", threadId: thread.id });
      settled.push(thread.id);
    } catch (error) {
      log(`[settle] couldn't settle ${thread.id}: ${(error as Error).message ?? error}`);
    }
  }
  return settled;
}
