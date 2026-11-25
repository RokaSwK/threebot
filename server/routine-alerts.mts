// Per-routine preferences the scheduler doesn't own: which Bot a routine belongs to and which of
// its runs should notify this account's devices. T3 stays the scheduler; this file only answers
// "is this run that routine's, and does the user want to hear about it?".
//
// It lives under the gateway's data folder, not in T3, and is keyed by task id so every device
// reads the same answer. Nothing here deletes a record on its own: a partial task snapshot is not
// evidence that a routine is gone.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Bot } from "./main-bot.mts";

export type RoutineAlertKind = "finished" | "failed" | "waiting";
export type RoutineAlerts = Record<RoutineAlertKind, boolean>;
/** What is stored for one routine. Every field is optional so a later save keeps the rest. */
export type RoutineRecord = { bot?: string; alerts?: Partial<RoutineAlerts> };
type RoutinePrefsState = { version: 1; tasks: Record<string, RoutineRecord> };

const TASK_ID = /^[\w:%.-]{1,600}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ALERT_KINDS: RoutineAlertKind[] = ["finished", "failed", "waiting"];

/** The destination that decides the compatible defaults: the Bot's chat, its own thread, or a new one. */
export type RoutinePlace = "chat" | "own" | "new";

/**
 * What each place notified before this feature existed: a run in the Bot's chat finished and waited
 * with the Bot; a run in its own thread or a new one was silent. A stored record only overrides
 * the toggles it names, so an old routine keeps exactly yesterday's behaviour.
 */
export function defaultAlerts(place: RoutinePlace): RoutineAlerts {
  return place === "chat" ? { finished: true, failed: false, waiting: true } : { finished: false, failed: false, waiting: false };
}

export function effectiveAlerts(record: RoutineRecord | null | undefined, place: RoutinePlace): RoutineAlerts {
  const base = defaultAlerts(place);
  const stored = record?.alerts;
  if (!stored) return base;
  for (const kind of ALERT_KINDS) if (typeof stored[kind] === "boolean") base[kind] = stored[kind];
  return base;
}

/** The routine's conversation is elsewhere: own, new each run, or the Bot's chat. */
export function routinePlace(task: { threadId?: string | null; threadMode?: string | null }, bot: Pick<Bot, "mainThreadId">): RoutinePlace {
  if ((task.threadMode ?? (task.threadId === null ? "new_thread" : "continue")) === "new_thread") return "new";
  return task.threadId && task.threadId === bot.mainThreadId ? "chat" : "own";
}

type OwnerBot = {
  slug: string;
  projectId?: string | null;
  mainThreadId?: string | null;
  /** A Bot made from the user's own project: that project is not dedicated to Threebot. */
  adopted?: boolean;
  /** The routine that tidies this Bot's memory; the link is ownership evidence. */
  memoryTidyRoutineId?: string;
};

/**
 * Which Bot owns a routine. A Bot's own chat and its tidy routine are proof; an explicit link wins
 * for the ambiguous cases. A project fallback is only a project Threebot created for one Bot: an
 * adopted project with a single Bot still contains the user's own work, user threads and rooms, so
 * it is not evidence on its own. `"ambiguous"` means the routine must not be shown as anybody's.
 */
export function routineOwner<B extends OwnerBot>(
  task: { id?: string; projectId?: string | null; threadId?: string | null },
  bots: B[],
  record?: RoutineRecord | null,
): B | "ambiguous" | null {
  // A run bound to a Bot's own chat is that Bot's, whatever an old link says. Links are for the
  // ambiguous cases: a run in a conversation of its own or a new thread in a shared project.
  if (task.threadId) {
    const byChat = bots.find((bot) => bot.mainThreadId === task.threadId);
    if (byChat) return byChat;
  }
  const tidy = task.id ? bots.find((bot) => bot.memoryTidyRoutineId === task.id && (!bot.projectId || !task.projectId || bot.projectId === task.projectId)) : undefined;
  if (tidy) return tidy;
  if (record?.bot) {
    const bot = bots.find((entry) => entry.slug === record.bot);
    // A link only resolves an ambiguous project; a stale link to another project is not proof.
    if (bot && (!bot.projectId || !task.projectId || bot.projectId === task.projectId)) return bot;
  }
  const candidates = bots.filter((bot) => !!bot.projectId && bot.projectId === task.projectId);
  // Only a project Threebot created for a single Bot is dedicated evidence. An adopted project
  // is the user's own even when this install has just one Bot in it.
  if (candidates.length === 1 && candidates[0].adopted !== true) return candidates[0];
  return candidates.length > 0 ? "ambiguous" : null;
}

/** The notification tag for a routine's completion: one notice per routine, not per Bot.
 * Deliberate grouping: consecutive runs of this routine replace one notice (no stack), while
 * another routine's notice is untouched. Waiting keeps the per-conversation tag instead. */
export function routineTag(taskId: string): string {
  return `routine:${taskId}`;
}

