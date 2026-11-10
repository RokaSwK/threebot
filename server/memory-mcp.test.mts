import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryTools } from "./memory-mcp.mts";
import type { MemoryMessage } from "./memory.mts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "threebot-memory-mcp-"));
  const botsRoot = path.join(root, "bots");
  const botDir = path.join(botsRoot, "alpha");
  const sharedFile = path.join(botsRoot, ".botapp", "shared-memory.md");
  await mkdir(path.join(botDir, "memory"), { recursive: true });
  await mkdir(path.dirname(sharedFile), { recursive: true });
  await writeFile(path.join(botDir, "memory", "MEMORY.md"), "# Alpha memory\n\n");
  await writeFile(sharedFile, "# Shared facts\n\n");
  const messages: MemoryMessage[] = [
    { id: "m1", text: "I prefer short answers, please.", createdBy: "user", creationSource: "web" },
  ];
  const reflected = () => messages.map((message, position) => ({ ...message, position, at: "2026-11-09T10:00:00.000Z" }));
  const source = {
    async latestOwnerMessage() { return messages.at(-1) ?? null; },
    async messageById(_slug: string, id: string) { return messages.find((message) => message.id === id) ?? null; },
    async reflectMessages(_slug: string, afterPosition: number, limit: number) {
      const list = reflected().filter((message) => message.position > afterPosition).slice(0, limit);
      const last = list.at(-1) ?? null;
      return { messages: list, nextPosition: last?.position ?? null, lastMessageId: last?.id ?? null };
    },
    async reflectMessageById(_slug: string, id: string) { return reflected().find((message) => message.id === id) ?? null; },
  };
  const call = createMemoryTools({ botsRoot, sharedFile, source });
  return { botsRoot, botDir, sharedFile, messages, call };
}

function parse(result: { content: { text: string }[]; isError?: boolean }) {
  return JSON.parse(result.content[0]!.text);
}

test("memory tools require a Bot's own bearer", async () => {
  const { call } = await fixture();
  const noAuth = await call("memory_read", {}, {});
  assert.equal(noAuth.isError, true);
  assert.match(noAuth.content[0]!.text, /own MCP token/iu);
  const legacy = await call("memory_read", {}, { botSlug: null, legacy: true });
  assert.equal(legacy.isError, true);
  assert.match(legacy.content[0]!.text, /legacy token/iu);
});

test("memory_read returns the bot file, shared file and notes index", async () => {
  const { call } = await fixture();
  const result = await call("memory_read", {}, { botSlug: "alpha", legacy: false });
  assert.equal(result.isError, undefined);
  const body = parse(result);
  assert.match(body.bot, /Alpha memory/u);
  assert.match(body.shared, /Shared facts/u);
  assert.ok(body.revision);
  assert.ok(body.sharedRevision);
  assert.deepEqual(body.notes, []);
});

test("memory_edit saves a fact with evidence and memory_read sees it", async () => {
  const { call } = await fixture();
  const read = parse(await call("memory_read", {}, { botSlug: "alpha", legacy: false }));
  const saved = await call("memory_edit", {
    op: "add", fact: "Prefers short answers.", category: "preference",
    expectedRevision: read.revision, sourceQuote: "prefer short answers",
  }, { botSlug: "alpha", legacy: false });
  assert.equal(saved.isError, undefined);
  const result = parse(saved);
  assert.equal(result.ok, true);
  assert.match(result.line, /Prefers short answers/u);
  const after = parse(await call("memory_read", {}, { botSlug: "alpha", legacy: false }));
  assert.match(after.bot, /Prefers short answers/u);
  assert.notEqual(after.revision, read.revision);
});

test("memory_edit refuses pasted evidence and stale revisions", async () => {
  const { call, messages } = await fixture();
  const read = parse(await call("memory_read", {}, { botSlug: "alpha", legacy: false }));
  messages.push({ id: "m2", text: "> The launch is Thursday.\n\nPlease remember this.", createdBy: "user", creationSource: "web" });
  const pasted = await call("memory_edit", {
    op: "add", fact: "The launch is Thursday.", expectedRevision: read.revision, sourceQuote: "the launch is Thursday",
  }, { botSlug: "alpha", legacy: false });
  assert.equal(pasted.isError, true);
  assert.match(pasted.content[0]!.text, /pasted|quoted|code block|forwarded/iu);

  const stale = await call("memory_edit", {
    op: "add", fact: "Another fact.", expectedRevision: "not-the-revision", sourceQuote: "prefer short answers", sourceMessageId: "m1",
  }, { botSlug: "alpha", legacy: false });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0]!.text, /conflict/iu);
});

