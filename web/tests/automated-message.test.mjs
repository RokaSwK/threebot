import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "vite";

const src = new URL("../src/", import.meta.url).pathname;
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "automated-message-test-entry",
    resolveId: (id) => id.endsWith("virtual:automated-message-test") ? "\0automated-message-test" : undefined,
    load: (id) => id === "\0automated-message-test"
      ? `export { automatedMessage } from ${JSON.stringify(`${src}lib/automatedMessage.ts`)};
         export { buildEntries } from ${JSON.stringify(`${src}lib/transcript.ts`)};`
      : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:automated-message-test", write: false },
});
const entry = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
assert.ok(entry, "test bundle has an entry point");
const { automatedMessage, buildEntries } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);

const monitoring = 'From T3: Roka authorized event-driven monitoring on 2026-10-31. Read the policy. Do not create additional schedules. Event summary: [{"event": "new", "code": "dns_security_list_blocks:b71389116cb49f4df0c3", "level": "warning", "message": "dns_security_list_blocks requires evidence review; not proof of compromise"}, {"event": "persistent", "code": "required_service_down:1b3cffe71c18c068f3c3", "level": "critical", "message": "required_service_down requires evidence review; not proof of compromise"}]';
const server = (text) => ({ createdBy: "user", creationSource: "server", text });

test("the monitoring brief becomes readable issues and keeps its instructions", () => {
  const message = automatedMessage(server(monitoring));
  assert.equal(message.from, "T3");
  assert.equal(message.summary, "Monitoring check");
  assert.deepEqual(message.issues.map(({ title, level, state }) => ({ title, level, state })), [
    { title: "Required service down", level: "critical", state: "Ongoing" },
    { title: "DNS security list blocks", level: "warning", state: "New" },
  ]);
  assert.match(message.text, /Do not create additional schedules\.$/);
  assert.doesNotMatch(message.text, /Event summary/);
});

test("your own words are never treated as automation", () => {
  assert.equal(automatedMessage({ createdBy: "user", creationSource: "web", text: monitoring }), null);
  assert.equal(automatedMessage(server("Please check the logs")), null);
  assert.equal(automatedMessage({ createdBy: "agent", creationSource: "server", text: monitoring }), null);
  assert.equal(automatedMessage({ ...server(monitoring), senderThreadId: "bot" }), null);
  assert.equal(automatedMessage({ createdBy: "user", creationSource: "server" }), null);
});

test("a brief without events, or with broken events, still reads", () => {
  const plain = automatedMessage(server("From Cron: Rotate the logs tonight. Then report back."));
  assert.equal(plain.summary, "Rotate the logs tonight.");
  assert.deepEqual(plain.issues, []);
  const broken = automatedMessage(server("From T3: Look at this. Event summary: [not json]"));
  assert.deepEqual(broken.issues, []);
  assert.match(broken.text, /Event summary/);
  assert.ok(automatedMessage(server(`From T3: ${"x".repeat(400)}`)).summary.length <= 110);
});

test("unknown fields degrade quietly", () => {
  const message = automatedMessage(server('From T3: Check. Event summary: [{"code":"disk_full","event":"odd_state"},{"nope":1},"x"]'));
  assert.deepEqual(message.issues.map(({ title, level, state }) => [title, level, state]), [["Disk full", "info", "Odd state"]]);
});

test("the transcript shows a card, not a user bubble, attributed to the Bot", () => {
  const t3 = { name: "T3", slug: "orcestrator" };
  const item = { id: "m1", type: "user_message", messageId: "m1", runId: "r1", ordinal: 1, startedAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z", attachments: [], ...server(monitoring) };
  const entries = buildEntries([item], { bot: { name: "Cyber", workspaceRoot: "/w" }, botsByThread: new Map([["t", t3]]), tasks: [], requests: {} });
  assert.deepEqual(entries.map((e) => e.kind), ["date", "automated"]);
  assert.equal(entries[1].fromBot, t3);
  assert.equal(entries.some((e) => e.kind === "user"), false);
});
