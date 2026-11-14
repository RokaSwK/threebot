// The room turn engine. A room runs one turn at a time: address the members the user asked for,
// dispatch the framed prompt to each of their room threads, wait for their runs, read the replies
// and store what the room needs (status, run ids, last reply time). Bot replies are never copied
// into rooms.json: they stay in their threads.
import { randomUUID } from "node:crypto";
import { addressedMembers, clip, formatRoomLine, isPass, pickReply, type ReplyItem, type RoomLine } from "./room-lines.mts";
import { launchRoomThread, type LaunchDefaults, type RoomBot, type RoomRpc } from "./rooms-threads.mts";
import type { Room, RoomMember, RoomRun, RoomTurn, RoomsStore } from "./rooms.mts";

export type RoomMessage = { text: string; mentions?: string[]; replyTo?: string | null };

export type EngineRpc = RoomRpc & { dispatch(command: object): Promise<unknown> };

export type EngineDeps = {
  rooms: RoomsStore;
  rpc: EngineRpc;
  bots: () => Promise<Map<string, RoomBot>>;
  defaults: () => Promise<LaunchDefaults>;
  notify?: (payload: { title: string; body: string; url: string }) => Promise<void> | void;
  log?: (line: string) => void;
  /** How often a run's projection is read. Tests pass 0. */
  pollMs?: number;
  nowMs?: () => number;
};

type Projection = {
  runs?: { id: string; status: string; userMessageId?: string; ordinal?: number }[] | null;
  turnItems?: ReplyItem[] | null;
} | null;

type QueuedMessage = { turnId: string; message: RoomMessage };
type ActiveTurn = { turnId: string; abort: boolean; threads: Map<string, string | null> };

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOfSlug = (slug: string) => slug;
/** A member's part ended because the room was stopped before its message went out. */
class StoppedError extends Error {}

/**
 * The members a message addresses. An explicit `mentions` list from the composer wins; otherwise
 * the text is parsed with the same rules the composer uses. Nobody named falls back to
 * `settings.defaultResponder`: the lead, everyone, or nobody at all.
 */
export function speakersFor(room: Room, message: RoomMessage, nameOf: (slug: string) => string = nameOfSlug): RoomMember[] {
  const available = room.members.filter((member) => member.status !== "unavailable");
  const bySlug = new Map(available.map((member) => [member.slug, member]));
  const named = (message.mentions ?? []).map((slug) => slug.toLowerCase());
  if (named.some((slug) => slug === "all" || slug === "everyone")) return available;
  const explicit = (message.mentions ?? []).flatMap((slug) => (bySlug.has(slug) ? [bySlug.get(slug)!] : []));
  if (explicit.length > 0) return explicit;
  if (!message.mentions?.length && message.text.trim() !== "") {
    const parsed = addressedMembers(message.text, available.map((member) => ({ slug: member.slug, name: nameOf(member.slug) })), room.settings.mentionPolicy);
    const matched = parsed.slugs.flatMap((slug) => (bySlug.has(slug) ? [bySlug.get(slug)!] : []));
    if (matched.length > 0) return matched;
  }
  if (room.settings.defaultResponder === "everyone") return available;
  if (room.settings.defaultResponder === "mentions") return [];
  const lead = bySlug.get(room.settings.lead);
  return lead ? [lead] : available.slice(0, 1);
}

/** Lines the member has not seen: the room history after its last turn, newest 24. */
export function linesFor(room: Room, member: RoomMember, history: RoomLine[] = []): string[] {
  const since = member.lastTurnAt ? Date.parse(member.lastTurnAt) : 0;
  return history
    .filter((line) => !member.lastTurnAt || (Date.parse(line.at) || 0) > since)
    .slice(-24)
    .map(formatRoomLine);
}

/**
 * Round-robin the first speaker of a roundtable turn. The turn index, not a counter, keeps the
 * rotation stable across restarts and queued messages.
 */
export function rotateSpeakers(members: RoomMember[], by: number): RoomMember[] {
  if (members.length < 2 || by <= 0) return members;
  const offset = by % members.length;
  return [...members.slice(offset), ...members.slice(0, offset)];
}

