import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { antigravityBridgeStatus, antigravityConfigPath, installAntigravityBridge, uninstallAntigravityBridge } from "./harness-bridge.mts";

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "threebot-harness-bridge-"));
  const configPath = path.join(home, ".gemini", "config", "mcp_config.json");
  const bridgePath = path.join(home, "repo", "server", "threebot-mcp-bridge.mts");
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(path.dirname(bridgePath), { recursive: true });
  await writeFile(bridgePath, "// bridge\n");
  await writeFile(configPath, JSON.stringify({ mcpServers: { other: { command: "other" } }, keep: true }, null, 2));
  return { home, configPath, bridgePath };
}

test("the Antigravity bridge installer merges, backs up and is idempotent", async () => {
  const { home, configPath, bridgePath } = await fixture();
  assert.equal(antigravityConfigPath({ home }), configPath);
  const before = await antigravityBridgeStatus({ home, bridgePath });
  assert.equal(before.installed, false);
  assert.deepEqual(before.otherServers, ["other"]);

  const installed = await installAntigravityBridge({ home, bridgePath, now: new Date("2026-11-09T12:00:00Z") });
  assert.equal(installed.changed, true);
  assert.equal(installed.status.installed, true);
  assert.ok(installed.backup);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.mcpServers.threebot, { command: "node", args: [bridgePath] });
  assert.deepEqual(config.mcpServers.other, { command: "other" });
  assert.equal(config.keep, true);

  const again = await installAntigravityBridge({ home, bridgePath });
  assert.equal(again.changed, false);
  assert.equal(again.backup, null);
});

test("uninstall removes only the Threebot entry", async () => {
  const { home, configPath, bridgePath } = await fixture();
  await installAntigravityBridge({ home, bridgePath });
  const removed = await uninstallAntigravityBridge({ home, bridgePath });
  assert.equal(removed.changed, true);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.mcpServers.threebot, undefined);
  assert.deepEqual(config.mcpServers.other, { command: "other" });
  const status = await antigravityBridgeStatus({ home, bridgePath });
  assert.equal(status.installed, false);
});

test("a malformed Antigravity config is refused instead of overwritten", async () => {
  const { home, configPath, bridgePath } = await fixture();
  await writeFile(configPath, "{ not json");
  await assert.rejects(() => installAntigravityBridge({ home, bridgePath }), /not valid JSON/u);
  assert.equal(await readFile(configPath, "utf8"), "{ not json");
});
