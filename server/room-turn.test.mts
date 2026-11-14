import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRooms, validateMembers, type Room } from "./rooms.mts";
import { createRoomEngine, crossMentions, promptFor, speakersFor } from "./room-turn.mts";

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
    wait(threadId: string) {
      const run = runs.get(threadId);
      if (run) Object.assign(run, { status: "waiting" });
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

const waitFor = async (check: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000) => {
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
  assert.deepEqual(stored.turns[0].runs.map(({ slug, runId }) => ({ slug, runId })), [{ slug: "beta", runId: "run-1" }]);
  assert.equal(stored.turns[0].runs[0].status, "replied");
  assert.equal(stored.members.find((member) => member.slug === "beta")!.lastTurnAt, "2026-01-01T00:00:05.000Z");
  assert.equal(turn.status, "queued");
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

test("a roundtable passes the floor: each member sees what was said before", async () => {
  const { room, file, done } = await roomWith({ mode: "roundtable", defaultResponder: "everyone" });
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "debatan" });
  await waitFor(() => runtime.dispatched.length === 1, "the first speaker");
  assert.equal(runtime.dispatched[0].threadId, "thread-alpha", "members speak in room order");
  runtime.complete("thread-alpha", "Alpha abre el debate");
  await waitFor(() => runtime.dispatched.length === 2, "the second speaker");
  assert.equal(runtime.dispatched[1].threadId, "thread-beta");
  assert.match(runtime.dispatched[1].text, /Alpha: Alpha abre el debate/, "the second member hears the first");
  runtime.complete("thread-beta", "Beta responde");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  await done();
});

test("a roundtable rotates the first speaker on the next turn", async () => {
  const { room, file, done } = await roomWith({ mode: "roundtable", defaultResponder: "everyone" });
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "primero" });
  await waitFor(() => runtime.dispatched.length === 1, "the first speaker");
  assert.equal(runtime.dispatched[0].threadId, "thread-alpha");
  runtime.complete("thread-alpha", "uno");
  await waitFor(() => runtime.dispatched.length === 2, "the second speaker");
  runtime.complete("thread-beta", "dos");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the first turn");

  await engine.send(room.id, { text: "segundo" });
  await waitFor(() => runtime.dispatched.length === 3, "the next turn's first speaker");
  assert.equal(runtime.dispatched[2].threadId, "thread-beta", "the next turn starts one member later");
  runtime.complete("thread-beta", "tres");
  await waitFor(() => runtime.dispatched.length === 4, "the next turn's second speaker");
  runtime.complete("thread-alpha", "cuatro");
  await waitFor(async () => (await rooms.get(room.id))!.turns[1].status === "done", "the second turn");
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

test("a member past its timeout is marked late and does not reopen the turn", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const engine = createRoomEngine({
    rooms,
    rpc: runtime,
    bots: async () => bots,
    defaults: async () => ({}),
    pollMs: 1,
    nowMs: () => { clock += 61_000; return clock; },
  });
  await engine.send(room.id, { text: "@Alpha tarda" });
  await waitFor(() => runtime.dispatched.length === 1, "the dispatch");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status !== "running", "the turn to close");
  const stored = (await rooms.get(room.id))!;
  assert.deepEqual(stored.turns[0].runs.map(({ slug, runId, late }) => ({ slug, runId, late })), [{ slug: "alpha", runId: "run-1", late: true }]);
  assert.equal(stored.turns[0].runs[0].status, "timeout");
  assert.equal(runtime.dispatched.filter((command) => command.type === "message.dispatch").length, 1, "a late member is not dispatched again");
  await done();
});

test("a mention inside a roundtable reply brings that member back in", async () => {
  const { room, file, done } = await roomWith({ mode: "roundtable", allowCrossMentions: true, maxWaves: 3 });
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "@Alpha empieza tú" });
  await waitFor(() => runtime.dispatched.length === 1, "the first speaker");
  runtime.complete("thread-alpha", "Le paso la palabra a @Beta");
  await waitFor(() => runtime.dispatched.length === 2, "the wave the mention started");
  assert.equal(runtime.dispatched[1].threadId, "thread-beta");
  assert.match(runtime.dispatched[1].text, /Alpha: Le paso la palabra a @Beta/);
  runtime.complete("thread-beta", "Gracias, aquí estoy");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  const stored = (await rooms.get(room.id))!;
  assert.equal(stored.turns[0].runs.length, 2, "the turn records both runs");
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
  const { room, file, done } = await roomWith({ mode: "roundtable", defaultResponder: "everyone", maxReplies: 1 });
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

