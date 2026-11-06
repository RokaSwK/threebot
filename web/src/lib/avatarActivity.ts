// What a Bot's avatar acts out. One place turns what T3 streams for a thread (its shell,
// and the turn items of its active run when the thread is open) into one of the engine's
// states, and one small hold keeps fast changes from flickering.
import type { AvatarState } from "./character";
import type { Run, Subagent, ThreadShell, TurnItem } from "./types";
import { shortToolName } from "./botMessages";

/** Only what this module reads from a thread's streamed data. */
export type ActivityData = { items: Record<string, TurnItem>; runs: Record<string, Run>; subagents?: Record<string, Subagent> };

/** Things happening in this browser that T3 doesn't stream: the composer and voice chat. */
export type LocalActivity = "listening" | "uploading" | "sending" | "voice-listening" | "voice-sending" | "voice-thinking" | "voice-speaking";

export type ActivityInput = {
  shell?: ThreadShell | null;
  data?: ActivityData | null;
  /** botStatus() for a Bot, or conversationStatus() for a child or side thread. */
  status?: string | null;
  local?: LocalActivity | null;
  /** Surfaces that flag waiting elsewhere, like the mobile list, keep the face calm. */
  quietWaiting?: boolean;
};

export type Activity = { state: AvatarState; until: number | null };

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
/** Shortest time any state stays on screen before the next one may replace it. */
export const HOLD_MS = 1200;
/** How long the eyes take to open when work arrives for a sleeping Bot. */
export const WAKE_MS = 1100;
/** The happy beat after a turn finishes. */
export const CHEER_MS = 3600;
/** A turn at least this long gets the bigger celebration. */
export const CELEBRATE_AFTER_MS = 2 * MINUTE;
/** A fresh subagent bursts out first, then circles while it runs. */
export const SPAWN_MS = 2500;
export const DROWSY_AFTER_MS = 20 * MINUTE;
export const SLEEP_AFTER_MS = 2 * 60 * MINUTE;

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const LIVE_ITEM = new Set(["running", "inProgress", "in_progress", "pending", "waiting", "streaming"]);
const WORKING_STATUS = new Set(["working", "pending", "preparing", "queued", "starting", "running"]);
/** Every state that means the Bot is busy on a turn. */
export const BUSY_STATES = new Set<AvatarState>(["thinking", "searching", "working", "writing", "sending", "receiving", "uploading", "spawning", "orbit", "listening", "dictating", "waking"]);
/** These jump the hold: the person needs to see them now. */
const URGENT = new Set<AvatarState>(["waiting", "failed", "notifying", "alerting"]);
const SLEEPY = new Set<AvatarState>(["sleeping", "drowsy"]);

const time = (value: string | null | undefined) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const LOCAL: Record<LocalActivity, AvatarState> = {
  listening: "listening",
  uploading: "uploading",
  sending: "sending",
  "voice-listening": "listening",
  "voice-sending": "sending",
  "voice-thinking": "thinking",
  "voice-speaking": "dictating",
};

/** A tool call's state, by what the tool does. */
export function toolActivity(name: string, startedAt: number | null, now: number): AvatarState {
  const tool = shortToolName(name).toLowerCase();
  if (/request_secret|request_user_input|ask_?user/.test(tool)) return "waiting";
  if (/delegate_task|thread_launch|create_threads|spawn|^agent$|^task$/.test(tool)) return startedAt !== null && now - startedAt < SPAWN_MS ? "spawning" : "orbit";
  if (/task_status|thread_wait|wait_agent|background_wait/.test(tool)) return "orbit";
  if (/upload|attachment/.test(tool)) return "uploading";
  if (/thread_send|send|reply|post_|email|notify/.test(tool)) return "sending";
  if (/search|fetch|find|grep|lookup|browse|query|^read|_read|list_|get_/.test(tool)) return "searching";
  if (/html_render|write|edit|create|update|save|draft/.test(tool)) return "writing";
  return "working";
}

/** One turn item's state while it runs. */
export function itemActivity(item: TurnItem, now: number): AvatarState {
  const startedAt = time(item.startedAt);
  switch (item.type) {
    case "reasoning":
      return "thinking";
    case "assistant_message":
      return "writing";
    case "web_search":
    case "file_search":
      return "searching";
    case "file_change":
      return "writing";
    case "subagent":
      return startedAt !== null && now - startedAt < SPAWN_MS ? "spawning" : "orbit";
    case "approval_request":
    case "user_input_request":
    case "secret_request":
      return "waiting";
    case "dynamic_tool":
    case "mcp_tool_call":
      return toolActivity(String(item.toolName ?? item.tool ?? item.name ?? ""), startedAt, now);
    default:
      return "working";
  }
}