test("shared scope and note reads", async () => {
  const { call, messages } = await fixture();
  messages.push({ id: "m2", text: "My name is Cristian and I live in Ås.", createdBy: "user", creationSource: "web" });
  const read = parse(await call("memory_read", {}, { botSlug: "alpha", legacy: false }));
  const saved = await call("memory_edit", {
    op: "add", scope: "shared", fact: "The user's name is Cristian.", expectedRevision: read.sharedRevision, sourceMessageId: "m2", sourceQuote: "my name is Cristian",
  }, { botSlug: "alpha", legacy: false });
  assert.equal(saved.isError, undefined);
  const shared = parse(await call("memory_read", { scope: "shared" }, { botSlug: "alpha", legacy: false }));
  assert.match(shared.shared, /The user's name is Cristian/u);

  messages.push({ id: "m3", text: "Please write a note about the deploy.", createdBy: "user", creationSource: "web" });
  const note = await call("memory_edit", {
    op: "note", path: "memory/notes/projects/alpha.md", description: "Alpha deploy", content: "Runs on the HP server.",
    expectedRevision: "", sourceMessageId: "m3", sourceQuote: "write a note about the deploy",
  }, { botSlug: "alpha", legacy: false });
  assert.equal(note.isError, undefined);
  const topic = parse(await call("memory_read", { topic: "memory/notes/projects/alpha.md" }, { botSlug: "alpha", legacy: false }));
  assert.match(topic.content, /Runs on the HP server/u);
  assert.ok(topic.revision);
});

test("memory_reflect returns a bookmark and memory_reflect_apply audits and advances it", async () => {
  const { call, botDir, messages } = await fixture();
  const packet = parse(await call("memory_reflect", {}, { botSlug: "alpha", legacy: false }));
  assert.equal(packet.messages.length, 1);
  assert.equal(packet.nextPosition, 0);
  assert.equal(packet.lastMessageId, "m1");
  assert.ok(packet.revision);

  const applied = await call("memory_reflect_apply", {
    operations: [{ op: "add", fact: "Prefers short answers.", category: "preference", sourceMessageId: "m1", sourceQuote: "prefer short answers" }],
    expectedRevision: packet.revision,
    throughPosition: packet.nextPosition,
    lastMessageId: packet.lastMessageId,
  }, { botSlug: "alpha", legacy: false });
  assert.equal(applied.isError, undefined);
  const result = parse(applied);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.match(await readFile(path.join(botDir, "memory", "MEMORY.md"), "utf8"), /Prefers short answers/u);
  assert.match(await readFile(path.join(botDir, "memory", "DREAMS.md"), "utf8"), /reflect 1 applied/u);
  const state = JSON.parse(await readFile(path.join(botDir, "memory", ".state.json"), "utf8"));
  assert.equal(state.reflection.lastPosition, 0);
  assert.equal(state.reflection.lastMessageId, "m1");

  const next = parse(await call("memory_reflect", {}, { botSlug: "alpha", legacy: false }));
  assert.equal(next.messages.length, 0);

  messages.push({ id: "m2", text: "My framework for tests is Vue.", createdBy: "user", creationSource: "web" });
  const second = parse(await call("memory_reflect", {}, { botSlug: "alpha", legacy: false }));
  assert.equal(second.messages[0].id, "m2");
  const stale = await call("memory_reflect_apply", {
    operations: [{ op: "add", fact: "Uses Vue.", sourceMessageId: "m1", sourceQuote: "prefer short answers" }],
    expectedRevision: second.revision, throughPosition: second.nextPosition, lastMessageId: second.lastMessageId,
  }, { botSlug: "alpha", legacy: false });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0]!.text, /before the reflection bookmark/iu);
});

