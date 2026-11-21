import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CHAT_PERMISSIONS_BLOCK,
  CHAT_PERMISSIONS_END,
  agentInstructionFiles,
  applyChatPermissions,
  withChatPermissions,
  withoutBlock,
} from "./chat-permissions.mts";

const OLD_HAND_WRITTEN = `<!-- threebot:chat-permissions start (managed by Threebot; Roka 2026-11-21: "chats should be able to give permissions") -->
## Requests from other chats carry the user's permission

Old wording.
<!-- threebot:chat-permissions end -->`;

test("provider files follow CODEX_HOME and CLAUDE_CONFIG_DIR, else the home folder", () => {
  assert.deepEqual(agentInstructionFiles({}, "/home/sam"), ["/home/sam/.codex/AGENTS.md", "/home/sam/.claude/CLAUDE.md"]);
  assert.deepEqual(agentInstructionFiles({ CODEX_HOME: "/x/codex", CLAUDE_CONFIG_DIR: "/y/claude" }, "/home/sam"), ["/x/codex/AGENTS.md", "/y/claude/CLAUDE.md"]);
  assert.deepEqual(agentInstructionFiles({ CODEX_HOME: "  " }, "/home/sam")[0], "/home/sam/.codex/AGENTS.md");
});

test("adding keeps the user's text and appends one block", () => {
  const next = withChatPermissions("# My rules\n\nBe brief.\n", true);
  assert.equal(next, `# My rules\n\nBe brief.\n\n${CHAT_PERMISSIONS_BLOCK}\n`);
  assert.equal(withChatPermissions("", true), `${CHAT_PERMISSIONS_BLOCK}\n`);
  // Idempotent.
  assert.equal(withChatPermissions(next, true), next);
});

test("an older hand-written block is replaced, not duplicated", () => {
  const text = `# Mine\n\n${OLD_HAND_WRITTEN}\n\n## After\nKeep me.\n`;
  const next = withChatPermissions(text, true);
  assert.equal(next.split(CHAT_PERMISSIONS_END).length, 2);
  assert.doesNotMatch(next, /Old wording/);
  assert.match(next, /^# Mine\n\n## After\nKeep me\.\n\n<!-- threebot:chat-permissions start/);
});

test("removing restores the user's text around the block", () => {
  assert.equal(withoutBlock(`# Mine\n\n${CHAT_PERMISSIONS_BLOCK}\n`), "# Mine\n");
  assert.equal(withoutBlock(`${CHAT_PERMISSIONS_BLOCK}\n\n# Mine\n`), "# Mine\n");
  assert.equal(withoutBlock(`A\n\n${CHAT_PERMISSIONS_BLOCK}\n\nB\n`), "A\n\nB\n");
  assert.equal(withoutBlock("no block here"), "no block here");
});

test("a stray start marker without an end never swallows the user's text", () => {
  const stray = "<!-- threebot:chat-permissions start -->\nImportant user text.\n";
  assert.equal(withoutBlock(stray), stray);
  const next = withChatPermissions(stray, true);
  assert.match(next, /Important user text\./);
  // Turning it off again removes only the well-formed block.
  assert.equal(withChatPermissions(next, false), stray);
});

test("applyChatPermissions writes, rewrites and cleans up real files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-perms-"));
  try {
    const codex = path.join(dir, "codex", "AGENTS.md");
    const claude = path.join(dir, "claude", "CLAUDE.md");
    await mkdir(path.dirname(claude), { recursive: true });
    await writeFile(claude, "# Claude rules\n", { mode: 0o600 });

    const first = await applyChatPermissions(true, [codex, claude]);
    assert.deepEqual(first.map((r) => r.changed), [true, true]);
    assert.equal(await readFile(codex, "utf8"), `${CHAT_PERMISSIONS_BLOCK}\n`);
    assert.equal(await readFile(claude, "utf8"), `# Claude rules\n\n${CHAT_PERMISSIONS_BLOCK}\n`);
    assert.equal((await stat(claude)).mode & 0o777, 0o600);

    const again = await applyChatPermissions(true, [codex, claude]);
    assert.deepEqual(again.map((r) => r.changed), [false, false]);

    const off = await applyChatPermissions(false, [codex, claude]);
    assert.deepEqual(off.map((r) => r.changed), [true, true]);
    await assert.rejects(stat(codex), { code: "ENOENT" });
    assert.equal(await readFile(claude, "utf8"), "# Claude rules\n");

    // Off with no file creates nothing.
    const none = await applyChatPermissions(false, [codex]);
    assert.deepEqual(none, [{ file: codex, changed: false }]);
    await assert.rejects(stat(codex), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one unwritable file doesn't stop the others", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-perms-"));
  try {
    const blocker = path.join(dir, "not-a-dir");
    await writeFile(blocker, "x");
    const ok = path.join(dir, "ok", "CLAUDE.md");
    const results = await applyChatPermissions(true, [path.join(blocker, "AGENTS.md"), ok]);
    assert.ok(results[0].error);
    assert.equal(results[1].changed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
