import assert from "node:assert/strict";
import { test } from "node:test";
import { addressedMembers, formatRoomLine, isPass, pickReply } from "./room-lines.mts";

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
});

test("formatRoomLine names the author and marks a quote", () => {
  assert.equal(formatRoomLine({ at: "x", author: { kind: "user" }, text: "hola" }), "User: hola");
  assert.equal(formatRoomLine({ at: "x", author: { kind: "bot", slug: "a", name: "Alpha" }, text: " hey " }), "Alpha: hey");
  assert.equal(
    formatRoomLine({ at: "x", author: { kind: "bot", slug: "b", name: "Beta" }, text: "ok", replyToName: "Alpha" }),
    'Beta: [replying to Alpha: "ok"] ok',
  );
});