/** The framed prompt: who the Bot is in this room, and what just happened. */
export function promptFor({ room, member, message, lines, nameOf = nameOfSlug }: {
  room: Room;
  member: RoomMember;
  message: RoomMessage;
  lines: string[];
  nameOf?: (slug: string) => string;
}): string {
  const others = room.members.filter((candidate) => candidate.slug !== member.slug).map((candidate) => nameOf(candidate.slug));
  const header = `[Room "#${room.name}" · with ${others.join(", ") || "the user"}]`;
  const intro = `You are ${nameOf(member.slug)}, in a room with the user${others.length ? ` and ${others.join(", ")}` : ""}. `
    + "This is a shared conversation, not your private chat: keep private details from your one-to-one chats out of it. "
    + "Your final reply of this turn is the one message the room sees; keep it short. "
    + "If the user addresses you directly, answer briefly even if it is a single line; reply exactly \"(pass)\" only when the message is for the room in general and you have nothing to add.";
  const about = [room.description, room.guidance].filter((part) => part && part.trim() !== "").join("\n");
  const mode = room.settings.mode === "roundtable"
    ? "Members speak in order and you see what they said before you in this turn. @mention a teammate only when you need their answer: it brings them back in."
    : "Teammates in this room answer independently; they do not see your reply, and mentioning a teammate here does not wake it.";
  const body = lines.length > 0 ? `Recent room:\n${lines.join("\n")}` : "";
  const quote = message.replyTo ? "[replying to a message from the room]" : "";
  // The message being answered is always there in full, even when it waited in the queue behind a
  // turn the member already answered.
  const asked = message.text.trim() ? `The user's message:\n${message.text.trim()}` : "";
  return [header, intro, about, mode, body, quote, asked, `It's your turn, ${nameOf(member.slug)}.`]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * Members a wave brings back in: the teammates a reply @mentions, or everyone but the speaker for
 * `@all`. Only ready members, and only when the room allows cross-mentions.
 */
export function crossMentions(replies: { slug: string; text: string }[], room: Room, nameOf: (slug: string) => string = nameOfSlug): RoomMember[] {
  const available = room.members.filter((member) => member.status !== "unavailable");
  const roster = available.map((member) => ({ slug: member.slug, name: nameOf(member.slug) }));
  const next = new Map<string, RoomMember>();
  for (const reply of replies) {
    const { slugs, all } = addressedMembers(reply.text, roster, "anywhere");
    if (all) {
      for (const member of available) if (member.slug !== reply.slug) next.set(member.slug, member);
      continue;
    }
    for (const slug of slugs) {
      const member = available.find((candidate) => candidate.slug === slug);
      if (member && member.slug !== reply.slug) next.set(member.slug, member);
    }
  }
  return [...next.values()];
}

export function createRoomEngine({ rooms, rpc, bots, defaults, notify, log = () => {}, pollMs = 1_000, nowMs = () => Date.now() }: EngineDeps) {
  /** One entry per room with a turn in flight. */
  const active = new Map<string, ActiveTurn>();
  /** Messages waiting behind the active turn, in arrival order. */
  const queues = new Map<string, QueuedMessage[]>();
  /** Display names resolved from the Bot list, refreshed on every turn. */
  const names = new Map<string, string>();
  const nameOf = (slug: string) => names.get(slug) ?? slug;

  /**
   * Everything the room has said: the user's turns plus every member's completed replies, in time
   * order. `linesFor` then cuts it at the member's own last turn. Only runs the room recorded count:
   * a message the user sends directly in a member's thread stays out of the room.
   */
  async function readHistory(room: Room): Promise<RoomLine[]> {
    const history: RoomLine[] = room.turns
      .filter((turn) => turn.text.trim() !== "")
      .map((turn) => ({ at: turn.at, author: { kind: "user" as const }, text: clip(turn.text.trim(), 1_200) }));
    const knownRuns = new Set(room.turns.flatMap((turn) => turn.runs.flatMap((run) => (run.runId ? [run.runId] : []))));
    const people = [...room.members, ...room.formerMembers];
    const seenThreads = new Set<string>();
    await Promise.all(people.map(async (member) => {
      const threadId = member.threadId;
      if (!threadId || seenThreads.has(threadId)) return;
      seenThreads.add(threadId);
      const projection = (await rpc.call("orchestration.getThreadProjection", { threadId }).catch(() => null)) as Projection;
      const latest = new Map<string, ReplyItem>();
      for (const item of projection?.turnItems ?? []) {
        if ((item.type !== "assistant_message" && item.type !== "assistant") || item.status !== "completed") continue;
        if (!item.runId || !knownRuns.has(item.runId) || typeof item.text !== "string" || item.text.trim() === "") continue;
        const previous = latest.get(item.runId);
        if (!previous || (item.ordinal ?? 0) >= (previous.ordinal ?? 0)) latest.set(item.runId, item);
      }
      for (const item of latest.values()) {
        const text = String(item.text).trim();
        if (isPass(text)) continue;
        history.push({
          at: item.completedAt ?? item.updatedAt ?? "",
          author: { kind: "bot", slug: member.slug, name: nameOf(member.slug) },
          text: clip(text, 1_200),
        });
      }
    }));
    return history
      .filter((line) => (Date.parse(line.at) || 0) > 0)
      .sort((left, right) => (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0));
  }

  async function ensureThread(room: Room, member: RoomMember, roster: Map<string, RoomBot>, launchDefaults: LaunchDefaults): Promise<RoomMember> {
    if (member.threadId) return member;
    const bot = roster.get(member.slug);
    if (!bot) throw new Error(`unknown Bot: ${member.slug}`);
    const launched = await launchRoomThread({ rpc, room, slug: member.slug, bot, settings: room.settings, defaults: launchDefaults });
    const updated = await rooms.setMember(room.id, member.slug, {
      threadId: launched.threadId,
      status: "ready",
      model: launched.modelSelection,
      runtimeMode: launched.runtimeMode,
    });
    return updated.members.find((candidate) => candidate.slug === member.slug) ?? member;
  }

  /**
   * Waits until the run behind `messageId` is terminal, the turn is stopped, or the deadline passes.
   * `onWaiting` fires once if the member stops for an approval, a question or a secret.
   */
  async function waitForRun(
    threadId: string,
    messageId: string,
    deadline: number,
    aborted: () => boolean,
    hooks: { onRun?: (runId: string) => void; onWaiting?: () => void } = {},
  ): Promise<{ status: string; runId: string | null; reply: { id: string; text: string; at: string | null } | null }> {
    let runId: string | null = null;
    let announced = false;
    let waiting = false;
    for (;;) {
      if (aborted()) return { status: "stopped", runId, reply: null };
      const projection = (await rpc.call("orchestration.getThreadProjection", { threadId }).catch(() => null)) as Projection;
      const runs = projection?.runs ?? [];
      const run = runs.find((candidate) => candidate.userMessageId === messageId) ?? null;
      if (run && run.id !== runId) {
        runId = run.id;
        if (!announced) { announced = true; hooks.onRun?.(run.id); }
      }
      if (run?.status === "waiting" && !waiting) {
        waiting = true;
        hooks.onWaiting?.();
      }
      if (run && TERMINAL.has(run.status)) {
        const reply = pickReply(projection?.turnItems ?? [], run.id);
        return { status: run.status, runId: run.id, reply: reply ? { ...reply, text: reply.text.trim() } : null };
      }
      if (nowMs() >= deadline || pollMs <= 0) break;
      await sleep(pollMs);
    }
    return { status: "timeout", runId, reply: null };
  }

  async function runTurn(roomId: string, turn: RoomTurn, message: RoomMessage): Promise<void> {
    const state = active.get(roomId);
    const room = await rooms.get(roomId);
    if (!state || state.turnId !== turn.id) return;
    if (!room) {
      if (active.get(roomId)?.turnId === turn.id) active.delete(roomId);
      void drain(roomId);
      return;
    }

    const roster = await bots();
    for (const [slug, bot] of roster) names.set(slug, bot.name);
    // A member whose Bot was deleted (or can no longer join) never answers, even as the lead.
    room.members = room.members.map((member) => (roster.has(member.slug) ? member : { ...member, status: "unavailable" as const }));
    for (const former of room.formerMembers) if (!names.has(former.slug) && former.name) names.set(former.slug, former.name);
    const launchDefaults = await defaults();
    const history = await readHistory(room);
    const started = nowMs();
    // Two clocks: one message may not hold the room forever, and each member gets its own wait.
    const turnDeadline = started + room.settings.turnDeadlineMin * 60_000;
    const memberTimeoutMs = room.settings.memberTimeoutMin * 60_000;
    const roundtable = room.settings.mode === "roundtable";
    const maxWaves = roundtable ? room.settings.maxWaves : 1;
    const budget = Math.max(1, room.settings.maxReplies);
    /** Every time a member spoke in this turn, in order: a roundtable can bring a member back in. */
    const parts: RoomRun[] = [];
    /** What this turn has said so far, in order: the roundtable's shared floor. */
    const spoken: { slug: string; text: string }[] = [];
    let said = 0;
    let wave = 0;

    const speakOne = async (candidate: RoomMember): Promise<void> => {
      const at = () => new Date(nowMs()).toISOString();
      const part: RoomRun = { slug: candidate.slug, runId: null };
      parts.push(part);
      try {
        const member = await ensureThread(room, candidate, roster, launchDefaults);
        if (!member.threadId) throw new Error("the member has no thread");
        const messageId = randomUUID();
        state.threads.set(member.slug, member.threadId);
        // The member's own unseen user messages, then — in a roundtable — what was said before it.
        const floor = roundtable ? spoken.filter((line) => line.slug !== member.slug).map((line) => `${nameOf(line.slug)}: ${line.text}`) : [];
        // The user's messages from this one on are not history: this one is quoted in full below,
        // and later ones are still waiting in the queue.
        const before = history.filter((line) => line.author.kind !== "user" || line.at < turn.at);
        if (state.abort) throw new StoppedError();
        await rpc.dispatch({
          type: "message.dispatch",
          threadId: member.threadId,
          messageId,
          text: promptFor({ room, member, message, lines: [...linesFor(room, member, before), ...floor], nameOf }),
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
        });
        // Stop may have run while this message was on its way; it could not stop a run that did not exist yet.
        if (state.abort) {
          await rpc.dispatch({ type: "thread.stop", threadId: member.threadId, stopDelegatedTasks: true }).catch(() => {});
          throw new StoppedError();
        }
        // Each member gets its own wait. In a roundtable the fifth speaker must not inherit the
        // seconds the first four left from one shared deadline.
        const memberDeadline = Math.min(turnDeadline, nowMs() + memberTimeoutMs);
        const result = await waitForRun(member.threadId, messageId, memberDeadline, () => state.abort || active.get(roomId)?.turnId !== turn.id, {
          onRun: (runId) => { void rooms.setTurnRun(roomId, turn.id, member.slug, runId).catch(() => {}); },
          onWaiting: () => {
            if (!room.settings.notifications) return;
            void Promise.resolve(notify?.({
              title: `#${room.name}`,
              body: `${nameOf(member.slug)} is waiting for you`,
              url: `/?room=${room.id}`,
            })).catch(() => {});
          },
        });
        part.runId = result.runId;
        if (result.status === "timeout" && result.runId) {
          part.late = true;
          await rooms.markRunLate(roomId, turn.id, member.slug, result.runId).catch(() => {});
        }
        const replied = result.reply && !isPass(result.reply.text) ? result.reply.text : null;
        if (replied) {
          said += 1;
          spoken.push({ slug: member.slug, text: clip(replied, 1_200) });
        }
        Object.assign(part, { at: at(), status: result.status === "completed"
          ? (replied ? "replied" : result.reply ? "passed" : "no-reply")
          : result.status === "timeout"
            ? "timeout"
            : result.status === "stopped"
              ? "stopped"
              : "failed" });
        await rooms.setMember(roomId, member.slug, { lastTurnAt: (replied ? result.reply?.at : null) ?? at() });
        log(`[rooms] ${room.name}: ${member.slug} ${result.status === "timeout" ? "late" : result.status}${replied ? "" : " (no reply)"}`);
      } catch (err) {
        if (err instanceof StoppedError) {
          Object.assign(part, { status: "stopped", at: at() });
          return;
        }
        log(`[rooms] ${room.name}: ${candidate.slug} failed: ${(err as Error).message}`);
        Object.assign(part, { status: "failed", error: clip((err as Error).message, 200), at: at() });
      }
    };

    const runList = (): RoomRun[] => parts.map((part) => ({ ...part }));
    const statusAfter = (): RoomTurn["status"] => {
      if (state.abort) return "stopped";
      const list = parts.filter((part) => part.status !== undefined);
      const everyFailed = list.length > 0 && list.every((outcome) => outcome.status === "failed" || outcome.status === "timeout" || outcome.status === "stopped");
      return everyFailed ? "failed" : "done";
    };

    try {
      let speakers = speakersFor(room, message, nameOf);
      if (roundtable) {
        const turnIndex = Math.max(0, room.turns.findIndex((candidate) => candidate.id === turn.id));
        speakers = rotateSpeakers(speakers, turnIndex);
      }
      while (!state.abort && speakers.length > 0 && wave < maxWaves && said < budget && nowMs() < turnDeadline) {
        wave += 1;
        const batch = speakers.slice(0, Math.max(1, budget - said));
        const heard = spoken.length;
        if (roundtable) {
          // A roundtable hears itself: one at a time, in room order, so each reply can be answered.
          for (const member of batch) {
            // The time limit counts before each Bot, not only between rounds: a dispatch past it is wasted.
            if (state.abort || said >= budget || nowMs() >= turnDeadline) break;
            await speakOne(member);
          }
        } else {
          await Promise.all(batch.map((member) => speakOne(member)));
        }
        if (!roundtable || !room.settings.allowCrossMentions || state.abort) break;
        // A reply that @mentions a teammate brings it back in, even one that already spoke; the
        // round, reply and time limits bound it.
        speakers = crossMentions(spoken.slice(heard), room, nameOf);
      }

      const finalStatus = statusAfter();
      await rooms.patchTurn(roomId, turn.id, { runs: runList(), status: finalStatus });

      if (room.settings.notifications && finalStatus !== "stopped" && spoken.length > 0) {
        const last = spoken.at(-1)!;
        await Promise.resolve(notify?.({
          title: `#${room.name}`,
          body: clip(last.text.replace(/\s+/g, " "), 140),
          url: `/?room=${room.id}`,
        })).catch(() => {});
      }
    } catch (err) {
      log(`[rooms] turn failed: ${(err as Error).message}`);
      await rooms.patchTurn(roomId, turn.id, { runs: runList(), status: state.abort ? "stopped" : "failed" }).catch(() => {});
    } finally {
      // Only this turn may release the room: a Stop followed by a new message must not have its
      // successor's active entry deleted by the turn that is still unwinding.
      if (active.get(roomId)?.turnId === turn.id) active.delete(roomId);
      void drain(roomId);
    }
  }

  /** Marks the turn running and lets it run in the background. The caller owns the active slot. */
  async function begin(roomId: string, turn: RoomTurn, message: RoomMessage): Promise<void> {
    if (active.get(roomId)?.turnId !== turn.id) {
      // A Stop won the race while the message was being written.
      await rooms.patchTurn(roomId, turn.id, { status: "stopped" }).catch(() => {});
      return;
    }
    await rooms.patchTurn(roomId, turn.id, { status: "running" });
    void runTurn(roomId, turn, message).catch((err) => {
      log(`[rooms] turn failed: ${(err as Error).message}`);
      void rooms.patchTurn(roomId, turn.id, { status: "failed" }).catch(() => {});
      if (active.get(roomId)?.turnId === turn.id) active.delete(roomId);
      void drain(roomId);
    });
  }

  /** Runs the next queued message, if any. */
  async function drain(roomId: string): Promise<void> {
    if (active.has(roomId)) return;
    const queue = queues.get(roomId);
    const next = queue?.shift();
    if (!queue || queue.length === 0) queues.delete(roomId);
    if (!next) return;
    // Reserve the room before the first await: a send or another drain must not start a turn meanwhile.
    active.set(roomId, { turnId: next.turnId, abort: false, threads: new Map() });
    const room = await rooms.get(roomId);
    const turn = room?.turns.find((candidate) => candidate.id === next.turnId);
    if (!turn || turn.status !== "queued") {
      if (active.get(roomId)?.turnId === next.turnId) active.delete(roomId);
      void drain(roomId);
      return;
    }
    try {
      await begin(roomId, turn, next.message);
    } catch (err) {
      log(`[rooms] queued turn failed to start: ${(err as Error).message}`);
      if (active.get(roomId)?.turnId === turn.id) active.delete(roomId);
      await rooms.patchTurn(roomId, turn.id, { status: "failed" }).catch(() => {});
      void drain(roomId);
    }
  }

  return {
    isBusy: (roomId: string) => active.has(roomId),
    queued: (roomId: string) => queues.get(roomId)?.length ?? 0,

    /**
     * A message sent while a turn runs is written down as `queued` and waits its turn, like the
     * one-to-one composer's queue. The record is persisted before the turn starts, so the room
     * shows it immediately and a reload/another device sees it too.
     */
    async send(roomId: string, message: RoomMessage): Promise<{ turn: RoomTurn; queued: boolean }> {
      const room = await rooms.get(roomId);
      if (!room) throw new Error("no such room");
      const clean = { ...message, text: String(message.text ?? "").trim() };
      if (!clean.text && !message.mentions?.length) throw new Error("a room message needs text");
      const turn: RoomTurn = {
        id: randomUUID(),
        at: new Date().toISOString(),
        text: clean.text,
        mentions: clean.mentions ?? [],
        replyTo: clean.replyTo ?? null,
        status: "queued",
        runs: [],
      };
      // Reserve before the first write: two sends in the same tick must not both start a turn.
      const busy = active.has(roomId);
      if (!busy) active.set(roomId, { turnId: turn.id, abort: false, threads: new Map() });
      try {
        await rooms.appendTurn(roomId, turn);
      } catch (err) {
        if (active.get(roomId)?.turnId === turn.id) active.delete(roomId);
        void drain(roomId);
        throw err;
      }
      if (busy) {
        const queue = queues.get(roomId) ?? [];
        queue.push({ turnId: turn.id, message: clean });
        queues.set(roomId, queue);
        // The turn we queued behind may have finished while this message was being written: its
        // finally drained an empty queue and would leave this one stranded.
        if (!active.has(roomId)) void drain(roomId);
        return { turn, queued: true };
      }
      try {
        await begin(roomId, turn, clean);
      } catch (err) {
        if (active.get(roomId)?.turnId === turn.id) active.delete(roomId);
        await rooms.patchTurn(roomId, turn.id, { status: "failed" }).catch(() => {});
        void drain(roomId);
        throw err;
      }
      return { turn, queued: false };
    },

    /** Stop interrupts the members that are answering and clears the queue. */
    async stop(roomId: string): Promise<boolean> {
      const state = active.get(roomId);
      queues.delete(roomId);
      await rooms.stopQueued(roomId).catch(() => null);
      if (!state) return false;
      state.abort = true;
      await Promise.all([...state.threads.values()].map((threadId) =>
        threadId ? rpc.dispatch({ type: "thread.stop", threadId, stopDelegatedTasks: true }).catch(() => {}) : null
      ));
      const room = await rooms.get(roomId);
      const turn = room?.turns.find((candidate) => candidate.id === state.turnId);
      // A turn that already ended keeps its own verdict; Stop must not rewrite a completed turn.
      if (turn?.status === "running" || turn?.status === "queued") {
        await rooms.patchTurn(roomId, state.turnId, { status: "stopped" });
      }
      if (active.get(roomId)?.turnId === state.turnId) active.delete(roomId);
      return true;
    },

    /** A turn that was running or queued when the gateway stopped does not resume. */
    async recover(): Promise<string[]> {
      const interrupted = await rooms.interruptRunning();
      if (interrupted.length > 0) log(`[rooms] marked ${interrupted.length} turn(s) interrupted`);
      return interrupted;
    },
  };
}

export type RoomEngine = ReturnType<typeof createRoomEngine>;
