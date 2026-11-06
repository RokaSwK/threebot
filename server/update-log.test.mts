// logs/update.log: the automatic update writes the same steps a manual `threebot update` does.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAutoUpdateStore, createAutoUpdater } from "./auto-update.mts";
import { startUpdater, updateLogFile, updateLogger } from "./release.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = (home: string) => readFileSync(updateLogFile(home), "utf8").trimEnd().split("\n");

test("the automatic update's own steps go to update.log, each with the time", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "tb-log-"));
  const store = createAutoUpdateStore(path.join(home, "app", "auto-update.json"));
  const log = updateLogger(home, { print: null });
  const before = createAutoUpdater({ store, version: "0.1.0", isBusy: async () => [], install: async () => {}, log });
  await before.setAuto(true);
  await before.consider({ updateAvailable: true, error: null, checkedAt: new Date().toISOString(), latest: { version: "0.2.0", url: "https://example.test/v0.2.0" } });
  // The gateway restarts on the new version and settles what its predecessor began.
  await createAutoUpdater({ store: createAutoUpdateStore(path.join(home, "app", "auto-update.json")), version: "0.2.0", isBusy: async () => [], install: async () => {}, log }).settle();
  const got = lines(home);
  assert.match(got[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z auto-update: nothing is busy, updating 0\.1\.0 → 0\.2\.0$/);
  assert.match(got[1], /Z auto-update: now running 0\.2\.0 \(was 0\.1\.0\)$/);
});

/** Run the updater the way the gateway does: detached, its output going nowhere (as under systemd-run). */
async function runUpdater(installed: string, home: string, port: number) {
  const child = startUpdater("0.2.0", {
    cli: path.join(installed, "server", "cli.mjs"), platform: "darwin",
    env: { PATH: process.env.PATH, HOME: home, THREEBOT_HOME: home, THREEBOT_RELEASES_URL: `http://127.0.0.1:${port}/releases`, THREEBOT_RELEASE_BASE_URL: `http://127.0.0.1:${port}/dl` },
  });
  return new Promise((resolve) => child.on("exit", resolve));
}

test("the updater the automatic update starts writes its steps and its failure to update.log", async (t) => {
  // An installed 0.1.0: the server's code in runtime/versions/0.1.0, the layout `threebot update` needs.
  const home = mkdtempSync(path.join(tmpdir(), "tb-log-"));
  const installed = path.join(home, "runtime", "versions", "0.1.0");
  mkdirSync(path.join(installed, "server"), { recursive: true });
  for (const name of readdirSync(here)) if (/\.mjs$|\.mts$/.test(name) && !name.endsWith(".test.mts")) cpSync(path.join(here, name), path.join(installed, "server", name));
  writeFileSync(path.join(installed, "package.json"), JSON.stringify({ version: "0.1.0" }));

  // A release 0.2.0 whose download doesn't match its SHA256SUMS.
  let stopServing = false;
  const server = createServer((req, res) => {
    if (stopServing) { res.statusCode = 503; return void res.end(); }
    if (req.url === "/releases") return void res.end(JSON.stringify([{ tag_name: "v0.2.0", draft: false, prerelease: false, assets: [] }]));
    if (req.url === "/dl/v0.2.0/threebot-0.2.0.tar.gz") return void res.end("not the release");
    if (req.url === "/dl/v0.2.0/SHA256SUMS") return void res.end(`${"0".repeat(64)}  threebot-0.2.0.tar.gz\n`);
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };

  assert.equal(await runUpdater(installed, home, port), 1);
  const got = lines(home).map((line) => line.replace(/^\S+Z /, ""));
  assert.deepEqual(got.slice(0, 2), ["Updating Threebot 0.1.0 → 0.2.0", "Downloading Threebot 0.2.0"]);
  assert.match(got[2], /^Update failed: Checksum mismatch for threebot-0\.2\.0\.tar\.gz/);
  assert.equal(got.length, 3);

  // The release list can't be read (GitHub down, rate limited): that failure is written down too.
  stopServing = true;
  assert.equal(await runUpdater(installed, home, port), 1);
  assert.match(lines(home).at(-1)!, /Z Update failed: Couldn't list releases \(HTTP 503\)$/);
});
