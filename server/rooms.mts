// Rooms: a named conversation between the user and several Bots.
// The record holds what T3 does not keep for a group: membership, settings and a bounded index of
// the user's messages. Bot replies are never stored here; they live in each member's T3 thread.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 8;
/** The turn index keeps this many user messages per room; the newest win. */
export const MAX_TURNS = 200;
export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 200;
export const MAX_GUIDANCE = 2_000;

export const RUNTIME_MODES = ["inherit", "approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export const ROOM_MODES = ["panel", "roundtable"] as const;
export const RESPONDERS = ["lead", "everyone", "mentions"] as const;
export const MENTION_POLICIES = ["anywhere", "leading"] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export type RoomMode = (typeof ROOM_MODES)[number];
export type DefaultResponder = (typeof RESPONDERS)[number];
export type MentionPolicy = (typeof MENTION_POLICIES)[number];

export type RoomSettings = {
  mode: RoomMode;
  defaultResponder: DefaultResponder;
  /** Member slug that answers when nobody is mentioned and the responder is `lead`. */
  lead: string;
  /** `inherit` keeps each Bot's own runtime mode; resolved once, when its thread is created. */
  runtimeMode: RuntimeMode;
  /** `inherit` keeps each Bot's own model, or a T3 model selection applied to every member. */
  model: unknown;
  mentionPolicy: MentionPolicy;
  allowCrossMentions: boolean;
  maxWaves: number;
  maxReplies: number;
  memberTimeoutMin: number;
  turnDeadlineMin: number;
  notifications: boolean;
};

export const DEFAULT_SETTINGS: Omit<RoomSettings, "lead"> = {
  mode: "panel",
  defaultResponder: "lead",
  runtimeMode: "inherit",
  model: "inherit",
  mentionPolicy: "anywhere",
  allowCrossMentions: true,
  maxWaves: 3,
  maxReplies: 10,
  memberTimeoutMin: 10,
  turnDeadlineMin: 20,
  notifications: true,
};

export type RoomMemberStatus = "pending" | "ready" | "unavailable";
export type RoomMember = {
  slug: string;
  /** Null until its room thread is launched. */
  threadId: string | null;
  status: RoomMemberStatus;
  /** Resolved from the room settings (or the Bot's own) when the thread was created. */
  model: unknown;
  runtimeMode: string;
  /** When the room last showed a reply from this member; the prompt shows lines after it. */
  lastTurnAt: string | null;
  addedAt: string;
};

export type RoomTurnStatus = "running" | "done" | "stopped" | "interrupted" | "failed";
export type RoomRun = {
  slug: string;
  runId: string | null;
  /** The member passed `memberTimeoutMin`; its reply may still arrive, but it opens no wave. */
  late?: boolean;
};
export type RoomTurn = {
  id: string;
  at: string;
  text: string;
  mentions: string[];
  replyTo: string | null;
  status: RoomTurnStatus;
  runs: RoomRun[];
};

export type Room = {
  id: string;
  name: string;
  description: string;
  guidance: string;
  section: string | null;
  pinned: boolean;
  createdAt: string;
  settings: RoomSettings;
  members: RoomMember[];
  turns: RoomTurn[];
};

/** What a route needs to validate a member list: the slug and the name the user will type. */
export type BotIdentity = { slug: string; name: string };

export class RoomsError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RoomsError";
    this.status = status;
  }
}

type RoomsFile = { version: 1; rooms: Room[] };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const int = (value: unknown, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RoomsError(`must be a whole number between ${min} and ${max}`);
  }
  return parsed;
};

/** Room name: required, trimmed, one line. */
export function normalizeName(value: unknown): string {
  const name = text(value).replace(/\s+/g, " ");
  if (!name) throw new RoomsError("a room needs a name");
  if (name.length > MAX_NAME) throw new RoomsError(`the name is longer than ${MAX_NAME} characters`);
  return name;
}

export function normalizeText(value: unknown, max: number, field: string): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (body.length > max) throw new RoomsError(`${field} is longer than ${max} characters`);
  return body;
}

/**
 * Merges a settings patch over the current settings (or the defaults) and validates the result.
 * `lead` must be one of the member slugs given here.
 */
