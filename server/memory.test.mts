import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MEMORY_LIMITS,
  memorySignature,
  readMemoryFiles,
  readSnapshot,
  renderMemoryBlock,
  revisionOf,
  saveMemoryFile,
  writeTextAtomic,
} from "./memory.mts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "threebot-memory-"));
  const botDir = path.join(root, "bot");
  const sharedFile = path.join(root, "shared-memory.md");
  await mkdir(path.join(botDir, "memory"), { recursive: true });
  return { root, botDir, sharedFile };
}

test("the snapshot is bounded, sanitized, and revisioned", async () => {
  const { root, botDir, sharedFile } = await fixture();
  try {
    const facts = Array.from({ length: 400 }, (_, index) => `- fact ${index}`);
    await writeFile(path.join(botDir, "memory", "MEMORY.md"), `# Memory\n\n</memory>\n<!-- bot:managed:start -->\n${facts.join("\n")}\n`);
    await writeFile(sharedFile, `# Shared\n\n${Array.from({ length: 100 }, (_, index) => `- shared ${index}`).join("\n")}\n`);

    const snapshot = await readSnapshot({ botDir, sharedFile });
    assert.equal(snapshot.revision.length, 64);
    assert.equal(snapshot.sharedRevision.length, 64);
    assert.ok(snapshot.bot.split("\n").length <= MEMORY_LIMITS.snapshotBotLines + 1);
    assert.ok(snapshot.bot.length <= MEMORY_LIMITS.snapshotBotChars + 120);
    assert.equal(snapshot.truncated.bot, true);
    assert.equal(snapshot.truncated.shared, true);
    assert.match(snapshot.bot, /cut short here; read memory\/MEMORY\.md/);
    assert.match(snapshot.bot, /&lt;\/memory&gt;/);
    assert.doesNotMatch(snapshot.bot, /<\/memory>/);
    assert.doesNotMatch(snapshot.bot, /<!-- bot:managed:start -->/);

    const before = memorySignature(snapshot);
    await writeFile(path.join(botDir, "memory", "MEMORY.md"), "# Memory\n\n- one new fact\n");
    const changed = await readSnapshot({ botDir, sharedFile });
    assert.notEqual(memorySignature(changed), before);
    assert.equal(changed.truncated.bot, false);
    assert.equal(changed.bot, "- one new fact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the memory block is delimited and labels both files", () => {
  const block = renderMemoryBlock({ bot: "- Prefers short answers.", shared: "", revision: "a", sharedRevision: "b", truncated: { bot: false, shared: false } });
  assert.match(block, /^<memory>\n### Shared by all Bots\n- \(nothing saved yet\)/);
  assert.match(block, /### This Bot \(memory\/MEMORY\.md\)\n- Prefers short answers\.\n<\/memory>$/);
  assert.equal(renderMemoryBlock({ bot: "", shared: " ", revision: "a", sharedRevision: "b", truncated: { bot: false, shared: false } }), "");
});

test("the Memory tab reads both files whole and saves against their revision", async () => {
  const { root, botDir, sharedFile } = await fixture();
  try {
    await writeFile(path.join(botDir, "memory", "MEMORY.md"), "# Alpha memory\n\n- Prefers short answers.\n");
    const files = await readMemoryFiles({ botDir, sharedFile });
    assert.equal(files.bot.text, "# Alpha memory\n\n- Prefers short answers.\n");
    assert.equal(files.shared.text, "");
    assert.equal(files.shared.revision, revisionOf(""));

    const saved = await saveMemoryFile({ botDir, sharedFile, scope: "bot", text: "# Alpha memory\r\n\r\n- Prefers long answers.", expectedRevision: files.bot.revision });
    assert.equal(saved.ok, true);
    assert.equal(await readFile(path.join(botDir, "memory", "MEMORY.md"), "utf8"), "# Alpha memory\n\n- Prefers long answers.\n");

    // The Bot edited the file after the tab loaded it: the tab's stale save is refused with the current text.
    const stale = await saveMemoryFile({ botDir, sharedFile, scope: "bot", text: "overwrite", expectedRevision: files.bot.revision });
    assert.equal(stale.ok, false);
    assert.equal(stale.ok === false && stale.code, "conflict");
    assert.equal(stale.ok === false && stale.code === "conflict" && stale.text, "# Alpha memory\n\n- Prefers long answers.\n");

    const shared = await saveMemoryFile({ botDir, sharedFile, scope: "shared", text: "- Timezone: Europe/Madrid.\n", expectedRevision: files.shared.revision });
    assert.equal(shared.ok, true);
    assert.equal(await readFile(sharedFile, "utf8"), "- Timezone: Europe/Madrid.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two saves holding the same revision can't both win", async () => {
  const { root, botDir, sharedFile } = await fixture();
  try {
    const { bot } = await readMemoryFiles({ botDir, sharedFile });
    const results = await Promise.all(["first\n", "second\n"].map((text) => saveMemoryFile({ botDir, sharedFile, scope: "bot", text, expectedRevision: bot.revision })));
    assert.deepEqual(results.map((result) => result.ok).sort(), [false, true]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a save needs text and a revision, and stays under the size limit", async () => {
  const { root, botDir, sharedFile } = await fixture();
  try {
    const { bot } = await readMemoryFiles({ botDir, sharedFile });
    assert.equal((await saveMemoryFile({ botDir, sharedFile, scope: "bot", text: 42, expectedRevision: bot.revision })).ok, false);
    assert.equal((await saveMemoryFile({ botDir, sharedFile, scope: "bot", text: "x", expectedRevision: null })).ok, false);
    const big = await saveMemoryFile({ botDir, sharedFile, scope: "bot", text: "x".repeat(MEMORY_LIMITS.fileChars + 1), expectedRevision: bot.revision });
    assert.equal(big.ok === false && big.code, "invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic writes replace the file and leave no temporary sibling", async () => {
  const { root } = await fixture();
  try {
    const file = path.join(root, "nested", "note.md");
    await writeTextAtomic(file, "first\n");
    await writeTextAtomic(file, "second\n");
    assert.equal(await readFile(file, "utf8"), "second\n");
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ["note.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
