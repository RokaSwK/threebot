import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  activate,
  compareVersions,
  createUpdateChecker,
  defaultWindowsAppDir,
  expectedSum,
  findRelease,
  installRelease,
  installedRuntime,
  prune,
  readLink,
  rollback,
  runtimePaths,
  startUpdateChecks,
  type FetchBytes,
  type FetchJson,
} from "./release.mts";

// A Buffer stands in for the ArrayBuffer a real response gives: download() copies either with Buffer.from.
const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value, arrayBuffer: async () => Buffer.from(JSON.stringify(value)) as unknown as ArrayBuffer });
const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, body: `notes ${tag}`, html_url: `https://example.test/${tag}`, assets: [
  { name: `threebot-${tag.slice(1)}.tar.gz`, browser_download_url: `https://dl.test/${tag}/threebot-${tag.slice(1)}.tar.gz` },
  { name: "SHA256SUMS", browser_download_url: `https://dl.test/${tag}/SHA256SUMS` },
], ...extra });

test("versions compare by number, and a preview comes before its release", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("v1.2.3", "1.2.3") === 0);
  assert.ok(compareVersions("1.0.0-preview.2", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-preview.10", "1.0.0-preview.9") > 0);
  assert.throws(() => compareVersions("latest", "1.0.0"));
});

test("the newest stable release is picked, previews only on the preview channel", async () => {
  const list = [release("v0.2.0-preview.1", { prerelease: true }), release("v0.1.10"), release("v0.1.9"), release("v0.3.0", { draft: true })];
  const fetchImpl = async () => json(list);
  assert.equal((await findRelease({ fetchImpl, env: {} }))!.version, "0.1.10");
  assert.equal((await findRelease({ fetchImpl, env: {}, channel: "preview" }))!.version, "0.2.0-preview.1");
  const exact = await findRelease({ fetchImpl, env: {}, version: "v0.1.9" });
  assert.equal(exact!.archive, "https://dl.test/v0.1.9/threebot-0.1.9.tar.gz");
  assert.equal(await findRelease({ fetchImpl, env: {}, version: "9.9.9" }), null);
  const mirrored = await findRelease({ fetchImpl, env: { THREEBOT_RELEASE_BASE_URL: "http://mirror.test/" } });
  assert.equal(mirrored!.sums, "http://mirror.test/v0.1.10/SHA256SUMS");
});

test("SHA256SUMS lines are read in both text and binary form", () => {
  const sums = "aa".repeat(32) + "  threebot-1.0.0.tar.gz\n" + "bb".repeat(32) + " *other.tar.gz\n";
  assert.equal(expectedSum(sums, "threebot-1.0.0.tar.gz"), "aa".repeat(32));
  assert.equal(expectedSum(sums, "other.tar.gz"), "bb".repeat(32));
  assert.equal(expectedSum(sums, "missing.tar.gz"), null);
});

function fakeArchive(version: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "tb-pack-"));
  const root = path.join(dir, `threebot-${version}`);
  mkdirSync(path.join(root, "server"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "threebot", version }));
  writeFileSync(path.join(root, "server", "package.json"), JSON.stringify({ name: "bot-gateway", version }));
  const file = path.join(dir, "a.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", file, "-C", dir, `threebot-${version}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).status, 0);
  return readFileSync(file);
}
const serveFiles = (files: Record<string, Buffer>): FetchBytes => async (url) => {
  const body = files[url];
  return body ? { ok: true, status: 200, arrayBuffer: async () => body as unknown as ArrayBuffer } : { ok: false, status: 404 };
};

test("a release installs only when its checksum matches, then activates, rolls back and prunes", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "tb-home-"));
  const make = (version: string, tamper = false) => {
    const archive = fakeArchive(version);
    const sum = createHash("sha256").update(archive).digest("hex");
    return { release: { version, archive: `https://dl.test/${version}.tgz`, sums: `https://dl.test/${version}.sums` }, files: { [`https://dl.test/${version}.tgz`]: tamper ? Buffer.concat([archive, Buffer.from("x")]) : archive, [`https://dl.test/${version}.sums`]: Buffer.from(`${sum}  threebot-${version}.tar.gz\n`) } };
  };
  // A no-op stand-in for npm: installRelease runs `npm ci`, which we don't need here.
  const npm = path.join(tmpdir(), `noop-npm-${process.pid}${process.platform === "win32" ? ".cmd" : ""}`);
  writeFileSync(npm, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(npm, 0o755);

  const bad = make("1.0.1", true);
  await assert.rejects(installRelease(bad.release, { home, fetchImpl: serveFiles(bad.files), npm }), /Checksum mismatch/);
  assert.equal(existsSync(path.join(runtimePaths(home).versions, "1.0.1")), false, "nothing is left behind");

  const paths = runtimePaths(home);
  const dirs: Record<string, string> = {};
  for (const version of ["1.0.0", "1.0.2", "1.0.3"]) {
    const ok = make(version);
    dirs[version] = await installRelease(ok.release, { home, fetchImpl: serveFiles(ok.files), npm });
    assert.ok(existsSync(path.join(dirs[version], ".install-complete")));
  }
  await activate(dirs["1.0.0"], home);
  await activate(dirs["1.0.2"], home);
  await activate(dirs["1.0.3"], home);
  assert.equal(await readLink(paths.current), dirs["1.0.3"]);
  assert.equal(await readLink(paths.previous), dirs["1.0.2"]);
  assert.deepEqual(await prune(home), ["1.0.0"]);
  assert.equal(await rollback(home), dirs["1.0.2"]);
  assert.equal(await readLink(paths.current), dirs["1.0.2"]);
  await assert.rejects(rollback(home), /no earlier version/);
});