export function normalizeSettings(patch: unknown, members: string[], current?: RoomSettings): RoomSettings {
  const base: RoomSettings = current ?? { ...DEFAULT_SETTINGS, lead: members[0] ?? "" };
  const input = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const pick = <T,>(key: keyof RoomSettings, allowed: readonly T[], fallback: T): T => {
    const value = input[key];
    if (value === undefined) return current ? (current[key] as T) ?? fallback : fallback;
    if (!allowed.includes(value as T)) throw new RoomsError(`settings.${String(key)} must be one of ${allowed.join(", ")}`);
    return value as T;
  };
  const settings: RoomSettings = {
    mode: pick("mode", ROOM_MODES, base.mode),
    defaultResponder: pick("defaultResponder", RESPONDERS, base.defaultResponder),
    lead: current && input.lead === undefined ? current.lead : String(input.lead ?? base.lead),
    runtimeMode: pick("runtimeMode", RUNTIME_MODES, base.runtimeMode),
    model: input.model === undefined ? base.model : input.model,
    mentionPolicy: pick("mentionPolicy", MENTION_POLICIES, base.mentionPolicy),
    allowCrossMentions: input.allowCrossMentions === undefined ? base.allowCrossMentions : input.allowCrossMentions === true,
    maxWaves: input.maxWaves === undefined ? base.maxWaves : int(input.maxWaves, 1, 5),
    maxReplies: input.maxReplies === undefined ? base.maxReplies : int(input.maxReplies, 1, 20),
    memberTimeoutMin: input.memberTimeoutMin === undefined ? base.memberTimeoutMin : int(input.memberTimeoutMin, 1, 60),
    turnDeadlineMin: input.turnDeadlineMin === undefined ? base.turnDeadlineMin : int(input.turnDeadlineMin, 1, 120),
    notifications: input.notifications === undefined ? base.notifications : input.notifications === true,
  };
  if (members.length > 0 && !members.includes(settings.lead)) {
    throw new RoomsError("settings.lead must be one of the room's members");
  }
  if (!settings.lead && members.length > 0) settings.lead = members[0];
  return settings;
}

/**
 * Members are Bots, 2 to 8 of them, and their names must be unique inside the room: an `@Name` in
 * the room has to resolve to exactly one member.
 */
export function validateMembers(slugs: unknown, bots: BotIdentity[]): BotIdentity[] {
  if (!Array.isArray(slugs)) throw new RoomsError("members must be a list of Bot slugs");
  const unique = [...new Set(slugs.map((slug) => text(slug)).filter(Boolean))];
  if (unique.length < MIN_MEMBERS) throw new RoomsError(`a room needs at least ${MIN_MEMBERS} members`);
  if (unique.length > MAX_MEMBERS) throw new RoomsError(`a room holds at most ${MAX_MEMBERS} members`);
  const bySlug = new Map(bots.map((bot) => [bot.slug, bot]));
  const resolved: BotIdentity[] = [];
  for (const slug of unique) {
    const bot = bySlug.get(slug);
    if (!bot) throw new RoomsError(`unknown Bot: ${slug}`);
    resolved.push(bot);
  }
  const seen = new Map<string, string>();
  for (const bot of resolved) {
    const key = bot.name.trim().toLowerCase();
    const other = seen.get(key);
    if (other) throw new RoomsError(`two members are called ${bot.name}; a room needs unique names`);
    seen.set(key, bot.slug);
  }
  return resolved;
}

/** A member starts `pending`; the launcher fills in its thread and model. */
export function pendingMember(slug: string, at: string): RoomMember {
  return { slug, threadId: null, status: "pending", model: null, runtimeMode: "inherit", lastTurnAt: null, addedAt: at };
}

export type CreateRoomInput = {
  name: unknown;
  description?: unknown;
  guidance?: unknown;
  section?: unknown;
  pinned?: unknown;
  members: BotIdentity[];
  settings?: unknown;
};

/**
 * The rooms file: one writer, serialized, atomic (temp file + rename) and mode 0600.
 * Reads are cached in memory; every write replaces the cache.
 */
