// Installed Threebot lives in $THREEBOT_HOME/runtime, laid out like T3 Code's: one folder per
// version, a `current` link the service runs, and the version before it kept for a rollback.
// Releases are GitHub release assets checked against the release's SHA256SUMS.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = "RokaSwK/threebot";

export const packageRoot = path.resolve(here, "..");
export function currentVersion(root = packageRoot) {
  try { return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
}

export function homeDir(env = process.env) {
  return env.THREEBOT_HOME || path.join(homedir(), ".threebot");
}
export function runtimePaths(home = homeDir()) {
  const runtime = path.join(home, "runtime");
  return { home, runtime, versions: path.join(runtime, "versions"), current: path.join(runtime, "current"), previous: path.join(runtime, "previous") };
}

/** True when this copy runs from an installed runtime, so it can update itself. */
export function installedRuntime(root = packageRoot, home = homeDir()) {
  // Compare real paths: Node resolves the running file's links (/tmp is /private/tmp on macOS).
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  return path.dirname(real(root)) === real(runtimePaths(home).versions);
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
export function compareVersions(a, b) {
  const x = SEMVER.exec(String(a).replace(/^v/, "")), y = SEMVER.exec(String(b).replace(/^v/, ""));
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  // 1.0.0-preview.1 comes before 1.0.0.
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  return x[4].localeCompare(y[4], "en", { numeric: true });
}

export const assetName = (version) => `threebot-${version}.tar.gz`;

/**
 * The release to install: the newest stable one, or an exact version. THREEBOT_RELEASES_URL points
 * at a GitHub-API-shaped list (for mirrors and tests); THREEBOT_RELEASE_BASE_URL swaps the download host.
 */
export async function findRelease({ version, channel = "stable", env = process.env, fetchImpl = fetch } = {}) {
  const api = env.THREEBOT_RELEASES_URL || `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const res = await fetchImpl(api, { headers: { accept: "application/vnd.github+json", "user-agent": "threebot-updater" } });
  if (!res.ok) throw new Error(`Couldn't list releases (HTTP ${res.status})`);
  const releases = (await res.json()).filter((r) => !r.draft && (channel === "preview" || !r.prerelease));
  const wanted = version ? releases.find((r) => r.tag_name.replace(/^v/, "") === String(version).replace(/^v/, "")) : releases
    .filter((r) => SEMVER.test(r.tag_name.replace(/^v/, "")))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
  if (!wanted) return null;
  const v = wanted.tag_name.replace(/^v/, "");
  const base = env.THREEBOT_RELEASE_BASE_URL ? `${env.THREEBOT_RELEASE_BASE_URL.replace(/\/$/, "")}/v${v}` : null;
  const asset = (name) => base ? `${base}/${name}` : wanted.assets?.find((a) => a.name === name)?.browser_download_url;
  const archive = asset(assetName(v)), sums = asset("SHA256SUMS");
  if (!archive || !sums) return null;
  return { version: v, archive, sums, notes: wanted.body ?? "", url: wanted.html_url ?? `https://github.com/${REPO}/releases/tag/v${v}`, publishedAt: wanted.published_at ?? null };
}

export function expectedSum(sumsText, name) {
  for (const line of String(sumsText).split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

async function download(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { "user-agent": "threebot-updater" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "", err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(Object.assign(new Error(`${command} ${args.join(" ")} failed (${code}): ${(err || out).trim().slice(-800)}`), { code, stdout: out, stderr: err })));
  });
}

/** Download, verify and unpack a release into versions/<version>, with its server dependencies installed. */
export async function installRelease(release, { home = homeDir(), fetchImpl = fetch, log = () => {}, npm = "npm" } = {}) {
  const paths = runtimePaths(home);
  const target = path.join(paths.versions, release.version);
  if (existsSync(path.join(target, ".install-complete"))) return target;
  await fs.mkdir(paths.versions, { recursive: true });
  log(`Downloading Threebot ${release.version}`);
  const [archive, sums] = await Promise.all([download(release.archive, fetchImpl), download(release.sums, fetchImpl)]);
  const expected = expectedSum(sums.toString("utf8"), assetName(release.version));
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${assetName(release.version)}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${assetName(release.version)}: expected ${expected}, got ${actual}`);
  const staging = await fs.mkdtemp(path.join(paths.versions, ".staging-"));
  try {
    const file = path.join(staging, assetName(release.version));
    await fs.writeFile(file, archive);
    await run("tar", ["-xzf", file, "-C", staging, "--strip-components=1"]);
    await fs.rm(file);
    const unpacked = currentVersion(staging);
    if (unpacked !== release.version) throw new Error(`The archive holds version ${unpacked}, not ${release.version}`);
    log("Installing server dependencies");
    await run(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(staging, "server") });
    await fs.writeFile(path.join(staging, ".install-complete"), new Date().toISOString() + "\n");
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
}

async function swapLink(link, target) {
  const temp = `${link}.${process.pid}.tmp`;
  await fs.rm(temp, { force: true });
  await fs.symlink(target, temp);
  await fs.rename(temp, link); // rename over a link is atomic, so `current` is never missing.
}
export async function readLink(link) {
  try { return path.resolve(path.dirname(link), await fs.readlink(link)); } catch { return null; }
}

/** Point `current` at a version and remember the one it replaces. Returns that previous folder. */
export async function activate(versionDir, home = homeDir()) {
  const paths = runtimePaths(home);
  await fs.mkdir(paths.runtime, { recursive: true });
  const before = await readLink(paths.current);
  if (before && path.resolve(before) !== path.resolve(versionDir)) await swapLink(paths.previous, before);
  await swapLink(paths.current, versionDir);
  return before;
}

/** Undo the last activate. */
export async function rollback(home = homeDir()) {
  const paths = runtimePaths(home);
  const previous = await readLink(paths.previous);
  if (!previous || !existsSync(previous)) throw new Error("There is no earlier version to go back to.");
  await swapLink(paths.current, previous);
  await fs.rm(paths.previous, { force: true });
  return previous;
}

/** Remove versions other than current and previous. */
export async function prune(home = homeDir()) {
  const paths = runtimePaths(home);
  const keep = new Set([await readLink(paths.current), await readLink(paths.previous)].filter(Boolean).map((p) => path.resolve(p)));
  const removed = [];
  for (const name of await fs.readdir(paths.versions).catch(() => [])) {
    const dir = path.resolve(paths.versions, name);
    if (keep.has(dir)) continue;
    await fs.rm(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** What the app shows in Settings → Updates. Cached so opening Settings doesn't hit GitHub each time. */
export function createUpdateChecker({ env = process.env, fetchImpl = fetch, ttlMs = 10 * 60 * 1000, version = currentVersion() } = {}) {
  let cache = null;
  return async function check({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < ttlMs) return cache.value;
    let value;
    try {
      const latest = await findRelease({ env, fetchImpl });
      value = { latest: latest && { version: latest.version, url: latest.url, notes: latest.notes.slice(0, 4000), publishedAt: latest.publishedAt }, updateAvailable: Boolean(latest && compareVersions(latest.version, version) > 0), error: null };
    } catch (error) {
      value = { latest: null, updateAvailable: false, error: error instanceof Error ? error.message : String(error) };
    }
    cache = { at: Date.now(), value };
    return value;
  };
}