test("an installed copy is recognised through linked folders such as /tmp on macOS", () => {
  const real = realpathSync(mkdtempSync(path.join(tmpdir(), "tb-real-")));
  mkdirSync(path.join(real, "runtime", "versions", "1.0.0"), { recursive: true });
  const linked = path.join(mkdtempSync(path.join(tmpdir(), "tb-link-")), "home");
  symlinkSync(real, linked);
  assert.equal(installedRuntime(path.join(real, "runtime", "versions", "1.0.0"), linked), true);
  assert.equal(installedRuntime(path.join(real, "elsewhere"), linked), false);
});

test("the update check caches its answer and reports a failure instead of throwing", async () => {
  let calls = 0;
  const check = createUpdateChecker({ env: {}, version: "0.1.0", fetchImpl: async () => { calls++; return json([release("v0.2.0")]); } });
  assert.equal((await check()).updateAvailable, true);
  await check();
  assert.equal(calls, 1);
  await check({ force: true });
  assert.equal(calls, 2);
  const broken = createUpdateChecker({ env: {}, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.match((await broken()).error!, /503/);
});

test("the stored answer serves every tab until a check is due, and failures back off keeping the last answer", async () => {
  let t = 0, calls = 0, fail = false;
  const minute = 60 * 1000;
  const check = createUpdateChecker({ env: {}, version: "0.1.0", now: () => t, fetchImpl: async () => { calls++; return fail ? { ok: false, status: 403 } : json([release("v0.1.2")]); } });
  await Promise.all([check(), check(), check()]);
  assert.equal(calls, 1);
  for (t = 0; t < 60 * minute; t += minute) await check();
  assert.equal(calls, 4); // one call each 15 minutes over the hour
  t = 60 * minute; fail = true;
  const failed = await check();
  assert.deepEqual([failed.updateAvailable, failed.latest?.version, failed.checkedAt], [true, "0.1.2", new Date(t).toISOString()]);
  assert.match(failed.error!, /403/);
  t += 14 * minute; await check(); assert.equal(calls, 5); // waits the full period after the first failure
  t += minute; await check(); assert.equal(calls, 6);
  t += 29 * minute; await check(); assert.equal(calls, 6); // then twice as long
  t += minute; fail = false; assert.equal((await check()).error, null);
  assert.equal(calls, 7);
});

test("background checks look straight away, then on every tick until stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let looks = 0;
  const stop = startUpdateChecks(async () => { looks++; }, { everyMs: 1000 });
  assert.equal(looks, 1);
  t.mock.timers.tick(3000);
  assert.equal(looks, 4);
  stop();
  t.mock.timers.tick(3000);
  assert.equal(looks, 4);
});

test("a preview install is offered newer previews, a stable install only stable releases", async () => {
  const list = async () => json([release("v0.2.0-preview.2", { prerelease: true }), release("v0.1.9")]);
  const preview = await createUpdateChecker({ env: {}, version: "0.2.0-preview.1", fetchImpl: list })();
  assert.deepEqual([preview.updateAvailable, preview.latest?.version], [true, "0.2.0-preview.2"]);
  const stable = await createUpdateChecker({ env: {}, version: "0.1.9", fetchImpl: list })();
  assert.deepEqual([stable.updateAvailable, stable.latest?.version], [false, "0.1.9"]);
});

test("the update check also carries the running release's notes, whole, for what changed after an update", async () => {
  const long = "x".repeat(20_000);
  const list = async () => json([release("v0.1.7", { body: `notes v0.1.7 ${long}` }), release("v0.1.6", { assets: [] })]);
  const status = await createUpdateChecker({ env: {}, version: "0.1.6", fetchImpl: list })();
  assert.equal(status.latest?.version, "0.1.7");
  assert.equal(status.latest?.notes.length, `notes v0.1.7 ${long}`.length, "a full changelog isn't cut at 4,000 characters");
  // The running release needs no download assets to show its notes.
  assert.deepEqual(status.current, { version: "0.1.6", url: "https://example.test/v0.1.6", notes: "notes v0.1.6", publishedAt: null });
  const dev = await createUpdateChecker({ env: {}, version: "0.1.8", fetchImpl: list })();
  assert.equal(dev.current, null);
});

test("installedRuntime recognizes Windows launcher installation path", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "tb-win-app-"));
  const winApp = path.join(temp, "Programs", "Threebot", "app");
  mkdirSync(winApp, { recursive: true });
  const env = { LOCALAPPDATA: temp };
  assert.equal(defaultWindowsAppDir(env), winApp);
  if (process.platform === "win32") {
    assert.equal(installedRuntime(winApp, path.join(temp, ".threebot"), env), true);
  }
});

