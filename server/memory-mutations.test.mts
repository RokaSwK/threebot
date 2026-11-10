import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkOwnerEvidence,
  closeFactRange,
  hashFact,
  mutateMemory,
  readMemoryNoteWithRevision,
  readMemoryState,
  readMemoryView,
  readMemoryText,
  recoverMemoryJournals,
  revisionOf,
  searchMemory,
  typedRuns,
} from "./memory.mts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "threebot-memory-mutations-"));
  const botDir = path.join(root, "bots", "alpha");
  const sharedFile = path.join(root, "bots", ".botapp", "shared-memory.md");
  await mkdir(path.join(botDir, "memory"), { recursive: true });
  await mkdir(path.dirname(sharedFile), { recursive: true });
  await writeFile(path.join(botDir, "memory", "MEMORY.md"), "# Alpha memory\n\n");
  await writeFile(sharedFile, "# Shared facts (all Bots)\n\n");
  return { root, botDir, sharedFile };
}

async function botRevision(botDir: string) {
  return (await readMemoryText({ botDir, sharedFile: path.join(botDir, "..", ".botapp", "shared-memory.md"), scope: "bot" })).revision;
}

const now = new Date("2026-11-09T10:00:00.000Z");
const sourceText = "I prefer short answers, please. Also remember the launch is Thursday.";
const sourceQuote = "I prefer short answers";

test("typed runs drop fenced blocks, quotes and forwarded blocks", () => {
  const text = [
    "I typed this sentence.",
    "> quoted from a web page",
    "```",
    "pasted code",
    "```",
    "---------- Forwarded message ---------",
    "someone else's words",
    "",
    "And this is mine.",
  ].join("\n");
  const runs = typedRuns(text);
  assert.deepEqual(runs, ["I typed this sentence.", "And this is mine."]);
});

test("evidence requires a substantive phrase the user typed", () => {
  assert.equal(checkOwnerEvidence("I prefer short answers, please.", "prefer short answers").ok, true);
  assert.equal(checkOwnerEvidence("I prefer short answers, please.", "short answers").ok, false);
  assert.equal(checkOwnerEvidence("ok", "ok").ok, false);
  assert.equal(checkOwnerEvidence("```\nprefer short answers\n```", "prefer short answers").ok, false);
  assert.equal(checkOwnerEvidence("> prefer short answers", "prefer short answers").ok, false);
  assert.equal(checkOwnerEvidence("---------- Forwarded message ---------\nprefer short answers", "prefer short answers").ok, false);
});

test("add, duplicate, conflict, provenance and history", async () => {
  const { botDir, sharedFile } = await fixture();
  const before = await readMemoryText({ botDir, sharedFile, scope: "bot" });
  const result = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: before.revision,
    author: "alpha", sourceMessageId: "m42", sourceQuote, sourceText,
    fact: "Prefers short answers.", category: "preference", now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.line ?? "", /\[preference\] Prefers short answers\./u);
  assert.match(result.line ?? "", /\[source: thread\/m42; added: 2026-11-09\]/u);
  const after = await readFile(path.join(botDir, "memory", "MEMORY.md"), "utf8");
  assert.match(after, /Prefers short answers\./u);
  const state = await readMemoryState(botDir);
  assert.equal(state.provenance[hashFact("Prefers short answers.")]?.sourceMessageId, "m42");
  assert.equal((await readFile(result.revision ? path.join(botDir, "memory", "MEMORY.md") : "", "utf8")).length > 0, true);
  assert.equal((await readdir(path.join(botDir, "memory", "history"))).length, 1);

  const duplicate = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: result.revision,
    author: "alpha", sourceMessageId: "m43", sourceQuote, sourceText,
    fact: "Prefers short answers.", now,
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.code, "duplicate");

  const conflict = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: before.revision,
    author: "alpha", sourceMessageId: "m44", sourceQuote, sourceText,
    fact: "Another fact.", now,
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "conflict");
});

