// The room turn engine. A room runs one turn at a time: address the members the user asked for,
// dispatch the framed prompt to each of their room threads, wait for their runs, read the replies
// and store what the room needs (status, run ids, last reply time). Bot replies are never copied
// into rooms.json: they stay in their threads.
import { randomUUID } from "node:crypto";
import { addressedMembers, clip, formatRoomLine, isPass, pickReply, type ReplyItem, type RoomLine } from "./room-lines.mts";
import { launchRoomThread, type LaunchDefaults, type RoomBot, type RoomRpc } from "./rooms-threads.mts";
import type { Room, RoomMember, RoomTurn, RoomsStore } from "./rooms.mts";

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

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOfSlug = (slug: string) => slug;

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
 * The framed prompt: who the Bot is in this room, and what just happened.
 */
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
    + "This is not your private chat: don't reveal private context and don't update memory unless the user asks. "
    + "Your final reply of this turn is the one message the room sees; keep it short. "
    + "If the user addresses you directly, answer briefly even if it is a single line; reply exactly \"(pass)\" only when the message is for the room in general and you have nothing to add.";
  const about = [room.description, room.guidance].filter((part) => part && part.trim() !== "").join("\n");
  const mode = "Teammates in this room answer independently; they do not see your reply, and mentioning a teammate here does not wake it.";
  const body = lines.length > 0 ? `Recent room:\n${lines.join("\n")}` : "";
  const quote = message.replyTo ? "[replying to a message from the room]" : "";
  return [header, intro, about, mode, body, quote, `It's your turn, ${nameOf(member.slug)}.`]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function createRoomEngine({ rooms, rpc, bots, defaults, notify, log = () => {}, pollMs = 1_000, nowMs = () => Date.now() }: EngineDeps) {
  /** One entry per room with a turn in flight. */
  const active = new Map<string, { turnId: string; abort: boolean; threads: Map<string, string | null> }>();
  const queues = new Map<string, RoomMessage[]>();
  /** Display names resolved from the Bot list, refreshed on every turn. */
  const names = new Map<string, string>();
  const nameOf = (slug: string) => names.get(slug) ?? slug;

  /**
   * Everything the room has said: the user's turns plus every member's completed replies, in time
   * order. `linesFor` then cuts it at the member's own last turn. Reading each thread once per
   * turn is what lets a member see what its teammates said in earlier turns, not only the user.
   */
  async function readHistory(room: Room): Promise<RoomLine[]> {
    const history: RoomLine[] = room.turns
      .filter((turn) => turn.text.trim() !== "")
      .map((turn) => ({ at: turn.at, author: { kind: "user" as const }, text: turn.text.trim() }));
    await Promise.all(room.members.map(async (member) => {
      const threadId = member.threadId;
      if (!threadId) return;
      const projection = (await rpc.call("orchestration.getThreadProjection", { threadId }).catch(() => null)) as Projection;
      const latest = new Map<string, ReplyItem>();
      for (const item of projection?.turnItems ?? []) {
        if ((item.type !== "assistant_message" && item.type !== "assistant") || item.status !== "completed") continue;
        if (!item.runId || typeof item.text !== "string" || item.text.trim() === "") continue;
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

  /** Waits until the run behind `messageId` is terminal, the turn is stopped, or the deadline passes. */
  async function waitForRun(threadId: string, messageId: string, deadline: number, aborted: () => boolean, onRun?: (runId: string) => void): Promise<{ status: string; runId: string | null; reply: { id: string; text: string; at: string | null } | null }> {
    let runId: string | null = null;
    let announced = false;
    for (;;) {
      if (aborted()) return { status: "stopped", runId, reply: null };
      const projection = (await rpc.call("orchestration.getThreadProjection", { threadId }).catch(() => null)) as Projection;
      const runs = projection?.runs ?? [];
      const run = runs.find((candidate) => candidate.userMessageId === messageId) ?? null;
      if (run && run.id !== runId) {
        runId = run.id;
        if (!announced) { announced = true; onRun?.(run.id); }
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
    if (!state || !room) return;
    const roster = await bots();
    for (const [slug, bot] of roster) names.set(slug, bot.name);
    const launchDefaults = await defaults();
    const history = await readHistory(room);
    const started = nowMs();
    // Two clocks: one member may not hold the turn forever, and the turn itself stops opening rounds.
    const turnDeadline = started + room.settings.turnDeadlineMin * 60_000;
    const deadline = Math.min(turnDeadline, started + room.settings.memberTimeoutMin * 60_000);
    const budget = Math.max(1, room.settings.maxReplies);
    /** One run per member, the latest one; `null` when the member could not start. */
    const runs = new Map<string, string | null>();
    /** What this turn has said so far, in order: the push preview reads the last one. */
    const spoken: { slug: string; text: string }[] = [];

    const speakOne = async (candidate: RoomMember): Promise<void> => {
      try {
        const member = await ensureThread(room, candidate, roster, launchDefaults);
        if (!member.threadId) throw new Error("the member has no thread");
        const messageId = randomUUID();
        state.threads.set(member.slug, member.threadId);
        await rpc.dispatch({
          type: "message.dispatch",
          threadId: member.threadId,
          messageId,
          text: promptFor({ room, member, message, lines: linesFor(room, member, history), nameOf }),
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
        });
        const result = await waitForRun(member.threadId, messageId, deadline, () => state.abort, (runId) => {
          void rooms.setTurnRun(roomId, turn.id, member.slug, runId).catch(() => {});
        });
        runs.set(member.slug, result.runId);
        const replied = result.reply && !isPass(result.reply.text) ? result.reply.text : null;
        if (replied) {
          spoken.push({ slug: member.slug, text: clip(replied, 1_200) });
        }
        await rooms.setMember(roomId, member.slug, { lastTurnAt: (replied ? result.reply?.at : null) ?? new Date(nowMs()).toISOString() });
        log(`[rooms] ${room.name}: ${member.slug} ${result.status}${replied ? "" : " (no reply)"}`);
      } catch (err) {
        log(`[rooms] ${room.name}: ${candidate.slug} failed: ${(err as Error).message}`);
        runs.set(candidate.slug, null);
      }
    };

    // A panel dispatches every addressed member at once and reads their replies as they land.
    const speakers = speakersFor(room, message, nameOf).slice(0, budget);
    if (!state.abort && nowMs() < turnDeadline) await Promise.all(speakers.map((member) => speakOne(member)));

    const runList = [...runs].map(([slug, runId]) => ({ slug, runId }));
    const failed = runList.length > 0 && runList.every((run) => run.runId === null);
    const status: RoomTurn["status"] = state.abort ? "stopped" : failed ? "failed" : "done";
    await rooms.patchTurn(roomId, turn.id, { runs: runList, status });
    active.delete(roomId);

    if (room.settings.notifications && status !== "stopped" && spoken.length > 0) {
      const last = spoken.at(-1)!;
      await Promise.resolve(notify?.({
        title: `#${room.name}`,
        body: clip(last.text, 140),
        url: `/?room=${room.id}`,
      })).catch(() => {});
    }
    void drain(roomId);
  }

  async function start(roomId: string, message: RoomMessage): Promise<RoomTurn | null> {
    const room = await rooms.get(roomId);
    if (!room) return null;
    const turn: RoomTurn = {
      id: randomUUID(),
      at: new Date().toISOString(),
      text: message.text,
      mentions: message.mentions ?? [],
      replyTo: message.replyTo ?? null,
      status: "running",
      runs: [],
    };
    await rooms.appendTurn(roomId, turn);
    active.set(roomId, { turnId: turn.id, abort: false, threads: new Map() });
    void runTurn(roomId, turn, message).catch((err) => {
      log(`[rooms] turn failed: ${(err as Error).message}`);
      active.delete(roomId);
    });
    return turn;
  }

  /** Runs the next queued message, if any. */
  async function drain(roomId: string): Promise<void> {
    if (active.has(roomId)) return;
    const queue = queues.get(roomId);
    const next = queue?.shift();
    if (!queue || queue.length === 0) queues.delete(roomId);
    if (!next) return;
    await start(roomId, next);
  }

  return {
    isBusy: (roomId: string) => active.has(roomId),

    /** A message sent while a turn runs waits its turn, like the one-to-one composer's queue. */
    async send(roomId: string, message: RoomMessage): Promise<{ turn: RoomTurn; queued: boolean }> {
      const room = await rooms.get(roomId);
      if (!room) throw new Error("no such room");
      const clean = { ...message, text: String(message.text ?? "").trim() };
      if (!clean.text && !message.mentions?.length) throw new Error("a room message needs text");
      if (active.has(roomId)) {
        const queue = queues.get(roomId) ?? [];
        queue.push(clean);
        queues.set(roomId, queue);
        return {
          turn: { id: randomUUID(), at: new Date().toISOString(), text: clean.text, mentions: clean.mentions ?? [], replyTo: clean.replyTo ?? null, status: "running", runs: [] },
          queued: true,
        };
      }
      const turn = await start(roomId, clean);
      if (!turn) throw new Error("no such room");
      return { turn, queued: false };
    },

    /** Stop interrupts the members that are answering and clears the queue. */
    async stop(roomId: string): Promise<boolean> {
      const state = active.get(roomId);
      queues.delete(roomId);
      if (!state) return false;
      state.abort = true;
      await Promise.all([...state.threads.values()].map((threadId) =>
        threadId ? rpc.dispatch({ type: "thread.stop", threadId, stopDelegatedTasks: true }).catch(() => {}) : null
      ));
      await rooms.patchTurn(roomId, state.turnId, { status: "stopped" });
      active.delete(roomId);
      return true;
    },

    /** A turn that was running when the gateway stopped does not resume. */
    async recover(): Promise<string[]> {
      const interrupted = await rooms.interruptRunning();
      if (interrupted.length > 0) log(`[rooms] marked ${interrupted.length} turn(s) interrupted`);
      return interrupted;
    },
  };
}

export type RoomEngine = ReturnType<typeof createRoomEngine>;
