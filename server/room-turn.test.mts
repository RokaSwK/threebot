import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRooms, validateMembers, type Room } from "./rooms.mts";
import { createRoomEngine, promptFor, speakersFor } from "./room-turn.mts";

const roster = [
  { slug: "alpha", name: "Alpha" },
  { slug: "beta", name: "Beta" },
];
const bots = new Map(roster.map((bot) => [bot.slug, { ...bot, projectId: `project-${bot.slug}`, mainThreadId: `main-${bot.slug}` }]));

/** A scripted T3: dispatch records the command, and each thread's run is completed by the test. */
function fakeRuntime() {
  const dispatched: any[] = [];
  const launches: any[] = [];
  const runs = new Map<string, { messageId: string; runId: string; status: string; text: string }>();
  /** Every completed reply per thread, oldest first: the room reads them as history. */
  const items = new Map<string, any[]>();
  let counter = 0;
  return {
    dispatched,
    launches,
    runs,
    async dispatch(command: any) {
      dispatched.push(command);
      if (command.type === "message.dispatch") {
        counter += 1;
        runs.set(command.threadId, { messageId: command.messageId, runId: `run-${counter}`, status: "running", text: "" });
      }
      return { ok: true };
    },
    async call(tag: string, payload: any) {
      if (tag === "orchestration.launchThread") {
        launches.push(payload);
        return { ok: true };
      }
      if (tag !== "orchestration.getThreadProjection") throw new Error(`unexpected ${tag}`);
      const run = runs.get(payload.threadId);
      return {
        runs: run ? [{ id: run.runId, status: run.status, userMessageId: run.messageId }] : [],
        turnItems: [...(items.get(payload.threadId) ?? [])],
      };
    },
    complete(threadId: string, text: string) {
      const run = runs.get(threadId);
      if (!run) return;
      run.status = "completed";
      run.text = text;
      items.set(threadId, [...(items.get(threadId) ?? []), {
        id: `item-${run.runId}`,
        runId: run.runId,
        type: "assistant_message",
        status: "completed",
        text,
        completedAt: "2026-01-01T00:00:05.000Z",
      }]);
    },
    fail(threadId: string) {
      const run = runs.get(threadId);
      if (run) Object.assign(run, { status: "failed" });
    },
  };
}

async function roomWith(settings: Record<string, unknown> = {}): Promise<{ room: Room; file: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "room-turn-"));
  const file = path.join(dir, "rooms.json");
  const rooms = createRooms({ file });
  const room = await rooms.create({ name: "Design", members: validateMembers(["alpha", "beta"], roster), settings });
  // The threads already exist, so a turn does not have to launch them.
  await rooms.setMember(room.id, "alpha", { threadId: "thread-alpha", status: "ready" });
  await rooms.setMember(room.id, "beta", { threadId: "thread-beta", status: "ready" });
  // The engine can still be writing rooms.json.tmp when a stop test finishes: retry the removal.
  return { room: (await rooms.get(room.id))!, file, done: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) };
}

const waitFor = async (check: () => boolean | Promise<boolean>, label: string, timeoutMs = 3_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

test("a mention starts only the member it names", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  const { turn, queued } = await engine.send(room.id, { text: "Hola @Beta, ¿ping?" });
  assert.equal(queued, false);
  await waitFor(() => runtime.dispatched.length === 1, "the dispatch");
  assert.equal(runtime.dispatched[0].threadId, "thread-beta");
  assert.match(runtime.dispatched[0].text, /You are Beta/);
  assert.match(runtime.dispatched[0].text, /User: Hola @Beta, ¿ping\?/);
  runtime.complete("thread-beta", "pong");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  const stored = (await rooms.get(room.id))!;
  assert.deepEqual(stored.turns[0].runs, [{ slug: "beta", runId: "run-1" }]);
  assert.equal(stored.members.find((member) => member.slug === "beta")!.lastTurnAt, "2026-01-01T00:00:05.000Z");
  assert.equal(turn.status, "running");
  await done();
});

