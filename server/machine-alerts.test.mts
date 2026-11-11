import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOutageAlerts, remoteThreads, type BotWork } from "./machine-alerts.mts";
import type { Machine } from "./machines.mts";

const machine = (status: Machine["status"], local = false): Machine => ({
  environmentId: local ? "nas" : "m5", label: local ? "truenas" : "Air M5", local, status, lastSeenAt: null,
  t3Version: null, threebotVersion: null, laptop: !local, route: local ? "local" : "linked", paired: false, lastError: null,
});

test("the threads a Bot started elsewhere come from its own tasks", () => {
  const projection = { subagents: [
    { status: "running", title: "Fix login", remoteChild: { environmentId: "m5", threadId: "t1", title: "Fix login bug" } },
    { status: "completed", remoteChild: { environmentId: "m5", threadId: "t2" } },
    { status: "running", remoteChild: { environmentId: "m5", threadId: "t3", stoppedThere: true } },
    { status: "waiting", remoteChild: { environmentId: "other", threadId: "t4" } },
    { status: "running", childThreadId: "local" },
  ] };
  assert.deepEqual(remoteThreads(projection, "m5"), [{ threadId: "t1", title: "Fix login bug" }]);
  assert.deepEqual(remoteThreads(null, "m5"), []);
});

test("one message per outage to each Bot with work there, and one when the machine is back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alerts-"));
  try {
    const posts: { thread: string; text: string }[] = [];
    const file = path.join(root, "outages.json");
    const alerts = createOutageAlerts({ file, post: async (thread, text) => { posts.push({ thread, text }); } });
    let looked = 0;
    const work = async (environmentId: string): Promise<BotWork[]> => {
      looked++;
      assert.equal(environmentId, "m5");
      return [{ slug: "coder", mainThreadId: "main-coder", threads: [{ threadId: "t1", title: "Fix [login]" }, { threadId: "t2", title: "Docs" }] }, { slug: "idle", mainThreadId: "main-idle", threads: [] }];
    };
    const here = machine("online", true);
    await alerts.observe([here, machine("online")], work);
    // A single quiet look is not an outage.
    await alerts.observe([here, machine("asleep")], work);
    assert.equal(posts.length, 0);
    await alerts.observe([here, machine("asleep")], work);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].thread, "main-coder");
    assert.match(posts[0].text, /^From Threebot: Air M5 went to sleep with these threads running:/);
    assert.match(posts[0].text, /- \[Fix login\]\(t3-thread:\/\/v2\/m5\/t1\)\n- \[Docs\]\(t3-thread:\/\/v2\/m5\/t2\)/);
    // No spam while it stays away, even across a gateway restart.
    const restarted = createOutageAlerts({ file, post: async (thread, text) => { posts.push({ thread, text }); } });
    for (let i = 0; i < 5; i++) await restarted.observe([here, machine("unreachable")], work);
    assert.equal(posts.length, 1);
    assert.equal(looked, 1);
    await restarted.observe([here, machine("online")], work);
    assert.deepEqual(posts.slice(1), [{ thread: "main-coder", text: "From Threebot: Air M5 is back online. The threads that were running there can carry on." }]);
    await restarted.observe([here, machine("online")], work);
    assert.equal(posts.length, 2);
  } finally { await rm(root, { recursive: true }); }
});

test("nothing is said for a machine with no Bot work, an expired link, or this machine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alerts-"));
  try {
    const posts: string[] = [];
    const alerts = createOutageAlerts({ file: path.join(root, "outages.json"), post: async (_thread, text) => { posts.push(text); } });
    const none = async () => [];
    for (let i = 0; i < 3; i++) await alerts.observe([machine("unreachable", true), machine("unreachable")], none);
    await alerts.observe([machine("online", true), machine("online")], none);
    for (let i = 0; i < 3; i++) await alerts.observe([machine("online", true), machine("expired")], async () => assert.fail("expired links are not outages"));
    assert.deepEqual(posts, []);
  } finally { await rm(root, { recursive: true }); }
});

test("a Bot that couldn't be read or told is tried again during the outage, and never told twice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alerts-"));
  try {
    const posts: string[] = [];
    let failPost = true, unreadable = true;
    const alerts = createOutageAlerts({ file: path.join(root, "outages.json"), post: async (thread) => {
      if (thread === "main-a" && failPost) { failPost = false; throw new Error("T3 timed out"); }
      posts.push(thread);
    } });
    const a = { slug: "a", mainThreadId: "main-a", threads: [{ threadId: "t1", title: "A" }] };
    const b = { slug: "b", mainThreadId: "main-b", threads: [{ threadId: "t2", title: "B" }] };
    const c = { slug: "c", mainThreadId: "main-c", threads: [{ threadId: "t3", title: "C" }] };
    // c's thread can't be read on the first try: a and b are told what's known, c waits.
    const work = async () => {
      if (unreadable) { unreadable = false; throw Object.assign(new Error("couldn't read c"), { partial: [a, b] }); }
      return [a, b, c];
    };
    const here = machine("online", true);
    await alerts.observe([here, machine("unreachable")], work);
    await alerts.observe([here, machine("unreachable")], work);
    assert.deepEqual(posts, ["main-b"]);
    await alerts.observe([here, machine("unreachable")], work);
    assert.deepEqual(posts, ["main-b", "main-a", "main-c"]);
    await alerts.observe([here, machine("unreachable")], async () => assert.fail("everyone was told"));
    await alerts.observe([here, machine("online")], work);
    assert.deepEqual(posts.slice(3).sort(), ["main-a", "main-b", "main-c"]);
  } finally { await rm(root, { recursive: true }); }
});
