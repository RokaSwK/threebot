import assert from "node:assert/strict";
import { test } from "node:test";
import { addressedMembers, chainState, formatRoomLine, isPass, pickChainReply, pickReply } from "./room-lines.mts";

const members = [
  { slug: "alpha", name: "Alpha" },
  { slug: "beta", name: "Beta" },
  { slug: "max-power", name: "Max Power" },
];

test("addressedMembers reads the names the composer would insert", () => {
  assert.deepEqual(addressedMembers("Hola @Alpha, ¿ping?", members, "anywhere"), { slugs: ["alpha"], all: false });
  assert.deepEqual(addressedMembers("@Alpha and @Beta look", members, "anywhere").slugs, ["alpha", "beta"]);
  assert.deepEqual(addressedMembers("@Max Power take a look", members, "anywhere").slugs, ["max-power"]);
  assert.deepEqual(addressedMembers("nadie mencionado", members, "anywhere"), { slugs: [], all: false });
  assert.deepEqual(addressedMembers("@Alphaine is not Alpha", members, "anywhere"), { slugs: [], all: false });
  assert.deepEqual(addressedMembers("mail a foo@Alpha.com", members, "anywhere"), { slugs: [], all: false });
});

test("addressedMembers honors code fences and the leading policy", () => {
  assert.deepEqual(addressedMembers("mira `@Beta` aqui", members, "anywhere").slugs, [], "inline code is not a mention");
  assert.deepEqual(addressedMembers("```\n@Beta\n```\n@Alpha", members, "anywhere").slugs, ["alpha"]);
  assert.deepEqual(addressedMembers("Hello @Alpha", members, "leading").slugs, [], "leading needs the mention first");
  assert.deepEqual(addressedMembers("@Alpha hello @Beta", members, "leading").slugs, ["alpha"]);
});

test("@all and @everyone address every member", () => {
  const everyone = ["alpha", "beta", "max-power"];
  assert.deepEqual(addressedMembers("@all standup", members, "anywhere"), { slugs: everyone, all: true });
  assert.deepEqual(addressedMembers("@everyone standup", members, "anywhere"), { slugs: everyone, all: true });
  assert.deepEqual(addressedMembers("@ALL: standup", members, "leading").slugs, everyone);
});

test("isPass only accepts the exact marker", () => {
  assert.equal(isPass("(pass)"), true);
  assert.equal(isPass("  (PASS)  "), true);
  assert.equal(isPass("pass"), true);
  assert.equal(isPass("passed the tests"), false);
  assert.equal(isPass("I'll pass on that, here is why: no."), false);
  assert.equal(isPass(""), false);
});

test("pickReply reads the last completed assistant message of that run", () => {
  const items = [
    { id: "a1", runId: "run-1", type: "assistant_message", status: "completed", text: "first", completedAt: "2026-01-01T00:00:01.000Z" },
    { id: "tool", runId: "run-1", type: "tool_call", status: "completed", text: "not a reply" },
    { id: "a2", runId: "run-1", type: "assistant_message", status: "completed", text: "second", completedAt: "2026-01-01T00:00:02.000Z" },
    { id: "b1", runId: "run-2", type: "assistant_message", status: "completed", text: "other run" },
    { id: "a3", runId: "run-1", type: "assistant_message", status: "streaming", text: "still typing" },
  ];
  assert.deepEqual(pickReply(items, "run-1"), { id: "a2", text: "second", at: "2026-01-01T00:00:02.000Z" });
  assert.equal(pickReply(items, "run-9"), null);
  assert.equal(pickReply(items, null), null);

  // Ordinal order wins over array position
  const outOfOrder = [
    { id: "late", runId: "run-1", type: "assistant_message", status: "completed", text: "later ordinal", ordinal: 5 },
    { id: "early", runId: "run-1", type: "assistant_message", status: "completed", text: "earlier ordinal", ordinal: 2 },
  ];
  assert.equal(pickReply(outOfOrder, "run-1")?.text, "later ordinal");
});

test("formatRoomLine names the author and marks a quote", () => {
  assert.equal(formatRoomLine({ at: "x", author: { kind: "user" }, text: "hola" }), "User: hola");
  assert.equal(formatRoomLine({ at: "x", author: { kind: "bot", slug: "a", name: "Alpha" }, text: " hey " }), "Alpha: hey");
  assert.equal(
    formatRoomLine({ at: "x", author: { kind: "bot", slug: "b", name: "Beta" }, text: "ok", replyToName: "Alpha" }),
    "Beta: [replying to Alpha] ok",
  );
});

/** A run that delegated: the dispatch run, a child row, and the wake-up run its completion starts. */
function delegatedItems(childStatus = "running") {
  return [
    { id: "ack", runId: "run-1", type: "assistant_message", status: "completed", text: "En marcha", completedAt: "2026-01-01T00:00:05.000Z" },
    { id: "child", runId: "run-1", type: "subagent", status: childStatus, title: "Assessment A", childThreadId: "child-a", subagentId: "sub-a", completedAt: childStatus === "running" ? null : "2026-01-01T00:00:20.000Z" },
  ];
}