test("a member that already spoke is not woken again by a courtesy mention", async () => {
  const { room, file, done } = await roomWith({ mode: "roundtable", defaultResponder: "everyone", maxWaves: 5, maxReplies: 15 });
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "preséntense" });
  await waitFor(() => runtime.dispatched.length === 1, "the first speaker");
  runtime.complete("thread-alpha", "Alpha se presenta. @Beta, ¿algo que decir?");
  await waitFor(() => runtime.dispatched.length === 2, "the second speaker");
  runtime.complete("thread-beta", "Beta se presenta");
  // Alpha named Beta, who had not spoken yet; Beta naming Alpha back must not loop.
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  assert.deepEqual(runtime.dispatched.map((command) => command.threadId), ["thread-alpha", "thread-beta"]);
  await done();
});

test("crossMentions reads the mentions of the last wave", async () => {
  const { room, done } = await roomWith({ mode: "roundtable" });
  assert.deepEqual(crossMentions([{ slug: "alpha", text: "@Beta mira esto" }], room).map((member) => member.slug), ["beta"]);
  assert.deepEqual(crossMentions([{ slug: "alpha", text: "@all a ver" }], room).map((member) => member.slug), ["beta"]);
  assert.deepEqual(crossMentions([{ slug: "alpha", text: "sin menciones" }], room), []);
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
  assert.equal(stored.turns[0].status, "failed", "a room whose only answer failed has no answer");
  assert.deepEqual(stored.turns[0].runs.map(({ slug, runId }) => ({ slug, runId })), [{ slug: "alpha", runId: "run-1" }]);
  assert.equal(stored.turns[0].runs[0].status, "failed");
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

test("two sends in the same tick: one runs and the other is queued", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  const [first, second] = await Promise.all([
    engine.send(room.id, { text: "first" }),
    engine.send(room.id, { text: "second" }),
  ]);
  assert.deepEqual([first.queued, second.queued].sort(), [false, true], "one turn owns the room");
  const stored = (await rooms.get(room.id))!;
  assert.equal(stored.turns.length, 2);
  assert.equal(stored.turns[0].status, "running");
  assert.equal(stored.turns[1].status, "queued");
  await waitFor(() => runtime.dispatched.filter((command) => command.type === "message.dispatch").length === 1, "the first dispatch");
  runtime.complete("thread-alpha", "one");
  await waitFor(() => runtime.dispatched.filter((command) => command.type === "message.dispatch").length === 2, "the queued dispatch");
  runtime.complete("thread-alpha", "two");
  await waitFor(async () => (await rooms.get(room.id))!.turns.every((turn) => turn.status === "done"), "both turns done");
  await done();
});

test("a new turn after Stop keeps the room busy", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "one" });
  await waitFor(() => runtime.dispatched.length === 1, "the first dispatch");
  await engine.stop(room.id);
  const second = await engine.send(room.id, { text: "two" });
  assert.equal(second.queued, false, "a stopped room accepts a new turn");
  await waitFor(() => runtime.dispatched.filter((command) => command.type === "message.dispatch").length === 2, "the second dispatch");
  assert.equal(engine.isBusy(room.id), true, "the old turn's cleanup did not release the new one");
  runtime.complete("thread-alpha", "done");
  await waitFor(async () => (await rooms.get(room.id))!.turns[1].status === "done", "the second turn done");
  await done();
});

test("a turn that throws before the first member closes as failed", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  let calls = 0;
  const engine = createRoomEngine({
    rooms,
    rpc: runtime,
    bots: async () => { calls += 1; if (calls === 1) throw new Error("roster exploded"); return bots; },
    defaults: async () => ({}),
    pollMs: 1,
  });
  await engine.send(room.id, { text: "boom" });
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status !== "running", "the turn to close");
  const stored = (await rooms.get(room.id))!;
  assert.equal(stored.turns[0].status, "failed");
  assert.equal(engine.isBusy(room.id), false);
  await done();
});