test("two writers holding the same revision cannot both win", async () => {
  const { root, botDir, sharedFile } = await fixture();
  try {
    const expectedRevision = (await readMemoryText({ botDir, sharedFile, scope: "shared" })).revision;
    const add = (author: string, fact: string) => mutateMemory({
      botDir: path.join(root, "bots", author), sharedFile, scope: "shared", op: "add", expectedRevision, author,
      sourceMessageId: "m1", sourceQuote, sourceText, fact, now,
    });
    const results = await Promise.all([add("alpha", "Timezone is Bogota."), add("beta", "The manager is Ana.")]);
    // Two Bots write shared memory at once. One lands; the other is told to read again.
    assert.deepEqual(results.map((result) => result.ok ? "ok" : result.code), ["ok", "conflict"]);
    const text = await readFile(sharedFile, "utf8");
    assert.match(text, /Timezone is Bogota\./u);
    assert.doesNotMatch(text, /manager is Ana/u);
    // The loser retries on the revision it was handed, and nothing is lost.
    const conflict = results[1]!;
    const retry = await mutateMemory({
      botDir: path.join(root, "bots", "beta"), sharedFile, scope: "shared", op: "add", expectedRevision: conflict.ok ? "" : conflict.revision!, author: "beta",
      sourceMessageId: "m1", sourceQuote, sourceText, fact: "The manager is Ana.", now,
    });
    assert.equal(retry.ok, true);
    const after = await readFile(sharedFile, "utf8");
    assert.match(after, /Timezone is Bogota\./u);
    assert.match(after, /The manager is Ana\./u);
    // A write that fails does not block the ones behind it.
    const state = path.join(path.dirname(sharedFile), "shared-memory.state.json");
    const revision = (await readMemoryText({ botDir, sharedFile, scope: "shared" })).revision;
    await rm(state, { force: true });
    await mkdir(state);
    await assert.rejects(mutateMemory({ botDir, sharedFile, scope: "shared", op: "add", expectedRevision: revision, author: "alpha", sourceMessageId: "m1", sourceQuote, sourceText, fact: "This write fails.", now }));
    await rm(state, { recursive: true, force: true });
    const next = await mutateMemory({ botDir, sharedFile, scope: "shared", op: "add", expectedRevision: (await readMemoryText({ botDir, sharedFile, scope: "shared" })).revision, author: "alpha", sourceMessageId: "m1", sourceQuote, sourceText, fact: "This write lands.", now });
    assert.equal(next.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pasted words are refused as evidence", async () => {
  const { botDir, sharedFile } = await fixture();
  const before = await readMemoryText({ botDir, sharedFile, scope: "bot" });
  const result = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: before.revision,
    author: "alpha", sourceMessageId: "m1", sourceQuote: "the launch is Thursday",
    sourceText: "> The launch is Thursday\n\nPlease remember this.",
    fact: "The launch is Thursday.", now,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /pasted|quoted|code block|forwarded/iu);
});

test("replace and supersede keep the old fact with a closed range", async () => {
  const { botDir, sharedFile } = await fixture();
  const before = await readMemoryText({ botDir, sharedFile, scope: "bot" });
  const added = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: before.revision,
    author: "alpha", sourceMessageId: "m1", sourceQuote, sourceText,
    fact: "Use OpenCode for merges.", category: "decision", validFrom: "2026-09-01", now,
  });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const superseded = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "supersede", expectedRevision: added.revision,
    author: "alpha", sourceMessageId: "m2", sourceQuote: "switch to T3 for merges",
    sourceText: "Please switch to T3 for merges from now on.",
    old: added.line!, new: "Use T3 for merges.", validFrom: "2026-10-14", now,
  });
  assert.equal(superseded.ok, true);
  const text = await readFile(path.join(botDir, "memory", "MEMORY.md"), "utf8");
  assert.match(text, /@effective\[2026-09-01,2026-10-14\) Use OpenCode for merges\./u);
  assert.match(text, /@effective:2026-10-14 Use T3 for merges\./u);
  const state = await readMemoryState(botDir);
  assert.deepEqual(state.temporal[hashFact("Use T3 for merges.")], { from: "2026-10-14", to: null });
});