test("memory_note_split reads revisions and splits at headings", async () => {
  const { call, botDir } = await fixture();
  await mkdir(path.join(botDir, "memory", "notes"), { recursive: true });
  const notePath = "memory/notes/topic.md";
  await writeFile(path.join(botDir, notePath), "# Topic\n\nIntro.\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n");
  const read = parse(await call("memory_read", { topic: notePath, full: true }, { botSlug: "alpha", legacy: false }));
  const split = await call("memory_note_split", { path: notePath, expectedRevision: read.revision }, { botSlug: "alpha", legacy: false });
  assert.equal(split.isError, undefined);
  const result = parse(split);
  assert.equal(result.ok, true);
  assert.equal(result.parts.length, 2);
  assert.match(await readFile(path.join(botDir, result.parts[0]!), "utf8"), /First\./u);
});

test("memory_defrag audits and safely dedupes exact lines", async () => {
  const { call, botDir } = await fixture();
  await writeFile(path.join(botDir, "memory", "MEMORY.md"), "# Alpha memory\n\n- [fact] Duplicate.\n- [fact] Duplicate.\n- [fact] Unique.\n");
  const audit = await call("memory_defrag", { op: "audit" }, { botSlug: "alpha", legacy: false });
  assert.equal(audit.isError, undefined);
  const report = parse(audit);
  assert.ok(report.planPath);
  assert.equal(report.counts.exactDuplicateFacts, 1);
  const dedupe = await call("memory_defrag", { op: "safe-dedupe" }, { botSlug: "alpha", legacy: false });
  assert.equal(dedupe.isError, undefined);
  assert.equal(parse(dedupe).removed, 1);
  const memory = await readFile(path.join(botDir, "memory", "MEMORY.md"), "utf8");
  assert.equal((memory.match(/Duplicate\./gu) ?? []).length, 1);
});

test("memory_defrag retires closed facts without dropping them", async () => {
  const { call, botDir } = await fixture();
  await writeFile(path.join(botDir, "memory", "MEMORY.md"), "# Alpha memory\n\n- [fact] @valid[2020-01-01,2020-02-01) Old.\n- [fact] Current.\n");
  const result = await call("memory_defrag", { op: "retire-closed" }, { botSlug: "alpha", legacy: false });
  assert.equal(result.isError, undefined);
  const payload = parse(result);
  assert.equal(payload.removed, 1);
  assert.match(await readFile(path.join(botDir, "memory", "notes", "history", "closed-2026-11.md"), "utf8"), /Old\./u);
});

test("memory_forget removes a fact and memory_search finds notes", async () => {
  const { call, messages } = await fixture();
  const read = parse(await call("memory_read", {}, { botSlug: "alpha", legacy: false }));
  const saved = parse(await call("memory_edit", {
    op: "add", fact: "Likes coffee.", expectedRevision: read.revision, sourceQuote: "prefer short answers",
  }, { botSlug: "alpha", legacy: false }));
  messages.push({ id: "m2", text: "Please forget that I like coffee.", createdBy: "user", creationSource: "web" });
  const forgotten = await call("memory_forget", {
    fact: saved.line, expectedRevision: saved.revision, sourceQuote: "forget that I like coffee",
  }, { botSlug: "alpha", legacy: false });
  assert.equal(forgotten.isError, undefined);
  assert.equal(parse(forgotten).ok, true);
  const after = await call("memory_forget", {
    fact: saved.line, expectedRevision: saved.revision, sourceQuote: "forget that I like coffee",
  }, { botSlug: "alpha", legacy: false });
  assert.equal(after.isError, true);

  messages.push({ id: "m3", text: "Please write a note about the deploy.", createdBy: "user", creationSource: "web" });
  const read2 = parse(await call("memory_read", {}, { botSlug: "alpha", legacy: false }));
  const note = await call("memory_edit", {
    op: "note", path: "memory/notes/projects/alpha.md", description: "Alpha deploy", content: "Runs on the HP server.",
    expectedRevision: "", sourceQuote: "write a note about the deploy",
  }, { botSlug: "alpha", legacy: false });
  assert.equal(note.isError, undefined);
  const hits = parse(await call("memory_search", { query: "HP server" }, { botSlug: "alpha", legacy: false }));
  assert.equal(hits.results[0]?.path, "memory/notes/projects/alpha.md");
});
