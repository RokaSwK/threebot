// What this device kept from the last time it could reach the gateway: each Bot's window, the rooms,
// and the image bytes already seen.
//
// A paint cache, never a source of truth: T3's snapshot replaces a view whole, nothing is dispatched
// from one, and everything here is written from what the store already holds. A conversation keeps
// its newest rows, so the same recent window a bounded snapshot carries is what a cold start paints.

import type { Bot, Run, RuntimeRequest, Settings, Subagent, ThreadShell, TurnItem } from "./types";
import type { RoomSummary, RoomView } from "./rooms";

/** One conversation, as the store holds it. */
export type CachedView = {
  v: 1;
  key: string;
  savedAt: number;
  /** The projection's own shell when it carried one; the orchestration shell usually arrives first. */
  thread: ThreadShell | null;
  items: TurnItem[];
  runs: Run[];
  requests: RuntimeRequest[];
  subagents: Subagent[];
  historyCursor: string | null;
  hasMoreHistory: boolean;
};

/** What the app needs to open without the gateway: the Bot list, the settings that shape the UI, and where Bots live. */
export type CachedBoot = {
  v: 1;
  savedAt: number;
  botsRoot: string;
  executorUrl: string | null;
  settings: Settings | null;
  bots: Bot[];
  historical: Bot[];
};

export type CachedRooms = { v: 1; savedAt: number; rooms: RoomSummary[] };
export type CachedRoom = { v: 1; id: string; savedAt: number; room: RoomView };

// One store per app mount: two gateways served from one origin under different paths keep apart.
const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const DB_NAME = BASE === "/" ? "threebot.view" : `threebot.view:${BASE}`;
const DB_VERSION = 1;
const STORE = "views";
const INDEX = "index";
const MB = 1024 * 1024;
/** One conversation's window. A bounded snapshot tops out at 1 MiB in T3; this leaves room for runs and requests. */
export const VIEW_BYTES = 2 * MB;
/** A member thread a room reads: the room shows the recent turns, so it needs less than a chat does. */
export const ROOM_VIEW_BYTES = 1 * MB;
/** A copy older than a sign-in lasts is never painted, and is dropped on the next write. */
const EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;
const fresh = (savedAt: unknown) => typeof savedAt === "number" && Date.now() - savedAt <= EXPIRES_MS;

/** Per record kind: how many to keep and how many bytes they may take together. */
const RULES: Record<string, { keep: number; bytes: number }> = {
  view: { keep: 8, bytes: 30 * MB },
  room: { keep: 12, bytes: 4 * MB },
  rooms: { keep: 1, bytes: 1 * MB },
  boot: { keep: 1, bytes: 1 * MB },
  asset: { keep: 80, bytes: 40 * MB },
  // Markers for deleted records: small, and kept long enough to outlive any save another tab queued.
  gone: { keep: 500, bytes: 1 * MB },
};

type Entry = { savedAt: number; bytes: number };
type Index = Record<string, Entry>;

/** One store's operations inside a transaction: everything a write does commits together or not at all. */
type Store = {
  get(id: string): Promise<unknown>;
  put(id: string, value: unknown): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
};
type Backend = { transact<T>(mode: IDBTransactionMode, work: (store: Store) => Promise<T>): Promise<T> };

/** Used when the origin has no usable IndexedDB (an insecure origin, a blocked open, a test process). */
function memoryBackend(): Backend {
  const rows = new Map<string, unknown>();
  const store: Store = {
    get: async (id) => rows.get(id),
    put: async (id, value) => void rows.set(id, value),
    remove: async (id) => void rows.delete(id),
    clear: async () => rows.clear(),
  };
  return { transact: (_mode, work) => work(store) };
}

function indexedBackend(): Backend {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Another tab holds an older cache"));
  }));
  return {
    async transact(mode, work) {
      const db = await open();
      const transaction = db.transaction(STORE, mode);
      const objects = transaction.objectStore(STORE);
      const done = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("Cache write aborted"));
      });
      // A failed request rejects the work and the commit both; the work's rejection is the one reported.
      done.catch(() => {});
      // Each request settles inside the transaction's own event, so awaiting it keeps the transaction open.
      const ask = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const store: Store = {
        get: (id) => ask(objects.get(id)),
        put: async (id, value) => void (await ask(objects.put(value, id))),
        remove: async (id) => void (await ask(objects.delete(id))),
        clear: async () => void (await ask(objects.clear())),
      };
      try {
        const result = await work(store);
        await done;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* already finished */ }
        throw error;
      }
    },
  };
}

