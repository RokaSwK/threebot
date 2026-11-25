import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRoutineAlertRoutes, createRoutinePrefs, defaultAlerts, effectiveAlerts, routineOwner, routinePlace, routineTag } from "./routine-alerts.mts";

const bots = [
  { slug: "alpha", projectId: "shared", mainThreadId: "thread-alpha" },
  { slug: "beta", projectId: "shared", mainThreadId: "thread-beta" },
  { slug: "solo", projectId: "own-project", mainThreadId: "thread-solo" },
  { slug: "adopted", projectId: "user-repo", mainThreadId: "adopted-main", adopted: true, memoryTidyRoutineId: "tidy-task" },
];

test("defaults keep yesterday's behaviour: the chat notifies and its own thread stays silent", () => {
  assert.deepEqual(defaultAlerts("chat"), { finished: true, failed: false, waiting: true });
  assert.deepEqual(defaultAlerts("own"), { finished: false, failed: false, waiting: false });
  assert.deepEqual(defaultAlerts("new"), { finished: false, failed: false, waiting: false });
  assert.deepEqual(effectiveAlerts({ alerts: { failed: true } }, "own"), { finished: false, failed: true, waiting: false });
  assert.deepEqual(effectiveAlerts({ alerts: { finished: false } }, "chat"), { finished: false, failed: false, waiting: true });
  assert.deepEqual(effectiveAlerts(null, "own"), { finished: false, failed: false, waiting: false });
  assert.equal(routineTag("task-1"), "routine:task-1");
});

test("a routine is placed by its thread mode, and fresh_session reuses its thread", () => {
  assert.equal(routinePlace({ threadId: "thread-alpha", threadMode: "continue" }, bots[0]), "chat");
  assert.equal(routinePlace({ threadId: "thread-alpha", threadMode: "fresh_session" }, bots[0]), "chat");
  assert.equal(routinePlace({ threadId: "own", threadMode: "fresh_session" }, bots[0]), "own");
  assert.equal(routinePlace({ threadId: null, threadMode: "new_thread" }, bots[0]), "new");
  // Older T3 omits the mode: a null thread means a new thread, a bound one continues.
  assert.equal(routinePlace({ threadId: null }, bots[0]), "new");
});

test("ownership needs proof: a Bot's chat, an explicit link, or a one-Bot project", () => {
  assert.equal(routineOwner({ projectId: "shared", threadId: "thread-alpha" }, bots), bots[0]);
  assert.equal(routineOwner({ projectId: "shared", threadId: "own-thread" }, bots, { bot: "beta" }), bots[1]);
  // A shared project alone is ambiguous, and an unknown link falls back to that ambiguity.
  assert.equal(routineOwner({ projectId: "shared", threadId: "own-thread" }, bots), "ambiguous");
  assert.equal(routineOwner({ projectId: "shared", threadId: "own-thread" }, bots, { bot: "gone" }), "ambiguous");
  assert.equal(routineOwner({ projectId: "own-project", threadId: "own-thread" }, bots), bots[2]);
  assert.equal(routineOwner({ projectId: "missing", threadId: "own-thread" }, bots), null);
});

test("an adopted project with one Bot does not own user, room or new-thread routines", () => {
  const adopted = bots[3]!;
  const task = { projectId: "user-repo", threadId: "user-thread" };
  assert.equal(routineOwner(task, bots), "ambiguous");
  assert.equal(routineOwner({ ...task, threadId: "room-thread" }, bots), "ambiguous");
  assert.equal(routineOwner({ projectId: "user-repo", threadId: null }, bots), "ambiguous");
  assert.equal(routineOwner({ ...task, threadId: "adopted-main" }, bots), adopted);
  assert.equal(routineOwner({ projectId: "user-repo", threadId: "tidy-thread", id: "tidy-task" }, bots), adopted);
  assert.equal(routineOwner(task, bots, { bot: "adopted" }), adopted);
});