test("forget writes a tombstone and blocks re-adding", async () => {
  const { botDir, sharedFile } = await fixture();
  const before = await readMemoryText({ botDir, sharedFile, scope: "bot" });
  const added = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: before.revision,
    author: "alpha", sourceMessageId: "m1", sourceQuote, sourceText,
    fact: "Likes coffee.", now,
  });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const forgotten = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "forget", expectedRevision: added.revision,
    author: "alpha", sourceMessageId: "m2", sourceQuote: "forget that I like coffee",
    sourceText: "Please forget that I like coffee.", fact: added.line!, now,
  });
  assert.equal(forgotten.ok, true);
  if (!forgotten.ok) return;
  assert.ok(forgotten.forgotten);
  const tombstone = await readMemoryState(botDir);
  assert.ok(tombstone.forgotten.includes(hashFact("Likes coffee.")));
  const again = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: forgotten.revision,
    author: "alpha", sourceMessageId: "m3", sourceQuote, sourceText,
    fact: "Likes coffee.", now,
  });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "forgotten");

  const restored = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: forgotten.revision,
    author: "alpha", sourceMessageId: "m4", sourceQuote: "remember that I like coffee",
    sourceText: "Please remember that I like coffee.", fact: "Likes coffee.", restore: true, now,
  });
  assert.equal(restored.ok, true);
});

test("notes get frontmatter, a revision, and path checks", async () => {
  const { botDir, sharedFile } = await fixture();
  const created = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "note", expectedRevision: "",
    author: "alpha", sourceMessageId: "m1", sourceQuote: "write a note about the deploy",
    sourceText: "Please write a note about the deploy.",
    path: "memory/notes/projects/alpha.md", description: "Alpha deploy", content: "# Alpha deploy\n\nRuns on the HP server.", now,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const note = await readMemoryNoteWithRevision(botDir, "memory/notes/projects/alpha.md");
  assert.match(note.text, /^---\ndescription: Alpha deploy/u);
  assert.equal(note.revision, created.revision);
  const stale = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "note", expectedRevision: "",
    author: "alpha", sourceMessageId: "m2", sourceQuote: "update the note",
    sourceText: "Please update the note.", path: note.path, description: "Alpha deploy", content: "New.", now,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "conflict");
  const escape = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "note", expectedRevision: "",
    author: "alpha", sourceMessageId: "m3", sourceQuote: "write a note",
    sourceText: "Please write a note.", path: "memory/notes/../../escape.md", description: "Escape", content: "No.", now,
  });
  assert.equal(escape.ok, false);
});