/** The cache is optional in every direction: no storage, a refused open or a full quota leaves the app unchanged. */
let backend: Backend | null = null;

/**
 * Writes go one at a time within a tab; across tabs, each write is one transaction, so two tabs
 * cannot lose each other's index entries.
 */
let writes: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = writes.then(work, work);
  writes = run.catch(() => {});
  return run;
}

/**
 * Which sign-in this tab saves for. Signing out (in any tab) replaces the stored generation in the
 * same transaction that erases the store, so a save another tab already queued finds a different
 * generation and writes nothing.
 */
const GENERATION = "generation";
let generation: Promise<string> | null = null;
const newGeneration = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
function tabGeneration(): Promise<string> {
  return (generation ??= storage().transact("readwrite", async (store) => {
    const stored = await store.get(GENERATION);
    if (typeof stored === "string") return stored;
    const fresh = newGeneration();
    await store.put(GENERATION, fresh);
    return fresh;
  }));
}

/** Signing out stops the cache: a pending timer or a late render must not write back what was just forgotten. */
let stopped = false;
export function stopCacheWrites() { stopped = true; }
function storage(): Backend {
  if (backend) return backend;
  try {
    // IndexedDB works on a plain LAN origin, where caches and OPFS need a secure context.
    backend = typeof indexedDB === "undefined" ? memoryBackend() : indexedBackend();
  } catch {
    backend = memoryBackend();
  }
  return backend;
}

/** For a test, or to forget everything this device kept. */
export function resetCacheForTest() {
  backend = null;
  generation = null;
  stopped = false;
  writes = Promise.resolve();
}

/** The name other tabs of this mount listen on for a sign-out. */
export const FORGET_CHANNEL = `${DB_NAME}.forget`;

/**
 * Logging out (or a sign-in as someone else) must not leave a readable transcript behind. The whole
 * store goes, not only what the index names: an interrupted write may have left a record unindexed.
 */
export async function clearCache(): Promise<void> {
  await serial(() => storage().transact("readwrite", async (store) => {
    await store.clear();
    await store.put(GENERATION, newGeneration());
  })).catch(() => {});
  backend = null;
  generation = null;
}

const bytesOf = (value: unknown) => {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return Number.MAX_SAFE_INTEGER; }
};

/** `view:<thread>`, `room:<id>`, `rooms`, `boot` or `asset:<key>`: the prefix is the kind that budgets it. */
const kindOf = (id: string) => id.split(":")[0] ?? id;

async function readIndex(store: Store): Promise<Index> {
  const value = await store.get(INDEX);
  if (!value || typeof value !== "object") return {};
  const out: Index = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { savedAt, bytes } = entry as Entry;
    if (typeof savedAt === "number" && typeof bytes === "number") out[id] = { savedAt, bytes };
  }
  return out;
}

/** Stores the record and drops what its kind can no longer keep: expired, over its count, or over its bytes. */
async function writeRecord(id: string, value: unknown, knownBytes?: number): Promise<void> {
  const mine = await tabGeneration();
  const bytes = knownBytes ?? bytesOf(value);
  await storage().transact("readwrite", async (store) => {
    // Signed out since this tab started: what it holds belongs to the last sign-in. Deleted (in any
    // tab): a save queued before the deletion must not bring it back.
    if (await store.get(GENERATION) !== mine || await store.get(`gone:${id}`) !== undefined) return;
    const index = await readIndex(store);
    const now = Date.now();
    index[id] = { savedAt: now, bytes };
    const dropping: string[] = [];
    const kept: Index = {};
    for (const kind of new Set(Object.keys(index).map(kindOf))) {
      const rule = RULES[kind] ?? { keep: 4, bytes: 4 * MB };
      const rows = Object.entries(index)
        .filter(([key]) => kindOf(key) === kind)
        // The record being written counts first, so it never sits outside the budget.
        .sort((a, b) => Number(b[0] === id) - Number(a[0] === id) || (b[1].savedAt - a[1].savedAt) || (a[0] < b[0] ? -1 : 1));
      let count = 0;
      let total = 0;
      for (const [key, entry] of rows) {
        // The record being written always survives: its caller already trimmed it.
        const overAge = now - entry.savedAt > EXPIRES_MS;
        const overCount = count >= rule.keep;
        const overBytes = count > 0 && total + entry.bytes > rule.bytes;
        if (key !== id && (overAge || overCount || overBytes)) { dropping.push(key); continue; }
        kept[key] = entry;
        count++;
        total += entry.bytes;
      }
    }
    await store.put(INDEX, kept);
    for (const key of dropping) await store.remove(key);
    await store.put(id, value);
    // A deletion marker that ages out can no longer stop a save some tab queued long ago: every open
    // tab stops saving instead, and starts again under the new generation on its next launch.
    if (dropping.some((key) => kindOf(key) === "gone")) await store.put(GENERATION, newGeneration());
  });
}