function checkedTaskId(value: unknown): string {
  if (typeof value !== "string" || !TASK_ID.test(value)) throw Object.assign(new Error("invalid routine id"), { status: 400 });
  return value;
}

function checkedAlerts(value: unknown): Partial<RoutineAlerts> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("alerts must be an object"), { status: 400 });
  const out: Partial<RoutineAlerts> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (!ALERT_KINDS.includes(key as RoutineAlertKind) || typeof enabled !== "boolean") throw Object.assign(new Error("invalid alert"), { status: 400 });
    out[key as RoutineAlertKind] = enabled;
  }
  return out;
}

/** Routine records on disk. Reads wait for the previous write, as the other small stores do. */
export function createRoutinePrefs({ file, log = (line: string) => console.error(line) }: { file: string; log?: (line: string) => void }) {
  let state: RoutinePrefsState | null = null;
  let writes: Promise<void> = Promise.resolve();

  async function load(): Promise<RoutinePrefsState> {
    if (state) return state;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<RoutinePrefsState>;
      if (parsed?.version !== 1 || !parsed.tasks || typeof parsed.tasks !== "object" || Array.isArray(parsed.tasks)) throw new Error("Invalid routine preferences file");
      state = { version: 1, tasks: parsed.tasks };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state = { version: 1, tasks: {} };
        return state;
      }
      // Never replace a file we could not read with an empty store: that would discard every
      // routine link and alert choice on the next save. Fail until the file is fixed or removed.
      log(`routine alerts: couldn't read its store (${(error as Error).message})`);
      throw Object.assign(new Error("Routine preferences are unavailable"), { status: 500 });
    }
    return state;
  }

  function save(): Promise<void> {
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    });
    return writes;
  }

  return {
    async get(taskId: string): Promise<RoutineRecord | null> {
      return (await load()).tasks[taskId] ?? null;
    },
    async all(): Promise<Record<string, RoutineRecord>> {
      return { ...(await load()).tasks };
    },
    /** Merges one record. `bot: null` unlinks; omitted keeps what is stored. */
    async set(taskId: string, patch: { bot?: string | null; alerts?: Partial<RoutineAlerts> }): Promise<RoutineRecord> {
      const id = checkedTaskId(taskId);
      const current = (await load()).tasks[id] ?? {};
      const next: RoutineRecord = { ...current };
      if (patch.bot !== undefined) {
        if (patch.bot === null) delete next.bot;
        else if (typeof patch.bot === "string" && SLUG.test(patch.bot)) next.bot = patch.bot;
        else throw Object.assign(new Error("invalid Bot"), { status: 400 });
      }
      const alerts = checkedAlerts(patch.alerts);
      if (alerts) next.alerts = { ...(current.alerts ?? {}), ...alerts };
      (await load()).tasks[id] = next;
      await save();
      return next;
    },
  };
}

export type RoutinePrefs = ReturnType<typeof createRoutinePrefs>;

type BodyReader = (req: import("node:http").IncomingMessage, limit?: number) => Promise<unknown>;
type BotExists = (slug: string) => Promise<boolean>;

/**
 * `GET /api/routine-alerts` and `PUT /api/routine-alerts/<task id>`; behind the gateway's session.
 * A Bot must exist before it can be linked, so a typo cannot make a routine invisible everywhere.
 */
export function createRoutineAlertRoutes({ store, botExists, readBody }: { store: RoutinePrefs; botExists: BotExists; readBody: BodyReader }) {
  return {
    async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname !== "/api/routine-alerts" && !url.pathname.startsWith("/api/routine-alerts/")) return false;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      try {
        if (url.pathname === "/api/routine-alerts") {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(JSON.stringify({ error: "Use GET" })); return true; }
          res.writeHead(200); res.end(JSON.stringify({ tasks: await store.all() })); return true;
        }
        const taskId = decodeURIComponent(url.pathname.slice("/api/routine-alerts/".length));
        checkedTaskId(taskId);
        if (req.method !== "PUT") { res.writeHead(405, { allow: "PUT" }); res.end(JSON.stringify({ error: "Use PUT" })); return true; }
        const body = await readBody(req, 16_384);
        if (!body || typeof body !== "object" || Array.isArray(body)) { res.writeHead(400); res.end(JSON.stringify({ error: "Expected a JSON object" })); return true; }
        const patch = body as { bot?: unknown; alerts?: unknown };
        if (patch.bot !== undefined && patch.bot !== null && (typeof patch.bot !== "string" || !SLUG.test(patch.bot) || !(await botExists(patch.bot)))) {
          res.writeHead(400); res.end(JSON.stringify({ error: "Unknown Bot" })); return true;
        }
        const task = await store.set(taskId, {
          ...(patch.bot === undefined ? {} : { bot: patch.bot as string | null }),
          ...(patch.alerts === undefined ? {} : { alerts: patch.alerts as Partial<RoutineAlerts> }),
        });
        res.writeHead(200); res.end(JSON.stringify({ task })); return true;
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        res.writeHead(status); res.end(JSON.stringify({ error: (error as Error).message || "Invalid routine preferences" })); return true;
      }
    },
  };
}
