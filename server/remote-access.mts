// One-click ways to reach Threebot from a phone, modelled on T3 Code's:
// - Tailscale: `tailscale serve` on a free HTTPS port, in front of a loopback-only listener that
//   trusts the signed-in Tailscale user. Private to your tailnet.
// - Cloudflare: a quick tunnel (`cloudflared tunnel --url`), a public https://*.trycloudflare.com
//   link with no account. Public, so it only starts once the app has a password.
// Choices persist in access.json and are applied again when the gateway starts.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike } from "node:crypto";
import { spawn, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { run, type FetchBytes, type RunError } from "./release.mts";

// scrypt's overloads leave promisify without a result type; this is the three-argument form used here.
const scrypt = promisify(scryptCb) as (password: BinaryLike, salt: BinaryLike, keylen: number) => Promise<Buffer>;

// ---------- the saved choices ----------

/** A saved password: its scrypt hash and salt. */
export interface StoredPassword { salt: string; hash: string; setAt: string }
/** What access.json holds. An enabled Tailscale route always has its ports and users saved with it. */
export interface AccessState {
  password?: StoredPassword;
  tailscale?:
    | { enabled: true; port: number; httpsPort: number; users: string[] }
    | { enabled: false; port?: number; httpsPort?: number; users?: string[] };
  tunnel?: { enabled: boolean };
}
export type AccessStore = ReturnType<typeof createAccessStore>;

export function createAccessStore(file: string) {
  let cache: AccessState | undefined;
  const read = async (): Promise<AccessState> => {
    if (cache) return cache;
    try { cache = JSON.parse(await fs.readFile(file, "utf8")) as AccessState; } catch { cache = {}; }
    return cache;
  };
  const write = async (next: AccessState) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(temp, file);
    cache = next;
    return next;
  };
  return { read, write, update: async (patch: Partial<AccessState>) => write({ ...(await read()), ...patch }) };
}