export function createRooms({ file, now = () => new Date().toISOString(), newId = () => randomBytes(4).toString("hex") }: {
  file: string;
  now?: () => string;
  newId?: () => string;
}) {
  let cache: RoomsFile | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<RoomsFile> {
    if (cache) return cache;
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<RoomsFile>;
      const rooms = Array.isArray(raw.rooms) ? raw.rooms.filter((room): room is Room => !!room && typeof room.id === "string") : [];
      cache = { version: 1, rooms: rooms.map((room) => ({ ...room, turns: Array.isArray(room.turns) ? room.turns : [] })) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      cache = { version: 1, rooms: [] };
    }
    return cache;
  }

  async function save(next: RoomsFile): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmp, file);
    cache = next;
  }

  /** Every mutation runs after the previous one finished, so two writes cannot interleave. */
  function serialize<T>(work: (state: RoomsFile) => Promise<T> | T): Promise<T> {
    const run = queue.then(async () => {
      const state = await load();
      return work(state);
    });
    queue = run.catch(() => {});
    return run;
  }

  const clone = (room: Room): Room => JSON.parse(JSON.stringify(room)) as Room;

  return {
    file,
    async list(): Promise<Room[]> {
      const state = await load();
      return state.rooms.map(clone);
    },
    async get(id: string): Promise<Room | null> {
      const state = await load();
      const room = state.rooms.find((candidate) => candidate.id === id);
      return room ? clone(room) : null;
    },
    async find(predicate: (room: Room) => boolean): Promise<Room | null> {
      const state = await load();
      const room = state.rooms.find(predicate);
      return room ? clone(room) : null;
    },
    async create(input: CreateRoomInput): Promise<Room> {
      return serialize((state) => {
        const members = input.members.map((bot) => pendingMember(bot.slug, now()));
        const settings = normalizeSettings(input.settings, members.map((member) => member.slug));
        const room: Room = {
          id: newId(),
          name: normalizeName(input.name),
          description: normalizeText(input.description, MAX_DESCRIPTION, "the description"),
          guidance: normalizeText(input.guidance, MAX_GUIDANCE, "the guidance"),
          section: typeof input.section === "string" && input.section.trim() ? input.section.trim().slice(0, 60) : null,
          pinned: input.pinned === true,
          createdAt: now(),
          settings,
          members,
          turns: [],
        };
        if (state.rooms.some((candidate) => candidate.name.toLowerCase() === room.name.toLowerCase())) {
          throw new RoomsError("a room with that name already exists", 409);
        }
        state.rooms.push(room);
        return save(state).then(() => clone(room));
      });
    },
    /** Applies a partial update; `members` replaces the member list (threads are kept). */
    async update(id: string, patch: Record<string, unknown>): Promise<Room> {
      return serialize(async (state) => {
        const room = state.rooms.find((candidate) => candidate.id === id);
        if (!room) throw new RoomsError("no such room", 404);
        if (patch.name !== undefined) {
          const name = normalizeName(patch.name);
          if (state.rooms.some((candidate) => candidate.id !== id && candidate.name.toLowerCase() === name.toLowerCase())) {
            throw new RoomsError("a room with that name already exists", 409);
          }
          room.name = name;
        }
        if (patch.description !== undefined) room.description = normalizeText(patch.description, MAX_DESCRIPTION, "the description");
        if (patch.guidance !== undefined) room.guidance = normalizeText(patch.guidance, MAX_GUIDANCE, "the guidance");
        if (patch.section !== undefined) room.section = typeof patch.section === "string" && patch.section.trim() ? patch.section.trim().slice(0, 60) : null;
        if (patch.pinned !== undefined) room.pinned = patch.pinned === true;
        if (Array.isArray(patch.members)) {
          const slugs = [...new Set(patch.members.map((slug) => text(slug)).filter(Boolean))];
          room.members = slugs.map((slug) => room.members.find((member) => member.slug === slug) ?? pendingMember(slug, now()));
        }
        room.settings = normalizeSettings(patch.settings, room.members.map((member) => member.slug), room.settings);
        await save(state);
        return clone(room);
      });
    },
    async remove(id: string): Promise<void> {
      return serialize(async (state) => {
        const index = state.rooms.findIndex((room) => room.id === id);
        if (index < 0) throw new RoomsError("no such room", 404);
        state.rooms.splice(index, 1);
        await save(state);
      });
    },
    /** Stores one member's resolved launch (thread id, mode, model) and status. */
    async setMember(id: string, slug: string, patch: Partial<RoomMember>): Promise<Room> {
      return serialize(async (state) => {
        const room = state.rooms.find((candidate) => candidate.id === id);
        if (!room) throw new RoomsError("no such room", 404);
        const member = room.members.find((candidate) => candidate.slug === slug);
        if (!member) throw new RoomsError("no such member", 404);
        Object.assign(member, patch);
        await save(state);
        return clone(room);
      });
    },
    /** Appends a user message to the turn index, pruning the oldest. */
    async appendTurn(id: string, turn: RoomTurn): Promise<Room> {
      return serialize(async (state) => {
        const room = state.rooms.find((candidate) => candidate.id === id);
        if (!room) throw new RoomsError("no such room", 404);
        // Stored as a copy: the caller keeps its own snapshot of the turn it just started.
        room.turns.push(JSON.parse(JSON.stringify(turn)) as RoomTurn);
        if (room.turns.length > MAX_TURNS) room.turns.splice(0, room.turns.length - MAX_TURNS);
        await save(state);
        return clone(room);
      });
    },
    /** A fresh start: the room keeps its settings and members but forgets every message it showed. */
    async clearTurns(id: string): Promise<Room> {
      return serialize(async (state) => {
        const room = state.rooms.find((candidate) => candidate.id === id);
        if (!room) throw new RoomsError("no such room", 404);
        room.turns = [];
        // Every member starts from zero: the next prompt carries the whole (new) index.
        for (const member of room.members) member.lastTurnAt = null;
        await save(state);
        return clone(room);
      });
    },
    /** Records the run a member got, as soon as the engine knows it: the room shows who is answering. */
    async setTurnRun(id: string, turnId: string, slug: string, runId: string | null): Promise<void> {
      return serialize(async (state) => {
        const room = state.rooms.find((candidate) => candidate.id === id);
        const turn = room?.turns.find((candidate) => candidate.id === turnId);
        if (!turn) return;
        const entry = turn.runs.find((candidate) => candidate.slug === slug);
        if (entry) entry.runId = runId;
        else turn.runs.push({ slug, runId });
        await save(state);
      });
    },
    /** The member passed its timeout: its reply is late and must not open a wave. */
    async markRunLate(id: string, turnId: string, slug: string, runId: string | null): Promise<void> {
      return serialize(async (state) => {
        const room = state.rooms.find((candidate) => candidate.id === id);
        const turn = room?.turns.find((candidate) => candidate.id === turnId);
        if (!turn) return;
        const entry = turn.runs.find((candidate) => candidate.slug === slug);
        if (!entry) {
          turn.runs.push({ slug, runId, late: true });
        } else {
          if (entry.runId !== runId) entry.runId = runId;
          if (entry.late) return;
          entry.late = true;
        }
        await save(state);
      });
    },
    async patchTurn(id: string, turnId: string, patch: Partial<RoomTurn>): Promise<Room | null> {
      return serialize(async (state) => {
        const room = state.rooms.find((candidate) => candidate.id === id);
        if (!room) return null;
        const turn = room.turns.find((candidate) => candidate.id === turnId);
        if (!turn) return null;
        Object.assign(turn, patch);
        await save(state);
        return clone(room);
      });
    },
    /** A turn that was running when the gateway stopped is finished for good: it does not resume. */
    async interruptRunning(): Promise<string[]> {
      return serialize(async (state) => {
        const interrupted: string[] = [];
        for (const room of state.rooms) {
          for (const turn of room.turns) {
            if (turn.status === "running") {
              turn.status = "interrupted";
              interrupted.push(`${room.id}/${turn.id}`);
            }
          }
        }
        if (interrupted.length > 0) await save(state);
        return interrupted;
      });
    },
  };
}

export type RoomsStore = ReturnType<typeof createRooms>;