function runActivity(data: ActivityData, shell: ThreadShell | null | undefined, now: number): Activity | null {
  const runs = Object.values(data.runs ?? {});
  const active = runs.filter((run) => ACTIVE_RUN.has(run.status)).sort((a, b) => b.ordinal - a.ordinal)[0];
  const runId = active?.id ?? (shell?.activeRunId || null);
  if (!runId) return null;
  if (active && active.status !== "running" && active.status !== "waiting") return { state: "receiving", until: null };
  const items = Object.values(data.items ?? {}).filter((item) => item.runId === runId).sort((a, b) => b.ordinal - a.ordinal);
  const live = items.find((item) => LIVE_ITEM.has(item.status) || (item.type === "assistant_message" && item.streaming));
  if (live) {
    const state = itemActivity(live, now);
    const startedAt = time(live.startedAt);
    // A new subagent turns from its burst to an orbit without any new event.
    const until = state === "spawning" && startedAt !== null ? startedAt + SPAWN_MS : null;
    return { state, until };
  }
  const children = Object.values(data.subagents ?? {}).some((agent) => ["pending", "running", "waiting"].includes(agent.status));
  if (children) return { state: "orbit", until: null };
  // Between items the model is deciding what to do next.
  return { state: items.length ? "thinking" : "receiving", until: null };
}

/** The state this thread should show right now, and when that answer can change on its own. */
export function deriveActivity({ shell, data, status, local, quietWaiting = false }: ActivityInput, now: number): Activity {
  if (local) return { state: LOCAL[local], until: null };
  const waiting = status === "waiting" || !!shell?.pendingRuntimeRequest;
  if (waiting) return { state: quietWaiting ? "idle" : "waiting", until: null };
  const runStatus = shell ? shell.activityRunStatus ?? shell.status : null;
  // A status the caller resolved wins; agentStatus() can know a child finished before its shell does.
  const running = status ? WORKING_STATUS.has(status) : !!runStatus && ACTIVE_RUN.has(runStatus);
  if (running) {
    const fromItems = data ? runActivity(data, shell, now) : null;
    if (fromItems) return fromItems;
    // Without the thread's items, all T3 tells us is the run's phase.
    return { state: runStatus === "running" || runStatus === "waiting" || status === "running" ? "working" : "receiving", until: null };
  }
  if (status === "failed" || (!status && runStatus === "failed")) return { state: "failed", until: null };
  if (!shell) return { state: "idle", until: null };
  const finished = time(shell.latestRunCompletedAt);
  if (finished !== null && runStatus === "completed" && now - finished < CHEER_MS && now >= finished) {
    const started = time(shell.latestRunStartedAt);
    return { state: started !== null && finished - started >= CELEBRATE_AFTER_MS ? "celebrate" : "happy", until: finished + CHEER_MS };
  }
  // A Bot with something new to show stays awake for it.
  if (status === "unread") return { state: "idle", until: null };
  const last = Math.max(finished ?? 0, time(shell.latestUserMessageAt) ?? 0, time(shell.latestVisibleMessage?.updatedAt) ?? 0, time(shell.createdAt) ?? 0);
  if (!last) return { state: "idle", until: null };
  const quiet = now - last;
  if (quiet >= SLEEP_AFTER_MS) return { state: "sleeping", until: null };
  if (quiet >= DROWSY_AFTER_MS) return { state: "drowsy", until: last + SLEEP_AFTER_MS };
  return { state: "idle", until: last + DROWSY_AFTER_MS };
}

export const isBusy = (state: AvatarState) => BUSY_STATES.has(state);

/** What is on screen, since when, and how long it must stay. */
export type Hold = { shown: AvatarState; since: number; lockedUntil: number };

/**
 * Moves the shown state toward the wanted one. Every state stays at least HOLD_MS, so
 * A→B→A inside that window never leaves A. Waiting and failures skip the queue, and a
 * sleeping Bot opens its eyes before it gets to work.
 */
export function holdStep(previous: Hold | null, wanted: AvatarState, now: number): Hold {
  if (!previous) return { shown: wanted, since: now, lockedUntil: now + HOLD_MS };
  if (previous.shown === wanted) return previous;
  if (!URGENT.has(wanted) && now < previous.lockedUntil) return previous;
  if (isBusy(wanted) && SLEEPY.has(previous.shown)) return { shown: "waking", since: now, lockedUntil: now + WAKE_MS };
  return { shown: wanted, since: now, lockedUntil: now + HOLD_MS };
}

/** When holdStep could next move on without anything else changing. */
export function holdWake(hold: Hold, wanted: AvatarState) {
  return hold.shown === wanted ? null : hold.lockedUntil;
}