export const MIN_PASSWORD = 8;
export async function hashPassword(password: string): Promise<StoredPassword> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), setAt: new Date().toISOString() };
}
export async function verifyPassword(password: unknown, stored: StoredPassword | null | undefined): Promise<boolean> {
  if (typeof password !== "string" || !stored?.salt || !stored?.hash) return false;
  const expected = Buffer.from(stored.hash, "base64");
  const actual = await scrypt(password, Buffer.from(stored.salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

// A folder Node's permission model (or the OS) won't let us read counts as "not there".
function exists(file: string) {
  try { return existsSync(file); } catch { return false; }
}

// ---------- Tailscale ----------

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export function findOnPath(name: string, pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    if (exists(file)) return file;
  }
  return null;
}
export function findTailscale(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.TAILSCALE_PATH || findOnPath("tailscale", env.PATH) || (process.platform === "darwin" && exists(TAILSCALE_APP) ? TAILSCALE_APP : null);
}

/** The fields of `tailscale status --json` this file reads. */
export interface TailscaleStatusJson {
  BackendState?: string;
  AuthURL?: string;
  Self?: { DNSName?: string; UserID?: number; CapMap?: Record<string, unknown> };
  User?: Record<string, { LoginName?: string }>;
  CertDomains?: string[];
}
/** What `tailscale status --json` says, reduced to what the setup needs. */
export function parseTailscaleStatus(json: string | TailscaleStatusJson) {
  const s: TailscaleStatusJson = typeof json === "string" ? JSON.parse(json) : json;
  const self: NonNullable<TailscaleStatusJson["Self"]> = s.Self ?? {};
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

/** What `tailscale status` tells the app: parseTailscaleStatus's facts, once Tailscale is installed and answers. */
export type TailscaleStatus = { installed: boolean; error?: string } & Partial<ReturnType<typeof parseTailscaleStatus>>;
/** The fields of `tailscale serve status --json` this file reads. */
export interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | null> } | null>;
}

const WEB_PORTS = [443, 8443, 8444, 8445, 9443];
/** An HTTPS port already serving our listener, or the first one nothing else uses. */
export function pickServePort(serveJson: ServeConfig | null | undefined, localUrl: string): { port: number; ours: boolean } | null {
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
export function serveOwner(serveJson: ServeConfig | null | undefined, port: number): string | null {
  for (const [hostPort, conf] of Object.entries((serveJson ?? {}).Web ?? {})) {
    if (Number(hostPort.split(":").pop()) === Number(port)) return conf?.Handlers?.["/"]?.Proxy ?? null;
  }
  return null;
}
export const tailnetUrl = (dnsName: string, port: number) => `https://${dnsName}${Number(port) === 443 ? "" : `:${port}`}`;

/** What the gateway uses of createTailscale (tests stand in for it). */
export interface TailscaleControl {
  status(): Promise<TailscaleStatus>;
  serveConfig(): Promise<ServeConfig>;
  serve(httpsPort: number, localUrl: string): Promise<unknown>;
  unserve(httpsPort: number): Promise<unknown>;
}

export function createTailscale({ bin = findTailscale(), exec = run }: { bin?: string | null; exec?: typeof run } = {}) {
  // The macOS app's binary only acts as the CLI when SHLVL says a shell started it; services have none.
  const env = { ...process.env, SHLVL: process.env.SHLVL || "1" };
  // Only status() checks for a missing binary; elsewhere spawn rejects, as it always has.
  const ts = (args: string[], timeout = 10000) => exec(bin as string, args, { timeout, env });
  return {
    bin,
    async status(): Promise<TailscaleStatus> {
      if (!bin) return { installed: false };
      try { return { installed: true, ...parseTailscaleStatus(await ts(["status", "--json"], 5000)) }; }
      catch (error) {
        // `status --json` exits non-zero while logged out; it still prints the state.
        if ((error as RunError).stdout) { try { return { installed: true, ...parseTailscaleStatus((error as RunError).stdout!) }; } catch {} }
        return { installed: true, running: false, state: "NotRunning", error: String((error as RunError).stderr || (error as RunError).message).trim().slice(0, 300) };
      }
    },
    async serveConfig(): Promise<ServeConfig> {
      try { return JSON.parse((await ts(["serve", "status", "--json"], 5000)) || "{}"); } catch { return {}; }
    },
    serve: (httpsPort: number, localUrl: string) => ts(["serve", "--bg", `--https=${httpsPort}`, localUrl]),
    unserve: (httpsPort: number) => ts(["serve", `--https=${httpsPort}`, "--set-path=/", "off"]),
  };
}

// ---------- Cloudflare quick tunnels ----------

// The same pinned cloudflared and checksums T3 Code downloads.
export const CLOUDFLARED_VERSION = "2026.10.4";
const CF = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
export const CLOUDFLARED_ASSETS: Record<string, { url: string; sha256: string; archive: "tgz" | "binary" } | undefined> = {
  "darwin-arm64": { url: `${CF}/cloudflared-darwin-arm64.tgz`, sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f", archive: "tgz" },
  "darwin-x64": { url: `${CF}/cloudflared-darwin-amd64.tgz`, sha256: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d", archive: "tgz" },
  "linux-arm64": { url: `${CF}/cloudflared-linux-arm64`, sha256: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6", archive: "binary" },
  "linux-x64": { url: `${CF}/cloudflared-linux-amd64`, sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42", archive: "binary" },
};
export const pinnedCloudflared = (home: string, platform: string = process.platform, arch: string = process.arch) =>
  path.join(home, "tools", "cloudflared", CLOUDFLARED_VERSION, `${platform}-${arch}`, "cloudflared");

export function findCloudflared(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLOUDFLARED_PATH) return env.CLOUDFLARED_PATH;
  const pinned = pinnedCloudflared(home);
  return exists(pinned) ? pinned : findOnPath("cloudflared", env.PATH);
}

export async function installCloudflared(home: string, { fetchImpl = fetch, platform = process.platform, arch = process.arch }: { fetchImpl?: FetchBytes; platform?: string; arch?: string } = {}): Promise<string> {
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

/** The part of cloudflared's child process this file uses (tests hand in an EventEmitter). */
export interface TunnelChild {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}
export interface QuickTunnel { url: string; child: TunnelChild; stop: () => unknown }
type TunnelSpawn = (command: string, args: string[], options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>) => TunnelChild;

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED = /Registered tunnel connection/;
/**
 * Start a quick tunnel to localUrl. Resolves once cloudflared has a link and a registered edge
 * connection: it prints the link first, and the link doesn't work until a connection is up.
 * HTTP/2 like T3 Code's tunnels, because many networks block QUIC on port 7844.
 */
export function startQuickTunnel({ bin, localUrl, spawnImpl = spawn, timeoutMs = 60000, onExit = () => {} }: { bin: string; localUrl: string; spawnImpl?: TunnelSpawn; timeoutMs?: number; onExit?: (code: number | null) => void }): Promise<QuickTunnel> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", localUrl], { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false, tail = "", url: string | null = null, registered = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error("cloudflared didn't hand out a link in time. Try again.")); } }, timeoutMs);
    const watch = (chunk: Buffer | string) => {
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
export function createRemoteAccess({ store, home, localPort, urlFile = null, exposure, envPassword = "", envTailnet = false, openTailnet, closeTailnet, tailscale = createTailscale(), tunnelBin = () => findCloudflared(home), installTunnelBin = () => installCloudflared(home), startTunnel = startQuickTunnel, log = console }: {
  store: AccessStore;
  home: string;
  localPort: number;
  urlFile?: string | null;
  exposure: { tailnetPort: number; tailnetUsers: Iterable<string> };
  envPassword?: string;
  envTailnet?: boolean;
  openTailnet: (port: number, users: string[]) => Promise<unknown>;
  closeTailnet: () => Promise<unknown>;
  tailscale?: TailscaleControl;
  tunnelBin?: () => string | null;
  installTunnelBin?: () => Promise<string>;
  startTunnel?: (options: { bin: string; localUrl: string; onExit: (code: number | null) => void }) => Promise<{ url: string; stop: () => unknown }>;
  log?: Partial<Pick<Console, "log" | "warn" | "error">>;
}) {
  let tunnel: { url: string; stop: () => unknown } | null = null;
  let tunnelError: string | null = null;
  // One change at a time: two quick clicks must not start two tunnels, or drop the password mid-start.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A): Promise<R> => { const run = queue.then(() => fn(...args)); queue = run.catch(() => {}); return run; };
  const tailnetPort = () => exposure.tailnetPort || localPort + 1;

  async function hasPassword() { return Boolean(envPassword) || Boolean((await store.read()).password); }

  async function status() {
    const saved = await store.read();
    const ts = await tailscale.status();
    let tailnet: { url: string; serving: boolean } | null = null;
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

  async function setPassword(password: unknown) {
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
    return { url: tailnetUrl(ts.dnsName!, pick.port) };
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
      catch (error) { log.error?.("tailnet listener failed", (error as Error).message); }
    }
    if (saved.tunnel?.enabled) {
      try { await tunnelOn(); } catch (error) { tunnelError = (error as Error).message; log.error?.("cloudflare tunnel failed", (error as Error).message); }
    }
  }

  return { status, setPassword: serial(setPassword), tailscaleOn: serial(tailscaleOn), tailscaleOff: serial(tailscaleOff), tunnelOn: serial(tunnelOn), tunnelOff: serial(tunnelOff), boot: serial(boot), verify: async (password: unknown) => verifyPassword(password, (await store.read()).password), hasPassword, stop: () => tunnel?.stop() };
}
