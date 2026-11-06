// One-click ways to reach Threebot from a phone, modelled on T3 Code's:
// - Tailscale: `tailscale serve` on a free HTTPS port, in front of a loopback-only listener that
//   trusts the signed-in Tailscale user. Private to your tailnet.
// - Cloudflare: a quick tunnel (`cloudflared tunnel --url`), a public https://*.trycloudflare.com
//   link with no account. Public, so it only starts once the app has a password.
// Choices persist in access.json and are applied again when the gateway starts.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { run } from "./release.mts";

const scrypt = promisify(scryptCb);

// ---------- the saved choices ----------

export function createAccessStore(file) {
  let cache;
  const read = async () => {
    if (cache) return cache;
    try { cache = JSON.parse(await fs.readFile(file, "utf8")); } catch { cache = {}; }
    return cache;
  };
  const write = async (next) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(temp, file);
    cache = next;
    return next;
  };
  return { read, write, update: async (patch) => write({ ...(await read()), ...patch }) };
}

export const MIN_PASSWORD = 8;
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), setAt: new Date().toISOString() };
}
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || !stored?.salt || !stored?.hash) return false;
  const expected = Buffer.from(stored.hash, "base64");
  const actual = await scrypt(password, Buffer.from(stored.salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

// A folder Node's permission model (or the OS) won't let us read counts as "not there".
function exists(file) {
  try { return existsSync(file); } catch { return false; }
}

// ---------- Tailscale ----------

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export function findOnPath(name, pathEnv = process.env.PATH ?? "") {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    if (exists(file)) return file;
  }
  return null;
}
export function findTailscale(env = process.env) {
  return env.TAILSCALE_PATH || findOnPath("tailscale", env.PATH) || (process.platform === "darwin" && exists(TAILSCALE_APP) ? TAILSCALE_APP : null);
}

/** What `tailscale status --json` says, reduced to what the setup needs. */
export function parseTailscaleStatus(json) {
  const s = typeof json === "string" ? JSON.parse(json) : json;
  const self = s.Self ?? {};
  const state = s.BackendState ?? "Unknown";
  const caps = Object.keys(self.CapMap ?? {});
  const user = s.User?.[String(self.UserID)];
  return {
    state,
    running: state === "Running",
    needsLogin: state === "NeedsLogin" || state === "NoState",
    authUrl: s.AuthURL || null,
    dnsName: String(self.DNSName ?? "").replace(/\.$/, "") || null,
    // Serve needs HTTPS certificates turned on for the tailnet.
    https: caps.includes("https") || (s.CertDomains ?? []).length > 0,
    login: user?.LoginName ?? null,
  };
}

const WEB_PORTS = [443, 8443, 8444, 8445, 9443];
/** An HTTPS port already serving our listener, or the first one nothing else uses. */
export function pickServePort(serveJson, localUrl) {
  const web = (serveJson ?? {}).Web ?? {};
  const used = new Set(Object.keys((serveJson ?? {}).TCP ?? {}).map(Number));
  for (const [hostPort, conf] of Object.entries(web)) {
    const port = Number(hostPort.split(":").pop());
    used.add(port);
    if (conf?.Handlers?.["/"]?.Proxy === localUrl) return { port, ours: true };
  }
  const free = WEB_PORTS.find((p) => !used.has(p));
  return free ? { port: free, ours: false } : null;
}
export function serveOwner(serveJson, port) {
  for (const [hostPort, conf] of Object.entries((serveJson ?? {}).Web ?? {})) {
    if (Number(hostPort.split(":").pop()) === Number(port)) return conf?.Handlers?.["/"]?.Proxy ?? null;
  }
  return null;
}
export const tailnetUrl = (dnsName, port) => `https://${dnsName}${Number(port) === 443 ? "" : `:${port}`}`;

export function createTailscale({ bin = findTailscale(), exec = run } = {}) {
  // The macOS app's binary only acts as the CLI when SHLVL says a shell started it; services have none.
  const env = { ...process.env, SHLVL: process.env.SHLVL || "1" };
  const ts = (args, timeout = 10000) => exec(bin, args, { timeout, env });
  return {
    bin,
    async status() {
      if (!bin) return { installed: false };
      try { return { installed: true, ...parseTailscaleStatus(await ts(["status", "--json"], 5000)) }; }
      catch (error) {
        // `status --json` exits non-zero while logged out; it still prints the state.
        if (error.stdout) { try { return { installed: true, ...parseTailscaleStatus(error.stdout) }; } catch {} }
        return { installed: true, running: false, state: "NotRunning", error: String(error.stderr || error.message).trim().slice(0, 300) };
      }
    },
    async serveConfig() {
      try { return JSON.parse((await ts(["serve", "status", "--json"], 5000)) || "{}"); } catch { return {}; }
    },
    serve: (httpsPort, localUrl) => ts(["serve", "--bg", `--https=${httpsPort}`, localUrl]),
    unserve: (httpsPort) => ts(["serve", `--https=${httpsPort}`, "--set-path=/", "off"]),
  };
}

// ---------- Cloudflare quick tunnels ----------

// The same pinned cloudflared and checksums T3 Code downloads.
export const CLOUDFLARED_VERSION = "2026.10.4";
const CF = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
export const CLOUDFLARED_ASSETS = {
  "darwin-arm64": { url: `${CF}/cloudflared-darwin-arm64.tgz`, sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f", archive: "tgz" },
  "darwin-x64": { url: `${CF}/cloudflared-darwin-amd64.tgz`, sha256: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d", archive: "tgz" },
  "linux-arm64": { url: `${CF}/cloudflared-linux-arm64`, sha256: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6", archive: "binary" },
  "linux-x64": { url: `${CF}/cloudflared-linux-amd64`, sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42", archive: "binary" },
};
export const pinnedCloudflared = (home, platform = process.platform, arch = process.arch) =>
  path.join(home, "tools", "cloudflared", CLOUDFLARED_VERSION, `${platform}-${arch}`, "cloudflared");

export function findCloudflared(home, env = process.env) {
  if (env.CLOUDFLARED_PATH) return env.CLOUDFLARED_PATH;
  const pinned = pinnedCloudflared(home);
  return exists(pinned) ? pinned : findOnPath("cloudflared", env.PATH);
}

export async function installCloudflared(home, { fetchImpl = fetch, platform = process.platform, arch = process.arch } = {}) {
  const asset = CLOUDFLARED_ASSETS[`${platform}-${arch}`];
  if (!asset) throw new Error(`No cloudflared download for ${platform}-${arch}. Install it yourself and try again.`);
  const target = pinnedCloudflared(home, platform, arch);
  const res = await fetchImpl(asset.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't download cloudflared (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== asset.sha256) throw new Error(`cloudflared checksum mismatch: expected ${asset.sha256}, got ${sum}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (asset.archive === "tgz") {
    const tgz = `${target}.tgz`;
    await fs.writeFile(tgz, bytes);
    await run("tar", ["-xzf", tgz, "-C", path.dirname(target)]);
    await fs.rm(tgz);
  } else {
    await fs.writeFile(target, bytes);
  }
  await fs.chmod(target, 0o755);
  return target;
}

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED = /Registered tunnel connection/;
/**
 * Start a quick tunnel to localUrl. Resolves once cloudflared has a link and a registered edge
 * connection: it prints the link first, and the link doesn't work until a connection is up.
 * HTTP/2 like T3 Code's tunnels, because many networks block QUIC on port 7844.
 */
export function startQuickTunnel({ bin, localUrl, spawnImpl = spawn, timeoutMs = 60000, onExit = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", localUrl], { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false, tail = "", url = null, registered = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error("cloudflared didn't hand out a link in time. Try again.")); } }, timeoutMs);
    const watch = (chunk) => {
      tail = (tail + chunk).slice(-4000);
      url ??= tail.match(QUICK_URL)?.[0] ?? null;
      registered ||= REGISTERED.test(tail);
      if (url && registered && !settled) { settled = true; clearTimeout(timer); resolve({ url, child, stop: () => child.kill() }); }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error(`cloudflared exited (${code}): ${tail.trim().split("\n").slice(-3).join(" ")}`)); }
      else onExit(code);
    });
  });
}

// ---------- the gateway's side ----------

/**
 * Apply and report remote access. The gateway passes in how to open and close its loopback
 * Tailscale listener, so this module never touches the HTTP server itself.
 */
export function createRemoteAccess({ store, home, localPort, urlFile = null, exposure, envPassword = "", envTailnet = false, openTailnet, closeTailnet, tailscale = createTailscale(), tunnelBin = () => findCloudflared(home), installTunnelBin = () => installCloudflared(home), startTunnel = startQuickTunnel, log = console }) {
  let tunnel = null; // { url, stop }
  let tunnelError = null;
  // One change at a time: two quick clicks must not start two tunnels, or drop the password mid-start.
  let queue = Promise.resolve();
  const serial = (fn) => (...args) => { const run = queue.then(() => fn(...args)); queue = run.catch(() => {}); return run; };
  const tailnetPort = () => exposure.tailnetPort || localPort + 1;

  async function hasPassword() { return Boolean(envPassword) || Boolean((await store.read()).password); }

  async function status() {
    const saved = await store.read();
    const ts = await tailscale.status();
    let tailnet = null;
    if (ts.installed && ts.running && ts.dnsName && saved.tailscale?.enabled) {
      const owner = serveOwner(await tailscale.serveConfig(), saved.tailscale.httpsPort);
      tailnet = { url: tailnetUrl(ts.dnsName, saved.tailscale.httpsPort), serving: owner === `http://127.0.0.1:${tailnetPort()}` };
    }
    return {
      password: { set: await hasPassword(), fromEnv: Boolean(envPassword) },
      tailscale: { ...ts, authUrl: ts.authUrl ?? null, enabled: Boolean(saved.tailscale?.enabled), fromEnv: envTailnet, users: saved.tailscale?.users ?? [...exposure.tailnetUsers], ...tailnet },
      tunnel: { enabled: Boolean(saved.tunnel?.enabled), url: tunnel?.url ?? null, error: tunnelError, available: Boolean(tunnelBin()) },
    };
  }

  async function setPassword(password) {
    if (envPassword) throw Object.assign(new Error("The password is set by BOT_PASSWORD in .env."), { status: 409 });
    if (password === null) {
      if ((await store.read()).tunnel?.enabled) throw Object.assign(new Error("Turn off the Cloudflare link before removing the password."), { status: 409 });
      await store.update({ password: undefined });
      return;
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD) throw Object.assign(new Error(`Use at least ${MIN_PASSWORD} characters.`), { status: 400 });
    await store.update({ password: await hashPassword(password) });
  }

  async function tailscaleOn() {
    if (envTailnet) throw Object.assign(new Error("Tailscale is set up in .env (TAILNET_PORT)."), { status: 409 });
    const ts = await tailscale.status();
    if (!ts.installed) throw Object.assign(new Error("Install Tailscale on this machine first."), { status: 409, code: "not-installed" });
    if (!ts.running) throw Object.assign(new Error(ts.needsLogin ? "Sign in to Tailscale on this machine first." : "Start Tailscale on this machine first."), { status: 409, code: ts.needsLogin ? "needs-login" : "not-running" });
    if (!ts.https) throw Object.assign(new Error("Turn on HTTPS certificates for your tailnet first."), { status: 409, code: "https-off" });
    if (!ts.login) throw Object.assign(new Error("Couldn't tell which Tailscale user this machine belongs to."), { status: 409 });
    const port = tailnetPort();
    const localUrl = `http://127.0.0.1:${port}`;
    const pick = pickServePort(await tailscale.serveConfig(), localUrl);
    if (!pick) throw Object.assign(new Error("Every HTTPS port Threebot tries is taken by other Tailscale Serve routes."), { status: 409 });
    const users = [ts.login.toLowerCase()];
    await openTailnet(port, users);
    if (!pick.ours) await tailscale.serve(pick.port, localUrl);
    await store.update({ tailscale: { enabled: true, port, httpsPort: pick.port, users } });
    return { url: tailnetUrl(ts.dnsName, pick.port) };
  }

  async function tailscaleOff() {
    const saved = (await store.read()).tailscale;
    if (saved?.httpsPort && serveOwner(await tailscale.serveConfig(), saved.httpsPort) === `http://127.0.0.1:${saved.port}`) {
      await tailscale.unserve(saved.httpsPort);
    }
    if (!envTailnet) await closeTailnet();
    await store.update({ tailscale: { ...saved, enabled: false } });
  }

  async function tunnelOn() {
    if (!(await hasPassword())) throw Object.assign(new Error("A Cloudflare link is public. Set a password first."), { status: 409, code: "needs-password" });
    if (tunnel) return { url: tunnel.url };
    let bin = tunnelBin();
    if (!bin) bin = await installTunnelBin();
    tunnelError = null;
    const started = await startTunnel({
      bin,
      localUrl: `http://127.0.0.1:${localPort}`,
      onExit: (code) => {
        // Turning it off stops cloudflared too; only an exit nobody asked for is an error.
        if (tunnel !== started) return;
        tunnel = null;
        if (urlFile) fs.rm(urlFile, { force: true }).catch(() => {});
        tunnelError = `cloudflared stopped (${code}).`;
        log.warn?.(`cloudflare tunnel stopped (${code})`);
      },
    });
    tunnel = started;
    await store.update({ tunnel: { enabled: true } });
    // `threebot tunnel status` reads the link from here.
    if (urlFile) await fs.writeFile(urlFile, tunnel.url + "\n");
    log.log?.(`cloudflare tunnel at ${tunnel.url}`);
    return { url: tunnel.url };
  }

  async function tunnelOff() {
    const running = tunnel;
    tunnel = null;
    running?.stop();
    if (urlFile) await fs.rm(urlFile, { force: true });
    await store.update({ tunnel: { enabled: false } });
  }

  /** On start: bring back what was on. A failure is logged and shown in Settings, never fatal. */
  async function boot() {
    const saved = await store.read();
    if (saved.tailscale?.enabled && !envTailnet) {
      try { await openTailnet(saved.tailscale.port, saved.tailscale.users ?? []); }
      catch (error) { log.error?.("tailnet listener failed", error.message); }
    }
    if (saved.tunnel?.enabled) {
      try { await tunnelOn(); } catch (error) { tunnelError = error.message; log.error?.("cloudflare tunnel failed", error.message); }
    }
  }

  return { status, setPassword: serial(setPassword), tailscaleOn: serial(tailscaleOn), tailscaleOff: serial(tailscaleOff), tunnelOn: serial(tunnelOn), tunnelOff: serial(tunnelOff), boot: serial(boot), verify: async (password) => verifyPassword(password, (await store.read()).password), hasPassword, stop: () => tunnel?.stop() };
}