test("createUpdateChecker passes ETag and reuses cache on HTTP 304 Not Modified", async () => {
  let calls = 0;
  let receivedHeaders: Record<string, string> | undefined;
  const mockFetch: FetchJson = async (_url, init) => {
    calls++;
    receivedHeaders = (init?.headers as Record<string, string>) || {};
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        headers: { etag: '"v1-etag"' },
        json: async () => [release("v0.2.0")],
      };
    }
    if (receivedHeaders["if-none-match"] === '"v1-etag"') {
      return {
        ok: false,
        status: 304,
        headers: { etag: '"v1-etag"' },
      } as any;
    }
    return {
      ok: true,
      status: 200,
      headers: { etag: '"v2-etag"' },
      json: async () => [release("v0.3.0")],
    };
  };

  const check = createUpdateChecker({ env: {}, version: "0.1.0", fetchImpl: mockFetch });
  const first = await check();
  assert.equal(first.updateAvailable, true);
  assert.equal(first.latest?.version, "0.2.0");
  assert.equal(calls, 1);
  assert.equal(receivedHeaders!["if-none-match"], undefined);

  const second = await check({ force: true });
  assert.equal(second.updateAvailable, true);
  assert.equal(second.latest?.version, "0.2.0");
  assert.equal(calls, 2);
  assert.equal(receivedHeaders!["if-none-match"], '"v1-etag"');
});

test("createUpdateChecker reports rate limit reset time on HTTP 403 with x-ratelimit-reset", async () => {
  const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
  const mockFetch: FetchJson = async () => ({
    ok: false,
    status: 403,
    headers: { "x-ratelimit-reset": String(resetEpoch) },
  });
  const check = createUpdateChecker({ env: {}, fetchImpl: mockFetch });
  const status = await check();
  assert.match(status.error!, /rate limit exceeded/i);
  assert.match(status.error!, /resets at/i);
});

test("createUpdateChecker applies jitter within the jitterRatio bounds", async () => {
  let t = 0;
  const minute = 60 * 1000;
  let minCalls = 0;
  const minCheck = createUpdateChecker({
    env: {}, version: "0.1.0", now: () => t,
    ttlMs: 15 * minute, jitterRatio: 0.15, random: () => 0,
    fetchImpl: async () => { minCalls++; return json([release("v0.1.2")]); },
  });
  await minCheck();
  t = 764 * 1000;
  await minCheck();
  assert.equal(minCalls, 1);
  t = 766 * 1000;
  await minCheck();
  assert.equal(minCalls, 2);

  let maxCalls = 0;
  t = 0;
  const maxCheck = createUpdateChecker({
    env: {}, version: "0.1.0", now: () => t,
    ttlMs: 15 * minute, jitterRatio: 0.15, random: () => 1,
    fetchImpl: async () => { maxCalls++; return json([release("v0.1.2")]); },
  });
  await maxCheck();
  t = 1034 * 1000;
  await maxCheck();
  assert.equal(maxCalls, 1);
  t = 1036 * 1000;
  await maxCheck();
  assert.equal(maxCalls, 2);
});
