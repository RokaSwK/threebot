import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_WAIT_MS, PENDING_MS, busyBotThreads, createAutoUpdateStore, createAutoUpdater } from "./auto-update.mjs";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "tb-auto-")), "auto-update.json");
const bots = [{ slug: "alpha", projectId: "project-alpha", mainThreadId: "thread-alpha" }];
const thread = (extra = {}) => ({ id: "thread-alpha", projectId: "project-alpha", status: "idle", activityRunStatus: null, pendingRuntimeRequest: null, archivedAt: null, lineage: { rootThreadId: "thread-alpha" }, ...extra });
let n = 0;
const found = (version = "0.2.0") => ({ updateAvailable: true, error: null, checkedAt: new Date(++n * 1000).toISOString(), latest: { version, url: `https://example.test/v${version}` } });

test("the automatic update is off until it's switched on, and the setting is saved on the server", async () => {
  const f = file();
  const installs = [];
  const updater = createAutoUpdater({ store: createAutoUpdateStore(f), version: "0.1.0", isBusy: async () => [], install: async (v) => { installs.push(v); } });
  assert.equal((await updater.status()).auto, false);
  await updater.consider(found());
  assert.deepEqual(installs, [], "off by default: a newer release isn't installed");
  await updater.setAuto(true);
  assert.equal(JSON.parse(readFileSync(f, "utf8")).auto, true);
  const reopened = createAutoUpdater({ store: createAutoUpdateStore(f), version: "0.1.0", isBusy: async () => [], install: async (v) => { installs.push(v); } });
  assert.equal((await reopened.status()).auto, true, "the saved setting outlives the process");
  await reopened.consider(found());
  assert.deepEqual(installs, ["0.2.0"]);
});

test("a Bot thread that is running or waiting on a request counts as busy; other projects' threads don't", () => {
  assert.equal(busyBotThreads([thread()], bots).length, 0);
  assert.equal(busyBotThreads([thread({ status: "running" })], bots).length, 1);
  assert.equal(busyBotThreads([thread({ activityRunStatus: "starting" })], bots).length, 1);
  assert.equal(busyBotThreads([thread({ pendingRuntimeRequest: { id: "r", kind: "approval", blocking: true } })], bots).length, 1);
  assert.equal(busyBotThreads([thread({ id: "side", projectId: "elsewhere", status: "running", lineage: { rootThreadId: "thread-alpha", parentThreadId: "thread-alpha" } })], bots).length, 1, "a Bot's side chat in another project");
  assert.equal(busyBotThreads([thread({ id: "other", projectId: "project-other", status: "running", lineage: { rootThreadId: "other" } })], bots).length, 0);
  assert.equal(busyBotThreads([thread({ status: "running", archivedAt: "2026-01-01T00:00:00Z" })], bots).length, 0);
});

test("while a Bot is busy the update waits for the next check, and stops waiting after the cap", async () => {
  let t = 0, busy = [thread({ status: "running" })];
  const installs = [];
  const updater = createAutoUpdater({ store: createAutoUpdateStore(file()), version: "0.1.0", now: () => t, isBusy: async () => busy, install: async (v) => { installs.push(v); } });
  await updater.setAuto(true);
  const first = found();
  await updater.consider(first);
  assert.deepEqual(installs, [], "never restarts mid-turn");
  assert.deepEqual((await updater.status()).waiting, { version: "0.2.0", since: 0 });
  busy = [];
  await updater.consider(first);
  assert.deepEqual(installs, [], "the same answer isn't looked at twice: it waits for the next check");
  busy = [thread({ pendingRuntimeRequest: { id: "q", kind: "user_input", blocking: true } })];
  t = MAX_WAIT_MS - 1; await updater.consider(found());
  assert.deepEqual(installs, []);
  t = MAX_WAIT_MS; await updater.consider(found());
  const status = await updater.status();
  assert.deepEqual([status.waiting, status.notice?.kind, status.notice?.version], [null, "waited", "0.2.0"]);
  busy = []; await updater.consider(found());
  assert.deepEqual(installs, [], "it doesn't come back to a release it gave up on");
  await updater.setAuto(true);
  await updater.consider(found("0.2.0"));
  assert.deepEqual(installs, ["0.2.0"], "switching it on again gives that release another chance");
});

test("T3 not answering counts as busy, never as idle", async () => {
  const installs = [];
  const updater = createAutoUpdater({ store: createAutoUpdateStore(file()), version: "0.1.0", isBusy: async () => { throw new Error("T3 timed out"); }, install: async (v) => { installs.push(v); } });
  await updater.setAuto(true);
  await updater.consider(found());
  assert.deepEqual(installs, []);
});

test("after the restart the new version says it updated once; a rollback says so and isn't retried", async () => {
  const f = file();
  const store = createAutoUpdateStore(f);
  const before = createAutoUpdater({ store, version: "0.1.0", isBusy: async () => [], install: async () => {} });
  await before.setAuto(true);
  await before.consider(found("0.2.0"));
  const after = createAutoUpdater({ store: createAutoUpdateStore(f), version: "0.2.0", isBusy: async () => [], install: async () => {} });
  await after.settle();
  const { notice } = await after.status();
  assert.deepEqual([notice.kind, notice.version, notice.from, notice.url], ["updated", "0.2.0", "0.1.0", "https://example.test/v0.2.0"]);
  await after.dismiss(notice.at);
  assert.equal((await after.status()).notice, null, "shown once");

  const installs = [];
  const old = createAutoUpdater({ store: createAutoUpdateStore(f), version: "0.2.0", isBusy: async () => [], install: async (v) => { installs.push(v); } });
  await old.consider(found("0.3.0"));
  const back = createAutoUpdater({ store: createAutoUpdateStore(f), version: "0.2.0", installed: (v) => v === "0.3.0", isBusy: async () => [], install: async (v) => { installs.push(v); } });
  await back.settle();
  assert.deepEqual([(await back.status()).notice.kind, (await back.status()).notice.from], ["rolledBack", "0.2.0"]);
  await back.consider(found("0.3.0"));
  assert.deepEqual(installs, ["0.3.0"], "a release that rolled back isn't installed again automatically");
});

test("an updater that fails before switching is reported and not retried", async () => {
  const installs = [];
  const updater = createAutoUpdater({ store: createAutoUpdateStore(file()), version: "0.1.0", isBusy: async () => [], install: async (v) => { installs.push(v); } });
  await updater.setAuto(true);
  await updater.consider(found());
  await updater.failed("0.2.0", new Error("Checksum mismatch"));
  assert.equal((await updater.status()).notice.kind, "failed");
  await updater.consider(found());
  assert.deepEqual(installs, ["0.2.0"]);
});

test("an update that never restarts the gateway (Linux can't see the updater exit) is given up after a while", async () => {
  let t = 0;
  const installs = [];
  const updater = createAutoUpdater({ store: createAutoUpdateStore(file()), version: "0.1.0", now: () => t, isBusy: async () => [], install: async (v) => { installs.push(v); } });
  await updater.setAuto(true);
  await updater.consider(found("0.2.0"));
  t = PENDING_MS - 1; await updater.consider(found("0.2.1"));
  assert.deepEqual(installs, ["0.2.0"], "no second update while one is running");
  t = PENDING_MS; await updater.consider(found("0.2.1"));
  const { notice } = await updater.status();
  assert.deepEqual([notice.kind, notice.version], ["failed", "0.2.0"]);
  assert.deepEqual(installs, ["0.2.0", "0.2.1"], "the stuck one is skipped and the newer release goes ahead");
});