test("the store merges one field at a time, persists, and survives a corrupt file", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "routine-alerts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "routine-alerts.json");
  const logs: string[] = [];
  const store = createRoutinePrefs({ file, log: (line) => logs.push(line) });
  assert.deepEqual(await store.all(), {});
  await store.set("task-1", { bot: "alpha", alerts: { failed: true } });
  await store.set("task-1", { alerts: { waiting: true } });
  assert.deepEqual(await store.get("task-1"), { bot: "alpha", alerts: { failed: true, waiting: true } });
  await store.set("task-1", { bot: null });
  assert.deepEqual(await store.get("task-1"), { alerts: { failed: true, waiting: true } });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.tasks["task-1"].alerts.failed, true);
  // A partial snapshot never deletes another routine's record; a reopen reads what is there.
  assert.deepEqual(Object.keys((await createRoutinePrefs({ file }).all())), ["task-1"]);
  await writeFile(file, "{not json");
  const broken = createRoutinePrefs({ file, log: (line) => logs.push(line) });
  await assert.rejects(() => broken.all(), /unavailable/);
  await assert.rejects(() => broken.set("task-1", { alerts: { failed: true } }), /unavailable/);
  assert.equal(await readFile(file, "utf8"), "{not json", "a corrupt store is never replaced by an empty one");
  assert.equal(logs.length, 2, "each failed read reports once; the file is never rewritten");
  await assert.rejects(() => store.set("bad id!", {}), /invalid routine id/);
});

test("the route reads every record and refuses a missing Bot or a bad field", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "routine-alerts-route-"));
  const file = path.join(dir, "routine-alerts.json");
  const store = createRoutinePrefs({ file });
  const routes = createRoutineAlertRoutes({
    store,
    botExists: async (slug) => slug === "alpha",
    readBody: async () => ({ bot: "alpha", alerts: { finished: true } }),
  });
  const request = (method: string, path: string) => ({
    method,
    url: path,
    on: () => {},
  }) as unknown as import("node:http").IncomingMessage;
  const response = () => {
    const result = { status: 0, body: "", headers: {} as Record<string, string> };
    return Object.assign(result, {
      setHeader: (name: string, value: string) => { result.headers[name] = value; },
      writeHead: (status: number) => { result.status = status; return result; },
      end: (body: string) => { result.body = body; },
    }) as unknown as import("node:http").ServerResponse & { status: number; body: string };
  };
  const res = response();
  assert.equal(await routes.handle(request("PUT", "/api/routine-alerts/task-1"), res, new URL("/api/routine-alerts/task-1", "http://x")), true);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { task: { bot: "alpha", alerts: { finished: true } } });
  const list = response();
  await routes.handle(request("GET", "/api/routine-alerts"), list, new URL("/api/routine-alerts", "http://x"));
  assert.deepEqual(JSON.parse(list.body), { tasks: { "task-1": { bot: "alpha", alerts: { finished: true } } } });
  const missing = createRoutineAlertRoutes({ store, botExists: async () => false, readBody: async () => ({ bot: "ghost" }) });
  const denied = response();
  await missing.handle(request("PUT", "/api/routine-alerts/task-2"), denied, new URL("/api/routine-alerts/task-2", "http://x"));
  assert.equal(denied.status, 400);
  const invalid = createRoutineAlertRoutes({ store, botExists: async () => true, readBody: async () => ({ alerts: { loud: true } }) });
  const bad = response();
  await invalid.handle(request("PUT", "/api/routine-alerts/task-3"), bad, new URL("/api/routine-alerts/task-3", "http://x"));
  assert.equal(bad.status, 400);
  const wrongMethod = response();
  await routes.handle(request("POST", "/api/routine-alerts"), wrongMethod, new URL("/api/routine-alerts", "http://x"));
  assert.equal(wrongMethod.status, 405);
});

test("the route reports an unreadable store and leaves the file untouched", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "routine-alerts-broken-"));
  const file = path.join(dir, "routine-alerts.json");
  await writeFile(file, "{broken");
  const routes = createRoutineAlertRoutes({ store: createRoutinePrefs({ file, log: () => {} }), botExists: async () => true, readBody: async () => ({}) });
  const response = () => {
    const result = { status: 0, body: "" };
    return Object.assign(result, { setHeader() {}, writeHead: (status: number) => { result.status = status; return result; }, end: (body: string) => { result.body = body; } }) as unknown as import("node:http").ServerResponse & { status: number; body: string };
  };
  const res = response();
  await routes.handle({ method: "GET" } as import("node:http").IncomingMessage, res, new URL("/api/routine-alerts", "http://x"));
  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).error, "Routine preferences are unavailable");
  assert.equal(await readFile(file, "utf8"), "{broken");
});
