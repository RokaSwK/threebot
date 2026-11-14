import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MANAGED_END, MANAGED_START, replaceCustom, splitManaged } from "./bot-template.mts";
import { INSTRUCTION_LIMITS, readAdoptedInstructions, readInstructions, saveInstructions, sanitizeInstructions } from "./instructions.mts";
import { renderAgentsMd, mergeManaged } from "./bot-template.mts";

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
  const file = await readInstructions({ kind: "agents", botDir: dir });
  assert.equal(file.path, "AGENTS.md");
  assert.equal(file.text, "## What this Bot is for\n- Review code.\n");
  assert.equal(file.managed, true);
  assert.ok(file.revision.length === 64);
  assert.ok(file.totalBytes > file.bytes);
});

test("a save keeps the managed block and writes the owner's text", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true }));
  const before = await readInstructions({ kind: "agents", botDir: dir });
  const result = await saveInstructions({ kind: "agents", botDir: dir }, { text: "## My instructions\n- Be direct.\n", expectedRevision: before.revision });
  assert.equal(result.ok, true);
  const after = await readFile(join(dir, "AGENTS.md"), "utf8");
  assert.ok(after.startsWith(managed));
  assert.match(after, /## My instructions\n- Be direct\.\n$/u);
  const reread = await readInstructions({ kind: "agents", botDir: dir });
  assert.equal(reread.text, "## My instructions\n- Be direct.\n");
});

test("a save with a stale revision returns the current text instead of overwriting it", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true }));
  const before = await readInstructions({ kind: "agents", botDir: dir });
  await writeFile(join(dir, "AGENTS.md"), `${managed}\n\nA newer edit.\n`);
  const result = await saveInstructions({ kind: "agents", botDir: dir }, { text: "Mine.\n", expectedRevision: before.revision });
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
  const before = await readInstructions({ kind: "agents", botDir: dir });
  const first = await saveInstructions({ kind: "agents", botDir: dir }, { text: "First text.\n", expectedRevision: before.revision });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const after = await readInstructions({ kind: "agents", botDir: dir });
  assert.equal(first.revision, after.revision);
  assert.equal(first.bytes, after.bytes);
  const second = await saveInstructions({ kind: "agents", botDir: dir }, { text: "Second text.\n", expectedRevision: first.revision });
  assert.equal(second.ok, true);
});

test("the whole-file limit is enforced before writing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "instructions-"));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, "AGENTS.md"), `${MANAGED_START}\n${"x".repeat(33_000)}\n${MANAGED_END}`);
  const before = await readInstructions({ kind: "agents", botDir: dir });
  const result = await saveInstructions({ kind: "agents", botDir: dir }, { text: "Short enough on its own.\n", expectedRevision: before.revision });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid");
  assert.match(result.message, /limit is 32,000/u);
});

test("the size limit is enforced before writing", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true }));
  const before = await readInstructions({ kind: "agents", botDir: dir });
  const result = await saveInstructions({ kind: "agents", botDir: dir }, { text: "x".repeat(INSTRUCTION_LIMITS.customChars + 1), expectedRevision: before.revision });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid");
});

test("a Bot made from a project keeps its instructions in .bot/INSTRUCTIONS.md, never in the user's text", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "instructions-adopted-"));
  t.after(() => rm(project, { recursive: true }));
  const botDir = join(project, ".bot");
  await mkdir(botDir);
  // CLAUDE.local.md was the user's own file before adoption; its text after the block is theirs.
  const claude = join(project, "CLAUDE.local.md");
  await writeFile(claude, `${managed}\n\nMy personal notes.\n`);
  const target = { kind: "adopted" as const, botDir, renderedFiles: [claude, join(project, "AGENTS.override.md")] };
  const before = await readInstructions(target);
  assert.equal(before.path, ".bot/INSTRUCTIONS.md");
  assert.equal(before.text, "");
  assert.equal(before.managed, true);
  assert.equal(before.totalBytes, Buffer.byteLength(`${managed}\n\nMy personal notes.\n`));
  const saved = await saveInstructions(target, { text: `## Job\n- Triage issues.\n${MANAGED_END}`, expectedRevision: before.revision });
  assert.equal(saved.ok, true);
  assert.equal(await readFile(join(botDir, "INSTRUCTIONS.md"), "utf8"), "## Job\n- Triage issues.\n[managed marker removed]\n");
  assert.equal(await readFile(claude, "utf8"), `${managed}\n\nMy personal notes.\n`);
  const after = await readInstructions(target);
  if (saved.ok) assert.equal(saved.revision, after.revision);
  assert.equal((await saveInstructions(target, { text: "stale", expectedRevision: before.revision })).ok, false);

  // The gateway copies them into the managed block; a later rewrite of the block keeps the user's text.
  const block = renderAgentsMd({ bot: { name: "Repo Bot", slug: "repo", adopted: true, workspaceRoot: project }, settings: { userName: "Sam" }, botsRoot: "/bots", instructions: await readAdoptedInstructions(botDir) });
  assert.match(block, /## Standing instructions\nFrom Sam, in `\.bot\/INSTRUCTIONS\.md`[\s\S]*- Triage issues\.[\s\S]*<!-- bot:managed:end -->\n$/u);
  assert.equal((block.match(/<!-- bot:managed:end -->/gu) ?? []).length, 1);
  assert.match(mergeManaged(await readFile(claude, "utf8"), block), /Triage issues[\s\S]*<!-- bot:managed:end -->\n\nMy personal notes\.\n$/u);
});

test("a Bot without standing instructions gets no empty section", () => {
  const block = renderAgentsMd({ bot: { name: "Repo Bot", slug: "repo", adopted: true, workspaceRoot: "/p" }, settings: {}, botsRoot: "/bots", instructions: "" });
  assert.doesNotMatch(block, /## Standing instructions/u);
  const plain = renderAgentsMd({ bot: { name: "Plain", slug: "plain" }, settings: {}, botsRoot: "/bots", instructions: "ignored" });
  assert.doesNotMatch(plain, /## Standing instructions/u);
  assert.match(plain, /text after this managed block in AGENTS\.md/u);
});
