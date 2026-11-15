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