test("each roundtable member gets its own timeout", async () => {
  const { room, file, done } = await roomWith({ mode: "roundtable", memberTimeoutMin: 1, turnDeadlineMin: 10, defaultResponder: "everyone", maxWaves: 1 });
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1, nowMs: () => clock });
  await engine.send(room.id, { text: "debate" });
  await waitFor(() => runtime.dispatched.length === 1, "the first dispatch");
  clock += 50_000;
  runtime.complete("thread-alpha", "first");
  await waitFor(() => runtime.dispatched.length === 2, "the second dispatch");
  // The second member started 50 s in. A shared deadline would time it out at 60 s; its own
  // timeout keeps it alive until 110 s.
  clock += 30_000;
  runtime.complete("thread-beta", "second");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  const stored = (await rooms.get(room.id))!;
  assert.equal(stored.turns[0].runs.find((run) => run.slug === "beta")?.status, "replied");
  assert.equal(stored.turns[0].runs.find((run) => run.slug === "beta")?.late, undefined);
  await done();
});

test("a member waiting for the user sends one push", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const pushed: any[] = [];
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1, notify: (payload) => { pushed.push(payload); } });
  await engine.send(room.id, { text: "needs approval" });
  await waitFor(() => runtime.dispatched.length === 1, "the dispatch");
  runtime.wait("thread-alpha");
  const waitingPushes = () => pushed.filter((payload) => /waiting for you/.test(payload.body));
  await waitFor(() => waitingPushes().length === 1, "the waiting push");
  assert.match(waitingPushes()[0].body, /Alpha is waiting for you/);
  runtime.complete("thread-alpha", "approved");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the turn to finish");
  assert.equal(waitingPushes().length, 1, "one waiting push, not one per poll");
  await done();
});

test("a removed member keeps its replies in the room's history", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "hola" });
  await waitFor(() => runtime.dispatched.length === 1, "the first dispatch");
  runtime.complete("thread-alpha", "soy Alpha");
  await waitFor(async () => (await rooms.get(room.id))!.turns[0].status === "done", "the first turn");
  const updated = await rooms.update(room.id, { members: [{ slug: "beta", name: "Beta" }] });
  assert.deepEqual(updated.formerMembers.map((member) => member.slug), ["alpha"]);
  assert.ok(updated.formerMembers[0].threadId);
  await engine.send(room.id, { text: "¿quién habló?" });
  await waitFor(() => runtime.dispatched.length === 2, "the second dispatch");
  assert.match(runtime.dispatched[1].text, /Alpha: soy Alpha/, "the former member's line remains in the room history");
  runtime.complete("thread-beta", "Alpha habló");
  await waitFor(async () => (await rooms.get(room.id))!.turns[1].status === "done", "the second turn");
  await done();
});

test("Stop marks queued messages stopped", async () => {
  const { room, file, done } = await roomWith();
  const runtime = fakeRuntime();
  const rooms = createRooms({ file });
  const engine = createRoomEngine({ rooms, rpc: runtime, bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  await engine.send(room.id, { text: "one" });
  await waitFor(() => runtime.dispatched.length === 1, "the first dispatch");
  await engine.send(room.id, { text: "two" });
  await engine.stop(room.id);
  const stored = (await rooms.get(room.id))!;
  assert.deepEqual(stored.turns.map((turn) => turn.status), ["stopped", "stopped"]);
  assert.equal(engine.queued(room.id), 0);
  await done();
});

test("recover marks queued messages interrupted", async () => {
  const { room, file, done } = await roomWith();
  const rooms = createRooms({ file });
  await rooms.appendTurn(room.id, { id: "q1", at: "2026-01-01T00:00:00.000Z", text: "later", mentions: [], replyTo: null, status: "queued", runs: [] });
  const engine = createRoomEngine({ rooms, rpc: fakeRuntime(), bots: async () => bots, defaults: async () => ({}), pollMs: 1 });
  const interrupted = await engine.recover();
  assert.deepEqual(interrupted, [`${room.id}/q1`]);
  assert.equal((await rooms.get(room.id))!.turns[0].status, "interrupted");
  await done();
});
