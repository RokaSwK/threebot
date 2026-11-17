import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { launchdPlist, serviceSpec, stableNode, stopWindowsGateway, systemdUnit } from "./service.mts";

const spec = serviceSpec({ node: "/usr/bin/node", cli: "/home/me/.threebot/runtime/current/server/cli.mjs", home: "/home/me/.threebot", pathEnv: "/opt/bin:/usr/bin" });

test("the launchd agent runs `serve` from the current link and keeps the user's PATH", () => {
  const plist = launchdPlist(spec);
  assert.match(plist, /<string>tools\.threebot\.gateway<\/string>/);
  assert.match(plist, /<string>\/usr\/bin\/node<\/string>\s*<string>\/home\/me\/\.threebot\/runtime\/current\/server\/cli\.mjs<\/string>\s*<string>serve<\/string>/);
  assert.match(plist, new RegExp(`<key>PATH</key><string>/usr/bin${path.delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/opt/bin`));
  assert.match(plist, /<key>THREEBOT_SERVICE<\/key><string>1<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test("values are escaped in the plist and quoted in the systemd unit", () => {
  const odd = serviceSpec({ node: "/usr/bin/node", cli: "/Users/A & B/cli.mjs", home: "/Users/A & B/.threebot", pathEnv: "" });
  assert.match(launchdPlist(odd), /A &amp; B/);
  const unit = systemdUnit(odd);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node "\/Users\/A & B\/cli\.mjs" serve$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("the service uses the PATH entry for node, not the versioned folder it points into", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tb-node-"));
  const cellar = path.join(dir, "Cellar", "node", "26.0.0", "bin");
  mkdirSync(cellar, { recursive: true });
  writeFileSync(path.join(cellar, "node"), "#!/bin/sh\n");
  chmodSync(path.join(cellar, "node"), 0o755);
  mkdirSync(path.join(dir, "bin"));
  symlinkSync(path.join(cellar, "node"), path.join(dir, "bin", "node"));
  assert.equal(stableNode(path.join(cellar, "node"), `/nowhere${path.delimiter}${path.join(dir, "bin")}`), path.join(dir, "bin", "node"));
  assert.equal(stableNode(path.join(cellar, "node"), "/nowhere"), path.join(cellar, "node"));
});


test("Windows restart stops only the gateway, preserving its updater child", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "tb-stop-"));
  const service = serviceSpec({ node: process.execPath, cli: path.join(home, "cli.mjs"), home });
  writeFileSync(path.join(home, "gateway.pid"), "12345");
  const calls: { command: string; args: string[] }[] = [];
  await stopWindowsGateway(service, async (command, args) => { calls.push({ command, args }); return ""; });
  assert.deepEqual(calls, [{ command: "taskkill", args: ["/PID", "12345", "/F"] }]);
});