test("nobody mentioned means the lead answers; `everyone` wakes the room", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "sin menciones" });
  await waitFor(() => runtime.dispatched.length === 1, "the lead dispatch");
  assert.equal(runtime.dispatched[0].threadId, "thread-alpha", "alpha is the lead by default");
  runtime.complete("thread-alpha", "hola");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");

  const everyone = await createRooms({ file: path.join(path.dirname(file), "rooms2.json") });
  const second = await everyone.create({ name: "All", members: validateMembers(["alpha", "beta"], roster), settings: { defaultResponder: "everyone" } });
  await everyone.setMember(second.id, "alpha", { threadId: "thread-a2", status: "ready" });
  await everyone.setMember(second.id, "beta", { threadId: "thread-b2", status: "ready" });
  const runtime2 = fakeRuntime();
  const engine2 = createRoomEngine({ rooms: everyone, rpc: runtime2, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine2.send(second.id, { text: "todos" });
  await waitFor(() => runtime2.dispatched.length === 2, "both dispatches");
  assert.deepEqual(runtime2.dispatched.map((command) => command.threadId).sort(), ["thread-a2", "thread-b2"]);
  runtime2.complete("thread-a2", "uno");
  runtime2.complete("thread-b2", "dos");
  await waitFor(async () => (await everyone.get(second.id))!.turns[0].status === "done", "the turn to finish");
  await done();
});

test("a message sent during a turn waits and then runs", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "primero" });
  await waitFor(() => runtime.dispatched.length === 1, "the first dispatch");
  const second = await engine.send(room.id, { text: "segundo" });
  assert.equal(second.queued, true);
  assert.equal(runtime.dispatched.length, 1, "nothing dispatched while the turn runs");
  runtime.complete("thread-alpha", "ok");
  await waitFor(() => runtime.dispatched.length === 2, "the queued dispatch");
  assert.match(runtime.dispatched[1].text, /User: segundo/);
  runtime.complete("thread-alpha", "ok2");
  await waitFor(async () => {
    const stored = (await rooms.get(room.id))!;
    return stored.turns.length === 2 && stored.turns.every((entry) => entry.status === "done");
  }, "both turns to finish");
  await done();
});

test("`mentions: [\"all\"]` wakes every member", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "", mentions: ["all"] });
  await waitFor(() => runtime.dispatched.length === 2, "both dispatches");
  runtime.complete("thread-alpha", "uno");
  runtime.complete("thread-beta", "dos");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  await done();
});

test("a prompt carries teammates' replies from earlier turns", async () => {
  const { room, file, done } = await roomWith({ mode: "panel" });
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "@Beta cuéntame" });
  await waitFor(() => runtime.dispatched.length === 1, "the first dispatch");
  runtime.complete("thread-beta", "Beta contestó");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the first turn");

  await engine.send(room.id, { text: "@Alpha ahora tú" });
  await waitFor(() => runtime.dispatched.length === 2, "the second dispatch");
  assert.equal(runtime.dispatched[1].threadId, "thread-alpha");
  assert.match(runtime.dispatched[1].text, /Beta: Beta contestó/, "Alpha sees what Beta said in the previous turn");
  runtime.complete("thread-alpha", "Alpha contestó");
  await waitFor(async () => (await rooms.get(room.id))!.turns[1].status === "done", "the second turn");
  await done();
});

test("a panel ignores mentions inside a reply", async () => {
  const { room, file, done } = await roomWith({ mode: "panel" });
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "@Alpha dinos algo" });
  await waitFor(() => runtime.dispatched.length === 1, "the only speaker");
  runtime.complete("thread-alpha", "Se lo dejo a @Beta");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runtime.dispatched.length, 1, "a panel does not open a second wave");
  await done();
});

