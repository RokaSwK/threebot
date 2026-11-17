// The pure part of a room turn: who is addressed, how a line reads, when a reply is a pass, and
// which turn item is the reply. Shared with the web the same way mention-rules.mts is, so the
// composer, the view and the engine agree on what `@Name` means.
import { mentionsInText } from "./mention-rules.mts";

export type RoomAuthor = { kind: "user" } | { kind: "bot"; slug: string; name: string };

export type RoomLine = {
  at: string;
  author: RoomAuthor;
  text: string;
  /** Set when this line answers another one: `Name` of the author being answered. */
  replyToName?: string | null;
};

export type RoomMemberName = { slug: string; name: string };

/** `@all` / `@everyone` address every member; the same code fences and boundaries apply. */
const EVERYONE = "everyone";

/**
 * The members a user message addresses.
 * `mentions` wins when the composer resolved it; otherwise the text is parsed with the shared rules.
 */
export function addressedMembers(text: string, members: RoomMemberName[], policy: "anywhere" | "leading"): { slugs: string[]; all: boolean } {
  const names = members.map((member) => member.name).concat([EVERYONE]);
  const matched = mentionsInText(text, names, policy);
  const all = matched.some((name) => name.toLowerCase() === "all" || name.toLowerCase() === EVERYONE);
  if (all) return { slugs: members.map((member) => member.slug), all: true };
  const byName = new Map(members.map((member) => [member.name.toLowerCase(), member.slug]));
  const slugs = matched.flatMap((name) => {
    const slug = byName.get(name.toLowerCase());
    return slug ? [slug] : [];
  });
  return { slugs: [...new Set(slugs)], all: false };
}

/** A member with nothing to add answers exactly `(pass)`; the room line and the push skip it. */
export function isPass(text: string): boolean {
  return /^\(?\s*pass\s*\)?$/i.test(text.trim());
}

/** One line of the transcript as the room and the prompt show it. */
export function formatRoomLine(line: RoomLine): string {
  const who = line.author.kind === "user" ? "User" : line.author.name;
  const quote = line.replyToName ? `[replying to ${line.replyToName}] ` : "";
  return `${who}: ${quote}${clip(line.text, 1_200)}`;
}

/** Cuts long text with an ellipsis. Line breaks stay: pasted lists and code keep their shape. */
export function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

export type ReplyItem = {
  id?: string;
  runId?: string | null;
  ordinal?: number;
  type?: string;
  status?: string;
  text?: unknown;
  messageId?: string;
  /** A user message's files, already claimed by the thread that received them. */
  attachments?: unknown[];
  completedAt?: string | null;
  updatedAt?: string | null;
  /** `subagent` rows: the child thread a run delegated to, and how it is doing. */
  subagentId?: string | null;
  childThreadId?: string | null;
  title?: string | null;
  /** `notification` rows: what woke the run, e.g. a delegated task finishing. */
  source?: { kind?: string | null; childThreadId?: string | null } | null;
};

/**
 * The reply of a run: the last completed assistant message that belongs to it.
 * Tool rows, questions and reasoning are not replies.
 */
export function pickReply(items: ReplyItem[], runId: string | null | undefined): { id: string; text: string; at: string | null } | null {
  if (!runId) return null;
  const assistant = items.filter((item) =>
    item.runId === runId
    && (item.type === "assistant_message" || item.type === "assistant")
    && item.status === "completed"
    && typeof item.text === "string"
    && item.text.trim() !== ""
  ).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const last = assistant.at(-1);
  if (!last) return null;
  return { id: String(last.id ?? ""), text: String(last.text), at: last.completedAt ?? last.updatedAt ?? null };
}

/** A run's terminal states, as T3 reports them. */
const RUN_OVER = new Set(["completed", "failed", "cancelled", "interrupted"]);
/** A delegated child's terminal states, as T3 reports them. */
const CHILD_OVER = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** How many delegation generations a room follows before closing with what it has. */
export const MAX_DELEGATION_GENERATIONS = 2;
/** A child that finished but never woke its parent closes the line after this pause. */
export const DELEGATION_GRACE_MS = 15_000;

