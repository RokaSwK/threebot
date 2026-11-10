import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listMemoryNotes, mergeMemoryNotes, readMemoryNoteWithRevision, splitMemoryNote } from "./memory.mts";

async function fixture() {
  const botDir = path.join(await mkdtemp(path.join(tmpdir(), "threebot-notes-")), "alpha");
  await mkdir(path.join(botDir, "memory", "notes"), { recursive: true });
  return botDir;
}

test("splits a note at H2 headings and leaves an index", async () => {
  const botDir = await fixture();
  const notePath = "memory/notes/topic.md";
  const body = "---\ndescription: Topic notes\ntitle: Topic\ntype: note\n---\n# Topic\n\nIntro text.\n\n## First\n\nFirst detail.\n\n## Second\n\nSecond detail.\n";
  await writeFile(path.join(botDir, notePath), body);
  const revision = (await readMemoryNoteWithRevision(botDir, notePath)).revision;
  const result = await splitMemoryNote({ botDir, path: notePath, expectedRevision: revision, now: new Date("2026-11-10T10:00:00.000Z") });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.parts?.length, 2);
  const index = await readFile(path.join(botDir, notePath), "utf8");
  assert.match(index, /type: index/u);
  assert.match(index, /\[\[memory\/notes\/topic\/first\.md\]\]/u);
  assert.match(await readFile(path.join(botDir, result.parts![0]!), "utf8"), /First detail/u);
  assert.match(await readFile(path.join(botDir, result.parts![1]!), "utf8"), /Second detail/u);
  assert.equal((await listMemoryNotes(botDir)).length, 3);
});

test("split refuses conflicts and notes without two sections", async () => {
  const botDir = await fixture();
  const notePath = "memory/notes/plain.md";
  await writeFile(path.join(botDir, notePath), "# Plain\n\nOnly one section.\n");
  const revision = (await readMemoryNoteWithRevision(botDir, notePath)).revision;
  const noSections = await splitMemoryNote({ botDir, path: notePath, expectedRevision: revision });
  assert.equal(noSections.ok, false);
  if (!noSections.ok) assert.equal(noSections.code, "invalid");
  const conflict = await splitMemoryNote({ botDir, path: notePath, expectedRevision: "wrong" });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "conflict");
});

test("merges notes into one canonical note and archives the raw sources", async () => {
  const botDir = await fixture();
  await writeFile(path.join(botDir, "memory", "notes", "a.md"), "---\n description: A\ntitle: A\ntype: note\n---\n# A\n\nAlpha content.\n");
  await writeFile(path.join(botDir, "memory", "notes", "b.md"), "---\ndescription: B\ntitle: B\ntype: note\n---\n# B\n\nBeta content.\n");
  const a = await readMemoryNoteWithRevision(botDir, "memory/notes/a.md");
  const b = await readMemoryNoteWithRevision(botDir, "memory/notes/b.md");
  const result = await mergeMemoryNotes({
    botDir,
    targetPath: "memory/notes/merged.md",
    expectedRevision: "",
    sources: [{ path: "memory/notes/a.md", expectedRevision: a.revision }, { path: "memory/notes/b.md", expectedRevision: b.revision }],
    description: "Merged topic",
    now: new Date("2026-11-10T10:00:00.000Z"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(await readFile(path.join(botDir, "memory", "notes", "merged.md"), "utf8"), /Alpha content[\s\S]*Beta content/u);
  assert.match(await readFile(path.join(botDir, "memory", "notes", "a.md"), "utf8"), /Merged into \[\[memory\/notes\/merged\.md\]\]/u);
  assert.ok(result.archivePath);
  assert.match(await readFile(path.join(botDir, result.archivePath!), "utf8"), /Alpha content[\s\S]*Beta content/u);
});
