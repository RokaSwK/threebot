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
  source?: { kind?: string | null; childThreadId?: string | null; taskIds?: string[] } | null;
  outcome?: string;
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


export const ROOM_RUN_OVER = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const DELEGATION_GRACE_MS = 15_000;

export type ChainRun = { id: string; status?: string | null; completedAt?: string | null; ordinal?: number; userMessageId?: string };
export type ChainTask = {
  id: string;
  status: string;
  completedAt?: string | null;
  updatedAt?: string | null;
  completionDelivery?: { state: string; observedByRunId?: string | null } | null;
};

export type DelegatedChild = {
  childThreadId: string;
  subagentId: string | null;
  title: string | null;
  status: string;
  completedAt: string | null;
};
type ChainState = {
  runIds: string[];
  children: DelegatedChild[];
  settled: boolean;
  stalled: boolean;
};

/** Follow only wake-up runs attributed to children of this dispatch. The set bounds the walk. */
export function chainReply(items: ReplyItem[], runs: ChainRun[], root: string, now = Date.now(), tasks: ChainTask[] = []) {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const wakesByChild = new Map<string, ReplyItem[]>();
  const childrenByRun = new Map<string, ReplyItem[]>();
  for (const item of items) {
    if (!item.runId) continue;
    if (item.type === "notification" && item.source?.kind === "delegated_task") {
      const keys = (item.source.taskIds ?? []).map((id) => `task:${id}`);
      if (!keys.length && item.source.childThreadId) keys.push(`thread:${item.source.childThreadId}`);
      for (const key of keys) {
        const notifications = wakesByChild.get(key) ?? [];
        notifications.push(item);
        wakesByChild.set(key, notifications);
      }
    } else if (item.type === "subagent") {
      const siblings = childrenByRun.get(item.runId) ?? [];
      siblings.push(item);
      childrenByRun.set(item.runId, siblings);
    }
  }

  const seen = new Set([root]);
  const children: DelegatedChild[] = [];
  const completionRuns = new Set<string>();
  const inlineNoticeOrdinals = new Map<string, number>();
  let completedAt = 0;
  const dispatchedAsync = new Set<string>();
  let pending = false;
  let missingWake = false;
  let lastUndelivered = 0;
  for (const runId of seen) {
    const run = runsById.get(runId);
    const parentEnd = Date.parse(run?.completedAt ?? "");
    completedAt = Math.max(completedAt, parentEnd || 0);
    for (const item of childrenByRun.get(runId) ?? []) {
      const childThreadId = item.childThreadId ?? "";
      const task = item.subagentId ? tasksById.get(item.subagentId) : undefined;
      const status = task?.status ?? item.status ?? "running";
      const childCompletedAt = task?.completedAt ?? item.completedAt ?? null;
      children.push({ childThreadId, subagentId: item.subagentId ?? null, title: item.title ?? null, status, completedAt: childCompletedAt });
      const childEnd = Date.parse(childCompletedAt ?? "");
      const delivery = task?.completionDelivery;
      const awaitingDelivery = delivery?.state === "pending" || delivery?.state === "claimed";
      let deliveredInline = delivery
        ? (delivery.state === "delivered" || delivery.state === "acknowledged") && delivery.observedByRunId === runId
        : childEnd <= parentEnd;
      completedAt = Math.max(completedAt, childEnd || 0);
      const notifications = (item.subagentId && wakesByChild.get(`task:${item.subagentId}`))
        || wakesByChild.get(`thread:${childThreadId}`) || [];
      let delivered = false;
      for (const notification of notifications) {
        const wakeId = notification.runId;
        if (!wakeId) continue;
        if (wakeId === runId) {
          if (notification.outcome !== "updated" && ROOM_RUN_OVER.has(status)) {
            deliveredInline = true;
            if (notification.ordinal !== undefined) {
              inlineNoticeOrdinals.set(runId, Math.max(inlineNoticeOrdinals.get(runId) ?? 0, notification.ordinal));
            }
          }
          continue;
        }
        // T3 can steer into another run. A standalone wake must have started its run.
        const messageId = runsById.get(wakeId)?.userMessageId;
        if (messageId && notification.id !== `turn-item:message:${encodeURIComponent(messageId)}` && notification.messageId !== messageId) continue;
        seen.add(wakeId);
        if (notification.outcome === "updated") continue;
        const wakeStatus = runsById.get(wakeId)?.status;
        if (awaitingDelivery && (wakeStatus === "cancelled" || wakeStatus === "interrupted" || wakeStatus === "rolled_back")) continue;
        if (ROOM_RUN_OVER.has(status)) {
          completionRuns.add(wakeId);
          delivered = true;
        }
      }
      if (delivered) {
        dispatchedAsync.add(runId);
      } else if (!ROOM_RUN_OVER.has(status)) {
        dispatchedAsync.add(runId);
        pending = true;
      } else if (!deliveredInline) {
        dispatchedAsync.add(runId);
        missingWake = true;
        lastUndelivered = Math.max(lastUndelivered, parentEnd || 0, childEnd || 0, Date.parse(task?.updatedAt ?? item.updatedAt ?? "") || 0);
      }
    }
  }

  const runIds = [...seen];
  const wakeOver = runIds.slice(1).every((id) => ROOM_RUN_OVER.has(runsById.get(id)?.status ?? ""));
  const settled = !pending && !missingWake && wakeOver;
  const stalled = !pending && missingWake && wakeOver && lastUndelivered > 0 && now - lastUndelivered >= DELEGATION_GRACE_MS;
  const chain: ChainState = { runIds, children, settled, stalled };
  // A run that sent out background work may have ended with an acknowledgement.
  // Use the last wake-up after the chain settles, including a deliberate pass.
  const answerRun = [...completionRuns].sort((a, b) =>
    (runsById.get(a)?.ordinal ?? 0) - (runsById.get(b)?.ordinal ?? 0)
    || (Date.parse(runsById.get(a)?.completedAt ?? "") || 0) - (Date.parse(runsById.get(b)?.completedAt ?? "") || 0)
  ).at(-1) ?? root;
  const answerStatus = runsById.get(answerRun)?.status;
  const inlineOrdinal = inlineNoticeOrdinals.get(answerRun);
  const answerItems = inlineOrdinal === undefined ? items : items.filter((item) => (item.ordinal ?? 0) > inlineOrdinal);
  const reply = settled && !dispatchedAsync.has(answerRun) && (answerStatus === "completed" || (!answerStatus && children.length === 0))
    ? pickReply(answerItems, answerRun) : null;
  return { chain, answerStatus, completedAt, reply: reply ? { ...reply, runId: answerRun } : null };
}

/** Read the answer the room published, or a settled answer that arrived after its deadline. */
export function recordedRoomReply(
  items: ReplyItem[], runs: ChainRun[],
  part: { runId: string | null; replyRunId?: string; replyItemId?: string; status?: string; delegationTimedOut?: boolean },
  turnStatus: string, tasks?: ChainTask[],
) {
  if (!part.runId) return null;
  if (part.status === "replied" || part.status === "passed") {
    const published = part.replyItemId ? items.filter((item) => item.id === part.replyItemId) : items;
    return pickReply(published, part.replyRunId ?? part.runId);
  }
  if (part.status === "timeout" && runs.some((run) => run.id === part.runId && run.status === "completed")) {
    const { reply, chain } = chainReply(items, runs, part.runId, undefined, tasks);
    return part.delegationTimedOut && chain.children.length === 0 ? null : reply;
  }
  if (!part.status && turnStatus === "done") return chainReply(items, runs, part.runId, undefined, tasks).reply;
  return null;
}