export type ChainRun = { id: string; status?: string | null; completedAt?: string | null };
export type DelegatedChild = {
  childThreadId: string;
  subagentId: string | null;
  title: string | null;
  status: string;
  completedAt: string | null;
};
export type ChainState = {
  /** The dispatch run and every wake-up run its delegated children caused, oldest first. */
  runIds: string[];
  children: DelegatedChild[];
  /** Children still working, and children already done. */
  running: number;
  done: number;
  /** How many delegation generations the chain followed (0 = the Bot delegated nothing). */
  generation: number;
  /**
   * True when the member has nothing left in flight: no child is running, every finished child
   * has woken its parent, and those wake-up runs are over. A member that delegates is not
   * answered until this is true.
   */
  settled: boolean;
};

/** The run a delegated child's completion woke, found through the notification it produced. */
function wakeRunFor(items: ReplyItem[], childThreadId: string | null | undefined): string | null {
  if (!childThreadId) return null;
  let found: string | null = null;
  for (const item of items) {
    if (item.type !== "notification" || !item.runId) continue;
    if (item.source?.kind !== "delegated_task") continue;
    if (item.source.childThreadId !== childThreadId) continue;
    found = item.runId;
  }
  return found;
}

/**
 * A member's part of a room turn: the run the room dispatched, plus the runs its delegated
 * children woke. T3 ends a run before its delegated work does and wakes the thread again with a
 * notification, so `settled` is the answer to "may the room publish this member's line yet?".
 * Pure and shared with the web, so the engine, the room view and the history agree.
 */
