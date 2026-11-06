// Settings → Updates → "Update automatically". The setting and what happened are kept in one small
// JSON file next to the app's other files, so they work with no browser open and survive the restart
// an update causes. The background check (startUpdateChecks) hands each answer to `consider`; this
// file decides whether now is a good time, and the gateway installs the same way its Update button does.
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

/** An update that hasn't restarted us by then failed (on Linux the gateway can't see the updater exit). */
export const PENDING_MS = 30 * 60 * 1000;
/** How long a release waits for Bots to go quiet before the automatic update stops waiting for it. */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const BUSY = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Bot threads that a restart would interrupt: running, or waiting on an approval or question.
 * A thread is a Bot's when it's in a Bot's project or descends from a Bot's main thread (side chats, subagents).
 */
export function busyBotThreads(threads, bots) {
  const projects = new Set(bots.map((bot) => bot.projectId).filter(Boolean));
  const mains = new Set(bots.map((bot) => bot.mainThreadId).filter(Boolean));
  return threads.filter((thread) => !thread.archivedAt
    && (projects.has(thread.projectId) || mains.has(thread.id) || mains.has(thread.lineage?.rootThreadId) || mains.has(thread.lineage?.parentThreadId))
    && (Boolean(thread.pendingRuntimeRequest) || BUSY.has(thread.activityRunStatus ?? thread.status)));
}

export function createAutoUpdateStore(file) {
  let state = null;
  const read = async () => state ??= { auto: false, ...(JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) || {}) };
  let chain = Promise.resolve();
  return {
    read,
    /** Apply `change(state)` and save; changes run one at a time. */
    update(change) {
      const next = chain.then(async () => {
        const s = await read();
        state = { ...s, ...change(s) };
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n");
        await fs.rename(`${file}.tmp`, file);
        return state;
      });
      chain = next.catch(() => {});
      return next;
    },
  };
}

/**
 * `install(version)` starts the updater (download, SHA256SUMS, swap, restart, roll back) and resolves
 * once it's running; `onExit` from the gateway reports an updater that ended while this process lives,
 * which only happens when it failed before swapping. `isBusy()` resolves to the busy Bot threads.
 */
export function createAutoUpdater({ store, version, isBusy, install, installed = () => false, now = Date.now, maxWaitMs = MAX_WAIT_MS, log = () => {} }) {
  let lastCheckedAt = null, running = false;

  /** On start-up: an update this gateway's predecessor began either worked (we run its version) or didn't. */
  async function settle() {
    const s = await store.read();
    if (!s.pending) return s;
    const { from, to, url } = s.pending;
    const at = new Date(now()).toISOString();
    if (version === to) {
      log(`auto-update: now running ${to} (was ${from})`);
      return store.update(() => ({ pending: null, waiting: null, notice: { kind: "updated", version: to, from, url, at } }));
    }
    // Still on the old version: the new one was installed and didn't start (rolled back), or never got that far.
    const kind = installed(to) ? "rolledBack" : "failed";
    log(`auto-update: ${to} ${kind === "rolledBack" ? "didn't start, rolled back" : "failed"}; staying on ${version}`);
    return store.update((cur) => ({ pending: null, waiting: null, skip: [...new Set([...(cur.skip ?? []), to])], notice: { kind, version: to, from: version, url, at } }));
  }

  /** Called with every answer from the background check; acts at most once per new check. */
  async function consider(result) {
    if (!result?.checkedAt || result.checkedAt === lastCheckedAt) return;
    lastCheckedAt = result.checkedAt;
    let s = await store.read();
    if (s.pending && now() - Date.parse(s.pending.at) >= PENDING_MS) { await failed(s.pending.to, new Error("it didn't finish")); s = await store.read(); }
    if (!s.auto || running || s.pending) return;
    if (result.error || !result.updateAvailable || !result.latest) return;
    const target = result.latest.version, url = result.latest.url;
    if (s.skip?.includes(target) || s.gaveUp === target) return;
    const since = s.waiting?.version === target ? s.waiting.since : now();
    let busy;
    try { busy = await isBusy(); } catch (error) { busy = [{ id: `unknown (${error instanceof Error ? error.message : error})` }]; }
    if (busy.length) {
      if (now() - since >= maxWaitMs) {
        log(`auto-update: Bots stayed busy for ${Math.round((now() - since) / 3600000)}h; not waiting for ${target} any longer`);
        await store.update(() => ({ waiting: null, gaveUp: target, notice: { kind: "waited", version: target, from: version, url, at: new Date(now()).toISOString() } }));
      } else {
        log(`auto-update: ${target} is ready, waiting for ${busy.length} busy Bot thread${busy.length === 1 ? "" : "s"}`);
        await store.update(() => ({ waiting: { version: target, since } }));
      }
      return;
    }
    running = true;
    try {
      await store.update(() => ({ waiting: null, pending: { from: version, to: target, url, at: new Date(now()).toISOString() } }));
      log(`auto-update: nothing is busy, updating ${version} → ${target}`);
      await install(target);
    } catch (error) {
      await failed(target, error);
    }
  }

  /** The updater ended without restarting us (download or checksum failed): don't retry that release. */
  async function failed(target, error) {
    running = false;
    const s = await store.read();
    if (s.pending?.to !== target) return;
    log(`auto-update: ${target} failed: ${error instanceof Error ? error.message : error}`);
    await store.update((cur) => ({ pending: null, skip: [...new Set([...(cur.skip ?? []), target])], notice: { kind: "failed", version: target, from: version, url: cur.pending.url, at: new Date(now()).toISOString() } }));
  }

  return {
    settle, consider, failed,
    async status() { const s = await store.read(); return { auto: Boolean(s.auto), waiting: s.waiting ?? null, notice: s.notice ?? null }; },
    /** Turning it on (again) gives a release that was given up on another chance. */
    setAuto: (auto) => store.update(() => ({ auto: Boolean(auto), waiting: null, gaveUp: null })),
    dismiss: (at) => store.update((cur) => (cur.notice && (!at || cur.notice.at === at) ? { notice: null } : {})),
  };
}

export const versionInstalled = (versionsDir) => (v) => existsSync(path.join(versionsDir, v, ".install-complete"));