test("maxReplies caps how many members speak in one turn", async () => {
  const { room, file, done } = await roomWith({ mode: "panel", defaultResponder: "everyone", maxReplies: 1 });
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "solo uno" });
  await waitFor(() => runtime.dispatched.length === 1, "the only dispatch");
  runtime.complete("thread-alpha", "yo hablo");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runtime.dispatched.length, 1);
  await done();
});

test("the turn records who is answering before the reply arrives", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "@Alpha hola" });
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].runs.length === 1, "the run to be recorded");
  const live = (await rooms.get(room.id))!.turns[0];
  assert.equal(live.status, "running");
  assert.deepEqual(live.runs, [{ slug: "alpha", runId: "run-1" }]);
  runtime.complete("thread-alpha", "ok");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  await done();
});

test("stop interrupts the answering member and marks the turn", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "para esto" });
  await waitFor(() => runtime.dispatched.length === 1, "the dispatch");
  const stopped = await engine.stop(room.id);
  assert.equal(stopped, true);
  assert.ok(runtime.dispatched.some((command) => command.type === "thread.stop" && command.threadId === "thread-alpha"));
  const stored = (await rooms.get(room.id))!;
  assert.equal(stored.turns[0].status, "stopped");
  assert.equal(await engine.stop(room.id), false, "stopping an idle room is a no-op");
  await done();
});

test("a failed run still closes the turn and moves the member's clock", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "esto va a fallar" });
  await waitFor(() => runtime.dispatched.length === 1, "the dispatch");
  runtime.fail("thread-alpha");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status !== "running", "the turn to close");
  const stored = (await rooms.get(room.id))!;
  assert.equal(stored.turns[0].status, "done", "one failed member is not a failed room turn");
  assert.deepEqual(stored.turns[0].runs, [{ slug: "alpha", runId: "run-1" }]);
  assert.ok(stored.members.find((member) => member.slug === "alpha")!.lastTurnAt);
  await done();
});

test("a (pass) reply is not a room line but the turn closes", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const pushed: any[] = [];
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1, notify: (payload) => { pushed.push(payload); } });
  await engine.send(room.id, { text: "algo" });
  await waitFor(() => runtime.dispatched.length === 1, "the dispatch");
  runtime.complete("thread-alpha", "(pass)");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  assert.deepEqual(pushed, [], "a pass sends no push");
  await done();
});

test("a reply sends one push with the room deep link", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const pushed: any[] = [];
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1, notify: (payload) => { pushed.push(payload); } });
  await engine.send(room.id, { text: "algo" });
  await waitFor(() => runtime.dispatched.length === 1, "the dispatch");
  runtime.complete("thread-alpha", "listo, revisado");
  await waitFor(() => pushed.length === 1, "the push");
  assert.deepEqual(pushed[0], { title: "#Design", body: "listo, revisado", url: `/?room=${room.id}` });
  await done();
});

test("the framed prompt names the room, the teammates and the pass rule", async () => {
  const { room, done } = await roomWith({ mode: "panel" });
  const member = room.members.find((candidate) => candidate.slug === "beta")!;
  const text = promptFor({
    room: { ...room, description: "Design review", guidance: "Short answers" },
    member,
    message: { text: "hola" },
    lines: ["User: hola"],
    nameOf: (slug: string) => roster.find((bot) => bot.slug === slug)!.name,
  });
  assert.match(text, /\[Room "#Design" · with Alpha\]/);
  assert.match(text, /You are Beta, in a room with the user and Alpha/);
  assert.match(text, /reply exactly "\(pass\)"/);
  assert.match(text, /Design review/);
  assert.match(text, /Short answers/);
  assert.match(text, /they do not see your reply/);
  assert.match(text, /It's your turn, Beta\./);
  await done();
});

test("speakers ignore unavailable members", async () => {
  const { room, done } = await roomWith({ defaultResponder: "everyone" });
  const withGhost = { ...room, members: room.members.map((member) => member.slug === "beta" ? { ...member, status: "unavailable" as const } : member) };
  assert.deepEqual(speakersFor(withGhost, { text: "hola" }).map((member) => member.slug), ["alpha"]);
  await done();
});