/** Reads one record of a known shape, ignoring anything this version did not write. */
export async function readRecord<T>(id: string, usable: (value: unknown) => value is T): Promise<T | null> {
  if (stopped) return null;
  // Reading pins this tab to the sign-in whose copy it paints; a later sign-in's records are not its to read.
  const mine = await tabGeneration().catch(() => null);
  if (!mine) return null;
  const value = await storage().transact("readonly", async (store) => await store.get(GENERATION) === mine ? store.get(id) : null).catch(() => null);
  return !stopped && usable(value) ? value : null;
}

/**
 * Forgets these records now, index first. `deleted`: the thing itself is gone (a deleted conversation
 * or room), so a marker keeps any tab's later save from writing it back.
 */
export async function forgetRecords(ids: string[], { deleted = false }: { deleted?: boolean } = {}): Promise<void> {
  if (!ids.length) return;
  await serial(() => storage().transact("readwrite", async (store) => {
    const index = await readIndex(store);
    const now = Date.now();
    // A deleted conversation takes the pictures and files it showed with it.
    const assets = deleted ? await assetsOf(store, index, ids) : [];
    for (const id of ids) {
      delete index[id];
      if (deleted) {
        index[`gone:${id}`] = { savedAt: now, bytes: 0 };
        await store.put(`gone:${id}`, now);
      }
    }
    for (const id of assets) delete index[id];
    await store.put(INDEX, index);
    for (const id of [...ids, ...assets]) await store.remove(id);
  })).catch(() => {});
}

/** Every write is best effort: a refused or full quota must never reach the caller. */
async function writeQuietly(id: string, value: unknown, knownBytes?: number): Promise<void> {
  if (stopped) return;
  await serial(() => writeRecord(id, value, knownBytes)).catch(() => {});
}

const isView = (key: string) => (value: unknown): value is CachedView => {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<CachedView>;
  return view.v === 1 && view.key === key && fresh(view.savedAt) && Array.isArray(view.items) && Array.isArray(view.runs);
};

/** The last copy of one conversation, or null when this device never painted it. */
export async function readView(key: string): Promise<CachedView | null> {
  return readRecord(`view:${key}`, isView(key));
}

export async function writeView(view: CachedView, limit = VIEW_BYTES): Promise<void> {
  // Keep the newest rows when one conversation outgrows its budget: a cold start wants the tail, not the head.
  const trimmed: CachedView = { ...view, requests: view.requests.slice(0, 40), subagents: view.subagents.slice(0, 200) };
  while (bytesOf(trimmed) > limit && trimmed.items.length > 20) trimmed.items = trimmed.items.slice(Math.ceil(trimmed.items.length / 4));
  if (bytesOf(trimmed) > limit) trimmed.runs = trimmed.runs.slice(-40);
  // A few rows too big to fit are not kept at all: an over-budget record would never be evicted fairly.
  if (bytesOf(trimmed) > limit) return;
  await writeQuietly(`view:${view.key}`, trimmed);
}

/** The Bot list and settings the app opened with, for a launch with no gateway. */
export async function readBoot(): Promise<CachedBoot | null> {
  return readRecord("boot", (value): value is CachedBoot => {
    if (!value || typeof value !== "object") return false;
    const boot = value as Partial<CachedBoot>;
    return boot.v === 1 && fresh(boot.savedAt) && Array.isArray(boot.bots) && typeof boot.botsRoot === "string";
  });
}

