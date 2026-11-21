// What this device kept from the last time it could reach the gateway: each Bot's window, the rooms,
// and the pictures already seen.
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

/** `owner`: the conversation (`view:<thread>`) or room (`room:<id>`) whose deletion takes this record with it. */
type Entry = { savedAt: number; bytes: number; owner?: string };
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
    const { savedAt, bytes, owner } = entry as Entry;
    if (typeof savedAt === "number" && typeof bytes === "number") out[id] = { savedAt, bytes, ...(typeof owner === "string" ? { owner } : {}) };
  }
  return out;
}

/** Stores the record and drops what its kind can no longer keep: expired, over its count, or over its bytes. */
/** Resolves true when the record was stored; false when a sign-out or a deletion refused it. */
async function writeRecord(id: string, value: unknown, knownBytes?: number, owner?: string): Promise<boolean> {
  const mine = await tabGeneration();
  const bytes = knownBytes ?? bytesOf(value);
  let dropped: string[] = [];
  const written = await storage().transact("readwrite", async (store) => {
    // Signed out since this tab started: what it holds belongs to the last sign-in. Deleted (in any
    // tab): a save queued before the deletion must not bring it back.
    if (await store.get(GENERATION) !== mine || await store.get(`gone:${id}`) !== undefined) return false;
    // Its conversation or room was deleted: the picture or member copy goes with it.
    if (owner && await store.get(`gone:${owner}`) !== undefined) return false;
    const index = await readIndex(store);
    const now = Date.now();
    /** What the store keeps and drops, with or without the incoming record. */
    const plan = (incoming: boolean) => {
      const rows0: Index = { ...index, ...(incoming ? { [id]: { savedAt: now, bytes, ...(owner ? { owner } : {}) } } : {}) };
      const dropping: string[] = [];
      const kept: Index = {};
      for (const kind of new Set(Object.keys(rows0).map(kindOf))) {
        const rule = RULES[kind] ?? { keep: 4, bytes: 4 * MB };
        const rows = Object.entries(rows0)
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
      // An evicted conversation or room takes what it owned, so a picture never outlives the copy that showed it.
      const going = new Set(dropping);
      for (let grew = true; grew;) {
        grew = false;
        for (const [key, entry] of Object.entries(kept)) {
          if (key !== id && entry.owner && going.has(entry.owner)) { going.add(key); delete kept[key]; grew = true; }
        }
      }
      return { kept, going };
    };
    let { kept, going } = plan(true);
    // The owner itself is being evicted (expired, over budget): the record it would own is not kept,
    // and it takes no one else's place either.
    const orphan = !!owner && going.has(owner);
    if (orphan) ({ kept, going } = plan(false));
    await store.put(INDEX, kept);
    for (const key of going) await store.remove(key);
    if (!orphan) await store.put(id, value);
    // A deletion marker that ages out can no longer stop a save some tab queued long ago: every open
    // tab stops saving instead, and starts again under the new generation on its next launch.
    if ([...going].some((key) => kindOf(key) === "gone")) await store.put(GENERATION, newGeneration());
    dropped = [...going];
    if (orphan) return false;
    dropped = [...going];
    return true;
  });
  announceDropped(dropped);
  return written;
}

/**
 * Records that left the store (evicted, forgotten or deleted), told to this tab's listeners and to
 * every other tab of this mount, so no page keeps drawing a picture the store no longer holds.
 */
const droppedListeners = new Set<(ids: string[]) => void>();
let dropChannel: BroadcastChannel | null = null;
function dropBroadcast(): BroadcastChannel | null {
  if (dropChannel || typeof BroadcastChannel === "undefined") return dropChannel;
  try {
    dropChannel = new BroadcastChannel(`${DB_NAME}.dropped`);
    dropChannel.onmessage = (event) => { if (Array.isArray(event.data)) for (const listener of droppedListeners) listener(event.data); };
    // Node (the tests) keeps a process alive for an open channel; a browser page does not care.
    (dropChannel as BroadcastChannel & { unref?: () => void }).unref?.();
  } catch { dropChannel = null; }
  return dropChannel;
}
function announceDropped(ids: string[]) {
  if (!ids.length) return;
  for (const listener of droppedListeners) listener(ids);
  try { dropBroadcast()?.postMessage(ids); } catch { /* other tabs learn on their next read */ }
}
export function onRecordsDropped(listener: (ids: string[]) => void) {
  droppedListeners.add(listener);
  dropBroadcast();
}

/** Reads one record of a known shape, ignoring anything this version did not write. */
export async function readRecord<T>(id: string, usable: (value: unknown) => value is T): Promise<T | null> {
  if (stopped) return null;
  // Reading pins this tab to the sign-in whose copy it paints; a later sign-in's records are not its to read.
  const mine = await tabGeneration().catch(() => null);
  if (!mine) return null;
  const value = await storage().transact("readonly", async (store) => {
    if (await store.get(GENERATION) !== mine) return null;
    // Older than a sign-in lasts: never painted, even on an offline launch where no write evicts it.
    const entry = (await readIndex(store))[id];
    return entry && fresh(entry.savedAt) ? store.get(id) : null;
  }).catch(() => null);
  return !stopped && usable(value) ? value : null;
}

/**
 * Forgets these records now, index first. `deleted`: the thing itself is gone (a deleted conversation
 * or room), so a marker keeps any tab's later save from writing it back.
 */
export async function forgetRecords(ids: string[], { deleted = false }: { deleted?: boolean } = {}): Promise<string[]> {
  if (!ids.length) return [];
  return serial(() => storage().transact("readwrite", async (store) => {
    const index = await readIndex(store);
    const now = Date.now();
    // A deleted conversation or room takes what it owned (its pictures, a room's member copies, and theirs).
    const going = new Set(ids);
    if (deleted) {
      for (let grew = true; grew;) {
        grew = false;
        for (const [key, entry] of Object.entries(index)) {
          if (entry.owner && going.has(entry.owner) && !going.has(key)) { going.add(key); grew = true; }
        }
      }
    }
    for (const id of going) delete index[id];
    if (deleted) {
      for (const id of going) {
        if (id.startsWith("asset:")) continue;
        index[`gone:${id}`] = { savedAt: now, bytes: 0 };
        await store.put(`gone:${id}`, now);
      }
    }
    await store.put(INDEX, index);
    for (const id of going) await store.remove(id);
    return [...going];
  })).then((gone) => { announceDropped(gone); return gone; }, () => [] as string[]);
}

/** Which of these records were deleted (in any tab), so a list fetched before the deletion can't name them. */
export async function deletedRecords(ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (!ids.length) return found;
  await storage().transact("readonly", async (store) => {
    for (const id of ids) if (await store.get(`gone:${id}`) !== undefined) found.add(id);
  }).catch(() => {});
  return found;
}

/** Signed out in this tab (or told so by another): nothing kept may be handed out any more. */
export const cacheStopped = () => stopped;

/** Every write is best effort: a refused or full quota must never reach the caller. */
async function writeQuietly(id: string, value: unknown, knownBytes?: number, owner?: string): Promise<boolean> {
  if (stopped) return false;
  return serial(() => writeRecord(id, value, knownBytes, owner)).catch(() => false);
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

/** `owner`: the room a member conversation belongs to, so deleting the room takes this copy too. */
export async function writeView(view: CachedView, limit = VIEW_BYTES, owner?: string): Promise<void> {
  // Keep the newest rows when one conversation outgrows its budget: a cold start wants the tail, not the head.
  const trimmed: CachedView = { ...view, requests: view.requests.slice(0, 40), subagents: view.subagents.slice(0, 200) };
  while (bytesOf(trimmed) > limit && trimmed.items.length > 20) trimmed.items = trimmed.items.slice(Math.ceil(trimmed.items.length / 4));
  if (bytesOf(trimmed) > limit) trimmed.runs = trimmed.runs.slice(-40);
  // A few rows too big to fit are not kept at all: an over-budget record would never be evicted fairly.
  if (bytesOf(trimmed) > limit) return;
  await writeQuietly(`view:${view.key}`, trimmed, undefined, owner);
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
  const record = { v: 1, savedAt: Date.now(), rooms };
  // A list too big for its budget is not kept: an over-budget record would never be evicted fairly.
  if (bytesOf(record) > RULES.rooms.bytes) return;
  await writeQuietly("rooms", record);
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
  if (bytesOf(trimmed) > ROOM_VIEW_BYTES) return;
  await writeQuietly(`room:${room.id}`, { v: 1, id: room.id, savedAt: Date.now(), room: trimmed });
}

/** A deleted room stays deleted, like a deleted conversation. */
export const forgetRoom = (id: string) => forgetRecords([`room:${id}`], { deleted: true });

/** Bytes this device kept for a file it has already shown, keyed by whatever identifies the asset. */
export async function readAsset<T>(key: string, usable: (value: unknown) => value is T): Promise<T | null> {
  return readRecord(`asset:${key}`, usable);
}

export async function writeAsset(key: string, value: unknown, owner?: string): Promise<boolean> {
  // A Blob is not JSON: its bytes are not in the record's serialized length, so the index needs them.
  const size = (value as { bytes?: unknown })?.bytes;
  return writeQuietly(`asset:${key}`, value, typeof size === "number" ? size : undefined, owner);
}
