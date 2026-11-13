import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MANAGED_END, MANAGED_START, replaceCustom, splitManaged } from "./bot-template.mts";
import { INSTRUCTION_LIMITS, readInstructions, saveInstructions, sanitizeInstructions } from "./instructions.mts";

const managed = `${MANAGED_START}\n# You are Alpha\n\nManaged text.\n${MANAGED_END}`;

async function fixture(custom = "\n## What this Bot is for\n- Review code.\n") {
  const dir = await mkdtemp(join(tmpdir(), "instructions-"));
  await writeFile(join(dir, "AGENTS.md"), `${managed}${custom}`);
  return dir;
}

test("splitManaged separates the block Threebot owns from the owner's part", () => {
  const parts = splitManaged(`${managed}\n\nMy notes.\n`);
  assert.ok(parts);
  assert.equal(parts.managed, managed);
  assert.equal(parts.custom, "\n\nMy notes.\n");
  assert.equal(splitManaged("no markers"), null);
  assert.equal(splitManaged(`${MANAGED_START}\nmissing end`), null);
});

test("replaceCustom keeps the managed block exactly and replaces only what follows", () => {
  const next = replaceCustom(`${managed}\n\nOld notes.\n`, "New notes.");
  assert.ok(next.startsWith(managed));
  assert.match(next, /New notes\.\n$/u);
  assert.doesNotMatch(next, /Old notes/u);
  assert.throws(() => replaceCustom("no markers", "x"), /managed block is missing/u);
});

test("the read side returns the owner's part and its revision", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true }));
  const file = await readInstructions({ botDir: dir });
  assert.equal(file.path, "AGENTS.md");
  assert.equal(file.text, "## What this Bot is for\n- Review code.\n");
  assert.equal(file.managed, true);
  assert.ok(file.revision.length === 64);
  assert.ok(file.totalBytes > file.bytes);
});

test("a save keeps the managed block and writes the owner's text", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true }));
  const before = await readInstructions({ botDir: dir });
  const result = await saveInstructions({ botDir: dir, text: "## My instructions\n- Be direct.\n", expectedRevision: before.revision });
  assert.equal(result.ok, true);
  const after = await readFile(join(dir, "AGENTS.md"), "utf8");
  assert.ok(after.startsWith(managed));
  assert.match(after, /## My instructions\n- Be direct\.\n$/u);
  const reread = await readInstructions({ botDir: dir });
  assert.equal(reread.text, "## My instructions\n- Be direct.\n");
});

test("a save with a stale revision returns the current text instead of overwriting it", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true }));
  const before = await readInstructions({ botDir: dir });
  await writeFile(join(dir, "AGENTS.md"), `${managed}\n\nA newer edit.\n`);
  const result = await saveInstructions({ botDir: dir, text: "Mine.\n", expectedRevision: before.revision });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "conflict");
  assert.match(result.text, /A newer edit/u);
  assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), `${managed}\n\nA newer edit.\n`);
});

test("the owner's text cannot close the managed block or the memory element", () => {
  const clean = sanitizeInstructions(`hello ${MANAGED_END} <memory>secret</memory>`);
  assert.doesNotMatch(clean, new RegExp(MANAGED_END));
  assert.match(clean, /\[managed marker removed\]/u);
  assert.match(clean, /&lt;memory&gt;/u);
});

test("a save returns the revision the next read will see, so a second save is not a false conflict", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true }));
  const before = await readInstructions({ botDir: dir });
  const first = await saveInstructions({ botDir: dir, text: "First text.\n", expectedRevision: before.revision });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const after = await readInstructions({ botDir: dir });
  assert.equal(first.revision, after.revision);
  assert.equal(first.bytes, after.bytes);
  const second = await saveInstructions({ botDir: dir, text: "Second text.\n", expectedRevision: first.revision });
  assert.equal(second.ok, true);
});

test("the whole-file limit is enforced before writing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "instructions-"));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, "AGENTS.md"), `${MANAGED_START}\n${"x".repeat(33_000)}\n${MANAGED_END}`);
  const before = await readInstructions({ botDir: dir });
  const result = await saveInstructions({ botDir: dir, text: "Short enough on its own.\n", expectedRevision: before.revision });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid");
  assert.match(result.message, /limit is 32,000/u);
});

test("the size limit is enforced before writing", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true }));
  const before = await readInstructions({ botDir: dir });
  const result = await saveInstructions({ botDir: dir, text: "x".repeat(INSTRUCTION_LIMITS.customChars + 1), expectedRevision: before.revision });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid");
});