export async function writeBoot(boot: Omit<CachedBoot, "v" | "savedAt">): Promise<void> {
  await writeQuietly("boot", { ...boot, v: 1, savedAt: Date.now() });
}

/** The sidebar's rooms, so it lists them before the gateway answers. */
export async function readRooms(): Promise<RoomSummary[] | null> {
  const cached = await readRecord("rooms", (value): value is CachedRooms => !!value && typeof value === "object" && (value as CachedRooms).v === 1 && Array.isArray((value as CachedRooms).rooms));
  return cached?.rooms ?? null;
}

export async function writeRooms(rooms: RoomSummary[]): Promise<void> {
  await writeQuietly("rooms", { v: 1, savedAt: Date.now(), rooms });
}

/** One room's turn index and members. The replies stay in the members' own cached windows. */
export async function readRoom(id: string): Promise<RoomView | null> {
  const cached = await readRecord(`room:${id}`, (value): value is CachedRoom => {
    if (!value || typeof value !== "object") return false;
    const room = value as Partial<CachedRoom>;
    return room.v === 1 && room.id === id && !!room.room && Array.isArray(room.room.turns);
  });
  return cached?.room ?? null;
}

export async function writeRoom(room: RoomView): Promise<void> {
  // A room is rewritten on every turn change; the copy keeps its newest turns instead of growing forever.
  // A fixture or a partially built room may carry no turns: the copy then keeps the room as it is.
  const turns = Array.isArray(room.turns) ? room.turns : [];
  const trimmed = { ...room, turns: turns.slice(-400) };
  while (bytesOf(trimmed) > ROOM_VIEW_BYTES && trimmed.turns.length > 20) {
    trimmed.turns = trimmed.turns.slice(Math.ceil(trimmed.turns.length / 4));
  }
  await writeQuietly(`room:${room.id}`, { v: 1, id: room.id, savedAt: Date.now(), room: trimmed });
}

/** Drops one record: a deleted room must not come back, and a broken file must not be served twice. */
export const forgetRecord = (id: string) => forgetRecords([id]);

/** A deleted room stays deleted, like a deleted conversation. */
export const forgetRoom = (id: string) => forgetRecords([`room:${id}`], { deleted: true });

/** The kept files a conversation's copy points at: its attachments, and whatever is keyed by its thread. */
async function assetsOf(store: Store, index: Index, ids: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const id of ids) {
    if (!id.startsWith("view:")) continue;
    const thread = id.slice("view:".length);
    for (const key of Object.keys(index)) {
      if (["tool-image", "workspace", "file"].some((kind) => key.startsWith(`asset:${kind}:${thread}:`))) found.add(key);
    }
    const attachmentIds = new Set<string>();
    const visit = (value: unknown, depth: number) => {
      if (!value || typeof value !== "object" || depth > 4) return;
      if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
      const record = value as Record<string, unknown>;
      if (typeof record.attachmentId === "string") attachmentIds.add(record.attachmentId);
      if (Array.isArray(record.attachments)) for (const attachment of record.attachments) {
        if (attachment && typeof attachment === "object" && typeof (attachment as { id?: unknown }).id === "string") attachmentIds.add((attachment as { id: string }).id);
      }
      for (const entry of Object.values(record)) if (entry && typeof entry === "object") visit(entry, depth + 1);
    };
    visit((await store.get(id) as { items?: unknown } | undefined)?.items, 0);
    for (const attachmentId of attachmentIds) if (index[`asset:attachment:${attachmentId}`]) found.add(`asset:attachment:${attachmentId}`);
  }
  return [...found];
}

/** Bytes this device kept for a file it has already shown, keyed by whatever identifies the asset. */
export async function readAsset<T>(key: string, usable: (value: unknown) => value is T): Promise<T | null> {
  return readRecord(`asset:${key}`, usable);
}

export async function writeAsset(key: string, value: unknown): Promise<void> {
  // A Blob is not JSON: its bytes are not in the record's serialized length, so the index needs them.
  const size = (value as { bytes?: unknown })?.bytes;
  await writeQuietly(`asset:${key}`, value, typeof size === "number" ? size : undefined);
}
