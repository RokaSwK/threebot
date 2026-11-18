import assert from "node:assert/strict";
import { test } from "node:test";
import { addressedMembers, chainReply, formatRoomLine, isPass, pickReply } from "./room-lines.mts";

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

test("a completed dispatch only answers once its delegated work and wake-up have finished", () => {
  const root = { id: "run-1", status: "completed", completedAt: "2026-01-01T00:00:05Z" };
  assert.equal(chainReply(delegatedItems(), [root], root.id).reply, null);
  const items = [
    ...delegatedItems("completed"),
    { id: "note", runId: "run-2", type: "notification", source: { kind: "delegated_task", childThreadId: "child-a" } },
    { id: "final", runId: "run-2", type: "assistant_message", status: "completed", text: "Informe final" },
  ];
  assert.equal(chainReply(items, [root, { id: "run-2", status: "running" }], root.id).reply, null);
  assert.equal(chainReply(items, [root, { id: "run-2", status: "completed" }], root.id).reply?.text, "Informe final");
  assert.equal(chainReply(items, [root, { id: "run-2", status: "failed" }], root.id).reply, null);
});

test("an undelivered child completion times out without publishing the acknowledgement", () => {
  const items = delegatedItems("completed");
  const runs = [{ id: "run-1", status: "completed" }];
  const early = chainReply(items, runs, "run-1", Date.parse("2026-01-01T00:00:25Z"));
  assert.equal(early.chain.stalled, false);
  const late = chainReply(items, runs, "run-1", Date.parse("2026-01-01T00:00:40Z"));
  assert.equal(late.chain.stalled, true);
  assert.equal(late.reply, null);
});

test("a child the member waited on in the same run needs no wake-up", () => {
  const items = delegatedItems("completed");
  const runs = [{ id: "run-1", status: "completed", completedAt: "2026-01-01T00:00:25Z" }];
  assert.equal(chainReply(items, runs, "run-1").reply?.id, "ack");
});

test("a batched completion matches remote children by task ID", () => {
  const [ack, child] = delegatedItems("completed");
  const items = [
    ack,
    { ...child, childThreadId: null },
    { ...child, id: "other", childThreadId: null, subagentId: "remote-b" },
    { id: "turn-item:message:child%3Awake", type: "notification", runId: "wake", outcome: "completed", source: { kind: "delegated_task", taskIds: ["sub-a", "remote-b"] } },
    { ...ack, id: "report", runId: "wake", text: "Both results" },
  ];
  const runs = [{ id: "run-1", status: "completed" }, { id: "wake", userMessageId: "child:wake", status: "completed" }];
  assert.equal(chainReply(items, runs, "run-1").reply?.text, "Both results");
});

test("a question exposes its wake run without answering, and a steered completion owns no reply", () => {
  const [ack, child] = delegatedItems();
  const notice = { id: "turn-item:message:question", type: "notification", runId: "wake", outcome: "updated", source: { kind: "delegated_task", taskIds: ["sub-a"] } };
  const interim = { ...ack, runId: "wake", text: "Waiting for an answer" };
  const runs = [{ id: "run-1", status: "completed" }, { id: "wake", userMessageId: "question", status: "completed" }];
  const awaiting = chainReply([ack, child, notice, interim], runs, "run-1");
  assert.deepEqual(awaiting.chain.runIds, ["run-1", "wake"]);
  assert.equal(awaiting.reply, null);
  const completed = { ...child, status: "completed", completedAt: "2026-01-01T00:00:20Z" };
  const steered = { ...notice, id: "turn-item:message:completion", outcome: "completed" };
  const unaffiliated = chainReply([ack, completed, steered, interim], runs, "run-1");
  assert.deepEqual(unaffiliated.chain.runIds, ["run-1"]);
  assert.equal(unaffiliated.reply, null);
});

test("a task marked pending delivery is not an inline answer even if it finished before its dispatch", () => {
  const items = delegatedItems("completed");
  const runs = [{ id: "run-1", status: "completed", completedAt: "2026-01-01T00:00:25Z" }];
  const tasks = [{ id: "sub-a", status: "completed", completionDelivery: { state: "pending" } }];
  const { reply, chain } = chainReply(items, runs, "run-1", Date.parse("2026-01-01T00:00:26Z"), tasks);
  assert.equal(chain.settled, false);
  assert.equal(reply, null);
});