test("shared memory has its own revision and state", async () => {
  const { botDir, sharedFile } = await fixture();
  const before = await readMemoryText({ botDir, sharedFile, scope: "shared" });
  const result = await mutateMemory({
    botDir, sharedFile, scope: "shared", op: "add", expectedRevision: before.revision,
    author: "alpha", sourceMessageId: "m1", sourceQuote: "my name is Cristian",
    sourceText: "My name is Cristian and I live in Ås.", fact: "The user's name is Cristian.", now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = await readFile(sharedFile, "utf8");
  assert.match(text, /The user's name is Cristian\./u);
  const sharedState = JSON.parse(await readFile(path.join(path.dirname(sharedFile), "shared-memory.state.json"), "utf8"));
  assert.equal(sharedState.revisions["shared-memory.md"], result.revision);
});

test("journal recovery applies a complete write and refuses a conflicting one", async () => {
  const { botDir, sharedFile } = await fixture();
  const file = path.join(botDir, "memory", "MEMORY.md");
  const before = await readFile(file, "utf8");
  const state = await readMemoryState(botDir);
  const after = `${before}- [fact] Recovered fact.\n`;
  const journalDir = path.join(botDir, "memory", ".journal");
  await mkdir(journalDir, { recursive: true });
  const recoverable = {
    version: 1, opId: "recover-me", file, beforeHash: revisionOf(before), after,
    stateFile: path.join(botDir, "memory", ".state.json"), beforeState: state,
    afterState: { ...state, revisions: { "MEMORY.md": revisionOf(after) } },
    createdAt: now.toISOString(),
  };
  await writeFile(path.join(journalDir, "recover-me.json"), JSON.stringify(recoverable));
  await recoverMemoryJournals(botDir, sharedFile);
  assert.equal(await readFile(file, "utf8"), after);
  assert.equal((await readdir(journalDir)).length, 0);

  const conflict = { ...recoverable, opId: "conflict", beforeHash: "not-the-current-hash", after: "evil" };
  await writeFile(path.join(journalDir, "conflict.json"), JSON.stringify(conflict));
  await recoverMemoryJournals(botDir, sharedFile);
  assert.equal(await readFile(file, "utf8"), after);
  assert.ok((await readdir(journalDir)).some((name) => name.startsWith("failed-conflict")));
});

test("journal recovery can target a note without touching MEMORY.md", async () => {
  const { botDir, sharedFile } = await fixture();
  const noteFile = path.join(botDir, "memory", "notes", "projects", "alpha.md");
  await mkdir(path.dirname(noteFile), { recursive: true });
  const beforeNote = "---\ndescription: Alpha\ntype: note\n---\n# Alpha\n";
  await writeFile(noteFile, beforeNote);
  const memoryFile = path.join(botDir, "memory", "MEMORY.md");
  const beforeMemory = await readFile(memoryFile, "utf8");
  const state = await readMemoryState(botDir);
  const afterNote = `${beforeNote}\nRecovered detail.\n`;
  const journalDir = path.join(botDir, "memory", ".journal");
  await mkdir(journalDir, { recursive: true });
  await writeFile(path.join(journalDir, "note.json"), JSON.stringify({
    version: 1, opId: "note", file: noteFile, beforeHash: revisionOf(beforeNote), after: afterNote,
    stateFile: path.join(botDir, "memory", ".state.json"), beforeState: state,
    afterState: { ...state, revisions: { ...state.revisions, "memory/notes/projects/alpha.md": revisionOf(afterNote) } },
    createdAt: now.toISOString(),
  }));
  await recoverMemoryJournals(botDir, sharedFile);
  assert.equal(await readFile(noteFile, "utf8"), afterNote);
  assert.equal(await readFile(memoryFile, "utf8"), beforeMemory);
});

test("search finds facts and notes", async () => {
  const { botDir, sharedFile } = await fixture();
  const before = await readMemoryText({ botDir, sharedFile, scope: "bot" });
  const added = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: before.revision,
    author: "alpha", sourceMessageId: "m1", sourceQuote, sourceText,
    fact: "Prefers short answers.", now,
  });
  assert.equal(added.ok, true);
  const hits = await searchMemory({ botDir, sharedFile, query: "short answers" });
  assert.equal(hits[0]?.path, "MEMORY.md");
  assert.match(hits[0]?.text ?? "", /short answers/iu);
});

test("the Memory view returns both layers with provenance", async () => {
  const { botDir, sharedFile } = await fixture();
  const before = await readMemoryText({ botDir, sharedFile, scope: "bot" });
  const added = await mutateMemory({
    botDir, sharedFile, scope: "bot", op: "add", expectedRevision: before.revision,
    author: "alpha", sourceMessageId: "m1", sourceQuote, sourceText,
    fact: "Prefers short answers.", category: "preference", now,
  });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const view = await readMemoryView({ botDir, sharedFile });
  assert.equal(view.bot.revision, added.revision);
  assert.equal(view.bot.facts.length, 1);
  assert.equal(view.bot.facts[0]?.text, "Prefers short answers.");
  assert.equal(view.bot.facts[0]?.category, "preference");
  assert.equal(view.bot.facts[0]?.provenance?.author, "alpha");
  assert.equal(view.bot.facts[0]?.provenance?.sourceMessageId, "m1");
  assert.equal(view.shared.facts.length, 0);
  assert.equal(view.forgotten, 0);
});

test("closeFactRange preserves the source and opens an unknown start", () => {
  assert.equal(
    closeFactRange("- [decision] Use X. [source: thread/m1; added: 2026-09-01]", "2026-10-14"),
    "- [decision] @valid[,2026-10-14) Use X. [source: thread/m1; added: 2026-09-01]",
  );
});
