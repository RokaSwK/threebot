import { useEffect, useLayoutEffect, useReducer, useRef, useSyncExternalStore, type ComponentProps } from "react";
import { Avatar } from "./Avatar";
import { useApp, type ThreadData } from "../store";
import { deriveActivity, holdStep, holdWake, type Hold, type LocalActivity } from "../lib/avatarActivity";
import type { AvatarState } from "../lib/character";

// ---------- this browser's own activity per thread (composer, uploads, voice) ----------
const local = new Map<string, LocalActivity>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

/** Shows a thread's composer or voice activity on every avatar of that thread while it lasts. */
export function useReportLocalActivity(threadId: string | null | undefined, activity: LocalActivity | null) {
  useEffect(() => {
    if (!threadId || !activity) return;
    local.set(threadId, activity);
    for (const listener of listeners) listener();
    return () => {
      if (local.get(threadId) !== activity) return;
      local.delete(threadId);
      for (const listener of listeners) listener();
    };
  }, [threadId, activity]);
}

const loadedData = (data: ThreadData | undefined) => (data?.loaded ? data : null);

/** The state a thread's avatar shows now, held so it never flickers. */
export function useAvatarActivity(threadId: string | null | undefined, status: string | null | undefined, { quietWaiting = false } = {}): AvatarState {
  const [, rerun] = useReducer((n: number) => n + 1, 0);
  const localActivity = useSyncExternalStore(subscribe, () => (threadId ? local.get(threadId) ?? null : null));
  // The selector returns a string, so a token streaming into an open thread re-renders
  // this avatar only when the state or its next deadline actually changes.
  const derived = useApp((s) => {
    const activity = deriveActivity({ shell: threadId ? s.threads[threadId] : null, data: threadId ? loadedData(s.threadData[threadId]) : null, status, local: localActivity, quietWaiting }, Date.now());
    return `${activity.state}|${activity.until ?? ""}`;
  });
  const [wanted, untilText] = derived.split("|") as [AvatarState, string];
  const hold = useRef<Hold | null>(null);
  const now = Date.now();
  const next = holdStep(hold.current, wanted, now);
  useLayoutEffect(() => { hold.current = next; });
  const wake = Math.min(untilText ? Number(untilText) : Infinity, holdWake(next, wanted) ?? Infinity);
  useEffect(() => {
    if (!Number.isFinite(wake)) return;
    const timer = window.setTimeout(rerun, Math.max(0, wake - Date.now()) + 20);
    return () => window.clearTimeout(timer);
  }, [wake]);
  return next.shown;
}

/** An Avatar that acts out what its thread is doing. Replaces passing a state by hand. */
export function ActivityAvatar({ threadId, status, quietWaiting, ...props }: Omit<ComponentProps<typeof Avatar>, "state"> & { threadId: string | null | undefined; status: string | null | undefined; quietWaiting?: boolean }) {
  const state = useAvatarActivity(threadId, status, { quietWaiting });
  return <Avatar {...props} state={state} />;
}