test("chainState reports a run that ended with children still out as unsettled", () => {
  const chain = chainState(delegatedItems("running"), [{ id: "run-1", status: "completed" }], "run-1");
  assert.deepEqual(chain.runIds, ["run-1"]);
  assert.equal(chain.children.length, 1);
  assert.equal(chain.running, 1);
  assert.equal(chain.done, 0);
  assert.equal(chain.settled, false);
});

test("chainState follows the wake-up run a finished child starts", () => {
  const items = [
    ...delegatedItems("completed"),
    { id: "note", runId: "run-2", type: "notification", status: "completed", source: { kind: "delegated_task", childThreadId: "child-a" } },
    { id: "final", runId: "run-2", type: "assistant_message", status: "completed", text: "Informe final" },
  ];
  const running = chainState(items, [{ id: "run-1", status: "completed" }, { id: "run-2", status: "running" }], "run-1");
  assert.deepEqual(running.runIds, ["run-1", "run-2"]);
  assert.equal(running.settled, false, "the wake-up run is still working");
  const done = chainState(items, [{ id: "run-1", status: "completed" }, { id: "run-2", status: "completed" }], "run-1");
  assert.equal(done.settled, true);
  assert.equal(done.generation, 1);
});

test("chainState closes a child that finished without waking its parent after the grace", () => {
  const items = delegatedItems("completed");
  const runs = [{ id: "run-1", status: "completed" }];
  const early = chainState(items, runs, "run-1", { nowMs: Date.parse("2026-01-01T00:00:25.000Z"), graceMs: 15_000 });
  assert.equal(early.settled, false, "an older T3 may still deliver the wake-up");
  const late = chainState(items, runs, "run-1", { nowMs: Date.parse("2026-01-01T00:00:40.000Z"), graceMs: 15_000 });
  assert.equal(late.settled, true);
});

test("chainState stops following delegations after the generation cap", () => {
  const items = [
    ...delegatedItems("completed"),
    { id: "note", runId: "run-2", type: "notification", status: "completed", source: { kind: "delegated_task", childThreadId: "child-a" } },
    { id: "child2", runId: "run-2", type: "subagent", status: "running", title: "Second generation", childThreadId: "child-b" },
  ];
  const chain = chainState(items, [{ id: "run-1", status: "completed" }, { id: "run-2", status: "completed" }], "run-1", { maxGenerations: 1 });
  assert.deepEqual(chain.runIds, ["run-1", "run-2"], "the cap stops the walk at the first generation");
  assert.equal(chain.children.length, 1);
  assert.equal(chain.settled, true, "what the room has is the answer once the cap is reached");
});

test("pickChainReply skips a pass and keeps the report", () => {
  const items = [
    { id: "ack", runId: "run-1", type: "assistant_message", status: "completed", text: "En marcha", completedAt: "2026-01-01T00:00:05.000Z" },
    { id: "pass", runId: "run-2", type: "assistant_message", status: "completed", text: "(pass)" },
    { id: "report", runId: "run-3", type: "assistant_message", status: "completed", text: "Informe", completedAt: "2026-01-01T00:00:40.000Z" },
  ];
  assert.deepEqual(pickChainReply(items, ["run-1", "run-2", "run-3"]), { id: "report", runId: "run-3", text: "Informe", at: "2026-01-01T00:00:40.000Z" });
  assert.equal(pickChainReply(items, ["run-9"]), null);
  // Every message a pass: the room still gets the last one, so the member is not silent.
  const passes = [
    { id: "p1", runId: "run-1", type: "assistant_message", status: "completed", text: "(pass)" },
    { id: "p2", runId: "run-2", type: "assistant_message", status: "completed", text: "(pass)" },
  ];
  assert.equal(pickChainReply(passes, ["run-1", "run-2"])?.id, "p2");
});

test("pickChainReply takes the latest message even when the caller hands items unordered", () => {
  // The room view keeps items in a map: their order is the order they arrived, not the order they
  // happened. The chain's last word must still be the newest one.
  const items = [
    { id: "report", runId: "run-3", type: "assistant_message", status: "completed", text: "Informe", completedAt: "2026-01-01T00:00:40.000Z" },
    { id: "ack", runId: "run-1", type: "assistant_message", status: "completed", text: "En marcha", completedAt: "2026-01-01T00:00:05.000Z" },
    { id: "note", runId: "run-2", type: "assistant_message", status: "completed", text: "Falta la segunda", completedAt: "2026-01-01T00:00:20.000Z" },
  ];
  assert.deepEqual(pickChainReply(items, ["run-1", "run-2", "run-3"]), { id: "report", runId: "run-3", text: "Informe", at: "2026-01-01T00:00:40.000Z" });
});

test("chainState counts a child that finished inside its own run as delivered", () => {
  // The Bot waited for its delegate inside the run: T3 reports the completion in the same turn and
  // no wake-up run is expected, so the room must not sit out the grace.
  const items = delegatedItems("completed");
  const runs = [{ id: "run-1", status: "completed", completedAt: "2026-01-01T00:00:25.000Z" }];
  const chain = chainState(items, runs, "run-1", { nowMs: Date.parse("2026-01-01T00:00:26.000Z"), graceMs: 15_000 });
  assert.equal(chain.settled, true);
});