export function chainState(items: ReplyItem[], runs: ChainRun[], rootRunId: string, options: { nowMs?: number; graceMs?: number; maxGenerations?: number } = {}): ChainState {
  const now = options.nowMs ?? Date.now();
  const graceMs = options.graceMs ?? DELEGATION_GRACE_MS;
  const maxGenerations = options.maxGenerations ?? MAX_DELEGATION_GENERATIONS;
  const statusOf = new Map(runs.map((run) => [run.id, run.status ?? "running"]));
  const runEnd = new Map(runs.map((run) => [run.id, Date.parse(run.completedAt ?? "") || 0]));
  const runIds = [rootRunId];
  const children: DelegatedChild[] = [];
  /** Child keys whose completion was delivered inside the run that delegated them. */
  const deliveredInRun = new Set<string>();
  const keys: string[] = [];
  const seen = new Set<string>();
  let frontier = [rootRunId];
  let generation = 0;
  while (frontier.length > 0 && generation < maxGenerations) {
    const next: string[] = [];
    for (const runId of frontier) {
      for (const item of items) {
        if (item.type !== "subagent" || item.runId !== runId) continue;
        const childThreadId = item.childThreadId ?? "";
        const key = childThreadId || item.subagentId || item.id || `${runId}:${children.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const status = item.status ?? "running";
        const child: DelegatedChild = {
          childThreadId,
          subagentId: item.subagentId ?? null,
          title: item.title ?? null,
          status,
          completedAt: item.completedAt ?? null,
        };
        children.push(child);
        keys.push(key);
        if (!CHILD_OVER.has(status)) continue;
        // A child that finished before its run did was reported inside the turn the Bot was still
        // working in; only a completion after the run ends has to wake the thread again.
        const parentEnd = runEnd.get(runId) ?? 0;
        const childEnd = Date.parse(child.completedAt ?? "") || 0;
        if (parentEnd > 0 && childEnd > 0 && childEnd <= parentEnd) deliveredInRun.add(key);
        const wake = wakeRunFor(items, childThreadId);
        if (wake && !runIds.includes(wake)) { runIds.push(wake); next.push(wake); }
      }
    }
    frontier = next;
    if (frontier.length > 0) generation += 1;
  }
  const running = children.filter((child) => !CHILD_OVER.has(child.status)).length;
  const done = children.length - running;
  // A child that is over but has not woken its parent yet is still work in flight, unless the
  // pause is long enough that T3 is clearly not going to wake it (an older T3, a provider that
  // dropped the completion). Then the room closes with the reply it already has.
  const undelivered = children.filter((child, index) => CHILD_OVER.has(child.status) && !deliveredInRun.has(keys[index]) && !wakeRunFor(items, child.childThreadId)).length;
  const lastDone = children.reduce((newest, child) => Math.max(newest, Date.parse(child.completedAt ?? "") || 0), 0);
  const graceOver = undelivered > 0 && running === 0 && lastDone > 0 && now - lastDone >= graceMs;
  const wakeOver = runIds.slice(1).every((runId) => RUN_OVER.has(statusOf.get(runId) ?? "running"));
  const settled = running === 0 && wakeOver && (undelivered === 0 || graceOver);
  return { runIds, children, running, done, generation, settled };
}

/**
 * The run that started a member's chain. The room registers the run that produced the line — often
 * the wake-up run, whose own `subagent` rows are empty — so anything that needs the tasks walks
 * back through the notifications to the run that delegated them.
 */
export function chainRootOf(items: ReplyItem[], runId: string, limit = MAX_DELEGATION_GENERATIONS + 1): string {
  let current = runId;
  for (let step = 0; step < limit; step += 1) {
    let parent: string | null = null;
    for (const item of items) {
      if (item.type !== "notification" || item.runId !== current) continue;
      if (item.source?.kind !== "delegated_task") continue;
      const child = items.find((candidate) => candidate.type === "subagent" && candidate.childThreadId === item.source?.childThreadId && candidate.runId);
      if (child?.runId) parent = child.runId;
    }
    if (!parent || parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * The line a member's run produces: the reply of the run itself, or the last completed message of
 * the chain its delegated children woke. `reply` stays null while the chain is not settled, which
 * is what keeps a progress note out of the room.
 */
export function chainReply(
  items: ReplyItem[],
  runs: ChainRun[],
  rootRunId: string,
  options: { nowMs?: number; graceMs?: number; maxGenerations?: number } = {},
): { chain: ChainState; reply: { id: string; runId: string; text: string; at: string | null } | null } {
  const chain = chainState(items, runs, rootRunId, options);
  if (!chain.settled) return { chain, reply: null };
  if (chain.children.length === 0) {
    const last = pickReply(items, rootRunId);
    return { chain, reply: last ? { ...last, runId: rootRunId } : null };
  }
  return { chain, reply: pickChainReply(items, chain.runIds) };
}

/**
 * The line a member's chain produces: the last completed assistant message of the whole chain,
 * skipping `(pass)` so a wake-up that only says "nothing to add" does not replace the answer.
 * Falls back to the last message of the chain when every one of them is a pass.
 */
export function pickChainReply(items: ReplyItem[], runIds: string[]): { id: string; runId: string; text: string; at: string | null } | null {
  const chain = new Set(runIds);
  const messages = items.filter((item) =>
    !!item.runId && chain.has(item.runId)
    && (item.type === "assistant_message" || item.type === "assistant")
    && item.status === "completed"
    && typeof item.text === "string"
    && item.text.trim() !== ""
  );
  // The caller may hand items in any order (the view keeps them by id): order by when each message
  // landed so the chain's last word is the latest one, not the last one in the array.
  const at = (item: ReplyItem) => Date.parse(item.completedAt ?? item.updatedAt ?? "") || 0;
  const ordered = messages.every((item, index) => index === 0 || at(messages[index - 1]) <= at(item)) ? messages : [...messages].sort((a, b) => at(a) - at(b));
  const spoken = ordered.filter((item) => !isPass(String(item.text)));
  const last = spoken.at(-1) ?? ordered.at(-1);
  if (!last) return null;
  return {
    id: String(last.id ?? ""),
    runId: String(last.runId),
    text: String(last.text),
    at: last.completedAt ?? last.updatedAt ?? null,
  };
}
