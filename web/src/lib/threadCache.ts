// What this device kept from the last time it could reach the gateway: each Bot's window and the
// list it opened with.
//
// A paint cache, never a source of truth: T3's snapshot replaces a view whole, nothing is dispatched
// from one, and everything here is written from what the store already holds. A conversation keeps
// its newest rows, so the same recent window a bounded snapshot carries is what a cold start paints.

import type { Bot, Run, RuntimeRequest, Settings, Subagent, ThreadShell, TurnItem } from "./types";

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

const DB_NAME = "threebot.view";
const DB_VERSION = 1;
const STORE = "views";
const INDEX = "index";
const MB = 1024 * 1024;
/** One conversation's window. A bounded snapshot tops out at 1 MiB in T3; this leaves room for runs and requests. */
export const VIEW_BYTES = 2 * MB;
/** A late write never counts as "last seen" for the next launch, so a forgotten device does not keep everything. */
const EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;

/** Per record kind: how many to keep and how many bytes they may take together. */
const RULES: Record<string, { keep: number; bytes: number }> = {
  view: { keep: 8, bytes: 30 * MB },
  boot: { keep: 1, bytes: 1 * MB },
};

type Entry = { savedAt: number; bytes: number };
type Index = Record<string, Entry>;

type Backend = {
  get(id: string): Promise<unknown>;
  put(id: string, value: unknown): Promise<void>;
  remove(ids: string[]): Promise<void>;
  clear(): Promise<void>;
};

/** Used when the origin has no usable IndexedDB (an insecure origin, a blocked open, a test process). */
function memoryBackend(): Backend {
  const rows = new Map<string, unknown>();
  return {
    get: async (id) => rows.get(id),
    put: async (id, value) => void rows.set(id, value),
    remove: async (ids) => { for (const id of ids) rows.delete(id); },
    clear: async () => { rows.clear(); },
  };
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
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Cache write aborted"));
    });
  };
  return {
    get: (id) => run("readonly", (store) => store.get(id)),
    put: async (id, value) => void (await run("readwrite", (store) => store.put(value, id))),
    remove: async (ids) => {
      if (!ids.length) return;
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        for (const id of ids) store.delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    },
    clear: async () => { await run("readwrite", (store) => store.clear()); },
  };
}

/** The cache is optional in every direction: no storage, a refused open or a full quota leaves the app unchanged. */
let backend: Backend | null = null;

/**
 * Writes go one at a time: the index is read, trimmed and written whole, so two saves at once would
 * lose one of the entries and leave a record nobody budgets or forgets.
 */
let writes: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = writes.then(work, work);
  writes = run.catch(() => {});
  return run;
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
  stopped = false;
  writes = Promise.resolve();
}

/**
 * Logging out (or a sign-in as someone else) must not leave a readable transcript behind. The whole
 * store goes, not only what the index names: an interrupted write may have left a record unindexed.
 */
export async function clearCache(): Promise<void> {
  await serial(() => storage().clear()).catch(() => {});
  backend = null;
}

const bytesOf = (value: unknown) => {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return Number.MAX_SAFE_INTEGER; }
};

/** `view:<thread>`, `room:<id>`, `rooms`, `boot` or `asset:<key>`: the prefix is the kind that budgets it. */
const kindOf = (id: string) => id.split(":")[0] ?? id;

async function readIndex(store: Backend): Promise<Index> {
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
async function writeRecord(id: string, value: unknown): Promise<void> {
  const store = storage();
  const bytes = bytesOf(value);
  const index = await readIndex(store);
  const now = Date.now();
  index[id] = { savedAt: now, bytes };
  const dropping: string[] = [];
  const kept: Index = {};
  for (const kind of new Set(Object.keys(index).map(kindOf))) {
    const rule = RULES[kind] ?? { keep: 4, bytes: 4 * MB };
    const rows = Object.entries(index)
      .filter(([key]) => kindOf(key) === kind)
      .sort((a, b) => (b[1].savedAt - a[1].savedAt) || (a[0] < b[0] ? -1 : 1));
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
  if (dropping.length) await store.remove(dropping);
  await store.put(id, value);
}

/** Reads one record of a known shape, ignoring anything this version did not write. */
export async function readRecord<T>(id: string, usable: (value: unknown) => value is T): Promise<T | null> {
  const value = await storage().get(id).catch(() => null);
  return usable(value) ? value : null;
}

/** Every write is best effort: a refused or full quota must never reach the caller. */
async function writeQuietly(id: string, value: unknown): Promise<void> {
  if (stopped) return;
  await serial(() => writeRecord(id, value)).catch(() => {});
}

const isView = (key: string) => (value: unknown): value is CachedView => {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<CachedView>;
  return view.v === 1 && view.key === key && typeof view.savedAt === "number" && Array.isArray(view.items) && Array.isArray(view.runs);
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
  await writeQuietly(`view:${view.key}`, trimmed);
}

/** The Bot list and settings the app opened with, for a launch with no gateway. */
export async function readBoot(): Promise<CachedBoot | null> {
  return readRecord("boot", (value): value is CachedBoot => {
    if (!value || typeof value !== "object") return false;
    const boot = value as Partial<CachedBoot>;
    return boot.v === 1 && Array.isArray(boot.bots) && typeof boot.botsRoot === "string";
  });
}

export async function writeBoot(boot: Omit<CachedBoot, "v" | "savedAt">): Promise<void> {
  await writeQuietly("boot", { ...boot, v: 1, savedAt: Date.now() });
}
