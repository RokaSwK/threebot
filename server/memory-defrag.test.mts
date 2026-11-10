import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeMemoryStore, runDefragAudit, runSafeDedupe } from "./memory-defrag.mts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "threebot-defrag-"));
  const botDir = path.join(root, "bots", "alpha");
  const sharedFile = path.join(root, "bots", ".botapp", "shared-memory.md");
  await mkdir(path.join(botDir, "memory", "notes"), { recursive: true });
  await mkdir(path.dirname(sharedFile), { recursive: true });
  await writeFile(path.join(botDir, "memory", "MEMORY.md"), [
    "# Alpha memory",
    "",
    "- [fact] Likes coffee.",
    "- [fact] Likes coffee.",
    "- [fact] Prefers short answers.",
    "- [fact] Prefers very short answers.",
    "- [fact] @valid[2020-01-01,2020-02-01) Old deadline.",
    "",
  ].join("\n"));
  await writeFile(sharedFile, "# Shared facts\n\n- [fact] Timezone is Europe/Oslo.\n");
  await writeFile(path.join(botDir, "memory", "notes", "a.md"), "---\ndescription: A\ntype: note\n---\n# A\n\nSee [[missing]].\n");
  await writeFile(path.join(botDir, "memory", "notes", "b.md"), "---\ndescription: B\ntype: note\n---\n# B\n\n" + "x".repeat(8_100) + "\n");
  return { botDir, sharedFile };
}

const now = new Date("2026-11-10T10:00:00.000Z");

test("defrag finds duplicates, stale facts, broken links and oversized notes", async () => {
  const { botDir, sharedFile } = await fixture();
  const report = await analyzeMemoryStore({ botDir, sharedFile, now });
  assert.equal(report.counts.facts, 5);
  assert.equal(report.counts.exactDuplicateFacts, 1);
  assert.ok(report.counts.nearDuplicateFacts >= 1);
  assert.ok(report.counts.staleFacts >= 1);
  assert.ok(report.counts.brokenLinks >= 1);
  assert.ok(report.counts.oversizedNotes >= 1);
  assert.ok(report.findings.some((finding) => finding.kind === "duplicate"));
});

test("the audit writes a proposed plan and safe dedupe only removes exact duplicates", async () => {
  const { botDir, sharedFile } = await fixture();
  const report = await runDefragAudit({ botDir, sharedFile, now });
  assert.equal(report.planPath, "memory/notes/defrag/2026-11-10.md");
  const plan = await readFile(path.join(botDir, report.planPath!), "utf8");
  assert.match(plan, /type: defrag-plan/u);
  assert.match(plan, /status: proposed/u);
  assert.match(plan, /\[duplicate\]/u);

  const deduped = await runSafeDedupe({ botDir, sharedFile, now });
  assert.equal(deduped.removed, 1);
  const memory = await readFile(path.join(botDir, "memory", "MEMORY.md"), "utf8");
  assert.equal((memory.match(/Likes coffee\./gu) ?? []).length, 1);
  assert.match(memory, /Prefers very short answers/u);
  assert.match(memory, /Old deadline/u);
});
