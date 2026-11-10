#!/usr/bin/env node
// The `threebot` command: set up, run, update and reach Threebot, the way `t3` does for T3 Code.
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { activate, compareVersions, currentVersion, findRelease, homeDir, installRelease, installedRuntime, prune, rollback, run, runtimePaths, updateLogger } from "./release.mts";
import { installService, restartService, serviceInstalled, serviceSpec, serviceSupported, uninstallService } from "./service.mts";
import { randomBytes } from "node:crypto";
import { createAccessStore, createTailscale, findCloudflared, hashPassword, installCloudflared, MIN_PASSWORD, pickServePort, serveOwner, tailnetUrl } from "./remote-access.mts";
import { antigravityBridgeStatus, installAntigravityBridge, uninstallAntigravityBridge } from "./harness-bridge.mts";
import { T3Client } from "./t3rpc.mts";
import { defaultMemorySchedule, ensureMemoryRoutine, findMemoryRoutine, runMemoryRoutine, setMemoryRoutineEnabled } from "./memory-routine.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const HELP = `threebot ${currentVersion()}

Usage: threebot <command> [options]

  up                 Set up Threebot on this machine and start it in the background.
                       --port <n>       Port for the app (default 3780)
                       --t3-url <url>   T3 Code server (default http://127.0.0.1:3773)
                       --no-service     Write the settings only; start it yourself with \`threebot serve\`
                       --tailscale      Also reach it from your devices over Tailscale
  serve              Run the gateway in this terminal.
  status [--json]    Show the version, the service, T3 Code and remote access.
  update [version]   Install the newest release (or <version>) and restart the service.
                       --check          Only say whether there is a newer release
                       --preview        Include preview releases
                       --yes            Don't ask before restarting
  rollback           Go back to the version before the last update.
  service <install|uninstall|restart|status>
  tailscale <on|off|status>   Private link for your tailnet, through Tailscale Serve.
  tunnel <on|off|status>      Public Cloudflare quick-tunnel link. Needs a password.
  bridge <install|uninstall|status>  Configure Antigravity's global MCP bridge.
  memory <reflect|status|disable> <bot>  Create, run or disable the memory reflection routine.
                       --time <HH:MM>    Daily time for a new routine (default 03:30).
                       --run             Trigger it immediately after creating/updating it.
  password           Set the password the app asks for (reads it from the terminal or stdin).
  version            Print the version.

Data, settings and installed versions live in THREEBOT_HOME (default ~/.threebot).
`;

const say = (line = "") => process.stdout.write(line + "\n");
function fail(message: string, code = 1): never { process.stderr.write(`threebot: ${message}\n`); process.exit(code); }

/** `--name value`, `--name=value`, `--name` (true) and `--no-name` (false). */
type Flags = Record<string, string | boolean | undefined>;
function parseArgs(argv: string[]) {
  const flags: Flags = {}, rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--no-")) flags[a.slice(5)] = false;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (["port", "t3-url", "time"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

// ---------- settings ----------

const home = homeDir();
const envFile = path.join(home, ".env");
const tokenFile = path.join(home, "t3-token");

function readEnvFile(file = envFile) {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
/** Set KEY=value lines in THREEBOT_HOME/.env, keeping everything else. */
async function setEnv(values: Record<string, string | number>) {
  let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
    process.env[key] = String(value);
  }
  await fs.writeFile(envFile, text, { mode: 0o600 });
}
const settings = () => ({ ...readEnvFile(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PORT|T3_URL|T3_TOKEN|T3_TOKEN_FILE|HOST)$/.test(k))) });
const portOf = () => Number(settings().PORT || 3780);
const appDirOf = () => path.join(settings().BOTS_ROOT || path.join(home, "bots"), ".botapp");
const accessStore = () => createAccessStore(path.join(appDirOf(), "access.json"));

/** The CLI the service runs: the `current` link when installed, so an update is only a link swap. */
function serviceCli() {
  return installedRuntime() ? path.join(runtimePaths(home).current, "server", "cli.mjs") : path.join(here, "cli.mjs");
}
const spec = () => serviceSpec({ cli: serviceCli(), home });

/** The fields of the gateway's /api/health answer this file reads. */
type Health = { ok?: boolean; version?: string };
async function health(port = portOf(), timeoutMs = 2000): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
async function waitForHealth({ port = portOf(), version, timeoutMs = 60000 }: { port?: number; version?: string; timeoutMs?: number } = {}): Promise<Health | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const h = await health(port);
    if (h?.ok && (!version || h.version === version)) return h;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function findT3() {
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(path.join(dir, "t3"))) return path.join(dir, "t3");
  const own = path.join(homedir(), ".t3", "bin", "t3");
  return existsSync(own) ? own : null;
}

async function ask(question: string, { secret = false }: { secret?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").split("\n")[0];
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // readline's own (untyped) hook for echoing input; replacing it hides what is typed.
  if (secret) (rl as typeof rl & { _writeToOutput: (s: string) => void })._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  if (secret) say();
  return answer;
}
async function confirm(question: string, yes?: string | boolean) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  return /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim());
}

// ---------- commands ----------

async function up(flags: Flags) {
  await fs.mkdir(home, { recursive: true });
  const port = Number(flags.port || settings().PORT || 3780);
  const t3Url = String(flags["t3-url"] || settings().T3_URL || "http://127.0.0.1:3773").replace(/\/$/, "");

  if (!existsSync(envFile)) {
    await fs.writeFile(envFile, `# Threebot settings. See .env.example in the release for every option.
T3_URL=${t3Url}
T3_TOKEN_FILE=${tokenFile}
HOST=127.0.0.1
PORT=${port}
`, { mode: 0o600 });
    say(`Wrote ${envFile}`);
  } else {
    // Options given on this run win over what an earlier `up` saved.
    const changed = { ...(flags.port ? { PORT: port } : {}), ...(flags["t3-url"] ? { T3_URL: t3Url } : {}) };
    if (Object.keys(changed).length) { await setEnv(changed); say(`Updated ${envFile}`); }
  }

  // A T3 token lets the gateway drive T3 Code. Reuse one, or ask the local t3 for a new one.
  const haveToken = process.env.T3_TOKEN || settings().T3_TOKEN || (existsSync(settings().T3_TOKEN_FILE || tokenFile) && readFileSync(settings().T3_TOKEN_FILE || tokenFile, "utf8").trim());
  if (!haveToken) {
    const t3 = findT3();
    if (!t3) fail("T3 Code isn't installed. Install it with `curl -fsSL https://t3.codes/install.sh | sh`, run `t3 up`, then run `threebot up` again.");
    say("Asking T3 Code for a token");
    const token = (await run(t3, ["auth", "session", "issue", "--ttl", "365d", "--label", "threebot", "--token-only"])).trim();
    if (!token) fail("t3 didn't print a token.");
    await fs.writeFile(tokenFile, token + "\n", { mode: 0o600 });
    say(`Saved the T3 token to ${tokenFile} (valid for a year)`);
  }

  try {
    const res = await fetch(`${t3Url}/.well-known/t3/environment`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    say(`Warning: T3 Code doesn't answer at ${t3Url}. Start it (\`t3 up\` or the desktop app) before creating Bots.`);
  }

  if (flags.tailscale) await tailscaleCommand(["on"], { restart: false });

  if (flags.service === false) {
    say("Settings are ready. Start Threebot with `threebot serve`.");
    return;
  }
  if (!serviceSupported()) fail("Background services work on macOS and Linux. Start Threebot with `threebot serve`.");
  const file = await installService(spec());
  say(`Installed the background service (${file})`);
  const h = await waitForHealth({ port, timeoutMs: 45000 });
  if (!h) fail(`The service started but the app doesn't answer on port ${port}. Logs: ${path.join(home, "logs", "gateway.log")}`);
  say(`\nThreebot ${h.version} is running: http://127.0.0.1:${port}`);
  if (process.platform === "linux") say("On a server, run `loginctl enable-linger $USER` so it keeps running after you log out.");
  say("Reach it from your phone: Settings → Remote access, or `threebot tailscale on`.");
}

async function serve() {
  process.env.THREEBOT_HOME ??= home;
  await import("./gateway.mts");
}

async function status(flags: Flags) {
  const h = await health();
  const saved = await accessStore().read();
  const out = {
    version: currentVersion(), home, installed: installedRuntime(),
    service: { supported: serviceSupported(), installed: serviceSupported() && serviceInstalled(spec()) },
    gateway: h ? { running: true, version: h.version, url: `http://127.0.0.1:${portOf()}` } : { running: false },
    t3: { url: settings().T3_URL || "http://127.0.0.1:3773" },
    access: { password: Boolean(saved.password) || Boolean(settings().BOT_PASSWORD), tailscale: Boolean(saved.tailscale?.enabled), tunnel: Boolean(saved.tunnel?.enabled) },
  };
  if (flags.json) return say(JSON.stringify(out, null, 2));
  say(`Threebot ${out.version}${out.installed ? "" : " (source checkout)"}`);
  say(`Data:      ${home}`);
  say(`Service:   ${!out.service.supported ? "not supported here" : out.service.installed ? "installed" : "not installed"}`);
  say(`Gateway:   ${h ? `running ${h.version} at ${out.gateway.url}` : "not running"}`);
  say(`T3 Code:   ${out.t3.url}`);
  say(`Password:  ${out.access.password ? "set" : "none"}`);
  say(`Tailscale: ${out.access.tailscale ? `on${saved.tailscale!.httpsPort ? ` (HTTPS port ${saved.tailscale!.httpsPort})` : ""}` : "off"}`);
  const tunnelUrl = await fs.readFile(path.join(appDirOf(), "tunnel-url"), "utf8").catch(() => "");
  say(`Cloudflare: ${out.access.tunnel ? `on${tunnelUrl ? ` ${tunnelUrl.trim()}` : ""}` : "off"}`);
}

async function update(flags: Flags, rest: string[]) {
  const from = currentVersion();
  // An update (not --check) writes its failures to logs/update.log, the same whoever started it.
  const stop: (message: string) => never = (message) => { if (!flags.check) updateLogger(home, { print: null })(`Update failed: ${message}`); fail(message); };
  const release = await findRelease({ version: rest[0], channel: flags.preview ? "preview" : "stable" }).catch((error) => stop(error instanceof Error ? error.message : String(error)));
  if (!release) stop(rest[0] ? `There is no release ${rest[0]}.` : "There are no releases yet.");
  const newer = compareVersions(release.version, from) > 0;
  if (flags.check) return say(newer ? `Threebot ${release.version} is available (you have ${from}). ${release.url}` : `Threebot ${from} is up to date.`);
  if (!installedRuntime()) fail("This copy runs from a source checkout. Update it with `git pull && npm run setup`, or install a release with the installer.");
  if (!newer && !rest[0]) return say(`Threebot ${from} is up to date.`);
  if (compareVersions(release.version, from) < 0 && !flags["allow-downgrade"]) fail(`${release.version} is older than ${from}. Pass --allow-downgrade to go back anyway.`);

  // From here on every step is also written there.
  const log = updateLogger(home);
  log(`Updating Threebot ${from} → ${release.version}`);
  try {
    const dir = await installRelease(release, { home, log });
    const managed = serviceSupported() && serviceInstalled(spec());
    if (managed && !(await confirm(`Restart Threebot to switch from ${from} to ${release.version}? Running Bot turns keep going in T3 Code.`, flags.yes))) {
      stop("Not restarted. Run `threebot update --yes` to switch.");
    }
    await activate(dir, home);
    log(`Switched to ${release.version}`);
    if (!managed) {
      log(`Installed ${release.version}. Restart Threebot (\`threebot serve\`) to use it.`);
      return;
    }
    await restartService(spec());
    log(`Restarted on ${release.version}; waiting for it to answer`);
    if (await waitForHealth({ version: release.version, timeoutMs: 90000 })) {
      const removed = await prune(home);
      log(`Threebot ${release.version} is running.${removed.length ? ` Removed ${removed.join(", ")}.` : ""}`);
      return;
    }
    // The new version never answered: put the old one back.
    log(`${release.version} didn't answer; rolling back`);
    const back = await rollback(home);
    await restartService(spec());
    const ok = await waitForHealth({ timeoutMs: 60000 });
    stop(`${release.version} didn't start, so Threebot went back to ${path.basename(back)}${ok ? "" : ", which isn't answering either"}. Logs: ${path.join(home, "logs", "gateway.log")}`);
  } catch (error) {
    stop(error instanceof Error ? error.message : String(error));
  }
}

async function rollbackCommand() {
  const back = await rollback(home);
  if (serviceSupported() && serviceInstalled(spec())) await restartService(spec());
  say(`Switched back to ${path.basename(back)}.`);
}

async function serviceCommand([action = "status"]: string[]) {
  const s = spec();
  if (action === "install") return say(`Installed ${await installService(s)}`);
  if (action === "uninstall") { await uninstallService(s); return say("Removed the background service. Your Bots and settings are kept."); }
  if (action === "restart") { await restartService(s); return say("Restarted."); }
  if (action === "status") return say(serviceInstalled(s) ? `Installed (${s.cli})` : "Not installed. Run `threebot up`.");
  fail(`Unknown service action: ${action}`);
}

async function restartIfManaged() {
  if (serviceSupported() && serviceInstalled(spec())) { await restartService(spec()); await waitForHealth({ timeoutMs: 45000 }); return true; }
  say("Restart Threebot for this to take effect.");
  return false;
}

async function tailscaleCommand([action = "status"]: string[], { restart = true }: { restart?: boolean } = {}) {
  const store = accessStore();
  const ts = createTailscale();
  const state = await ts.status();
  const saved = (await store.read()).tailscale;
  if (action === "status") {
    if (!state.installed) return say("Tailscale isn't installed. Get it at https://tailscale.com/download");
    say(`Tailscale: ${state.state}${state.dnsName ? ` as ${state.dnsName}` : ""}`);
    return say(saved?.enabled && state.dnsName ? `Threebot: ${tailnetUrl(state.dnsName, saved.httpsPort)}` : "Threebot: not served. Run `threebot tailscale on`.");
  }
  if (action === "off") {
    // Only remove the route if it still points at Threebot's listener.
    if (saved?.httpsPort && serveOwner(await ts.serveConfig(), saved.httpsPort) === `http://127.0.0.1:${saved.port}`) await ts.unserve(saved.httpsPort).catch(() => {});
    await store.update({ tailscale: { ...saved, enabled: false } });
    say("Tailscale link off.");
    if (restart) await restartIfManaged();
    return;
  }
  if (action !== "on") fail(`Unknown tailscale action: ${action}`);
  if (!state.installed) fail("Install Tailscale first: https://tailscale.com/download");
  if (!state.running) fail(state.authUrl ? `Sign in to Tailscale: ${state.authUrl}` : "Start Tailscale and sign in (`tailscale up`), then try again.");
  if (!state.https) fail("Turn on HTTPS certificates for your tailnet at https://login.tailscale.com/admin/dns, then try again.");
  const port = saved?.port || portOf() + 1;
  const localUrl = `http://127.0.0.1:${port}`;
  const pick = pickServePort(await ts.serveConfig(), localUrl);
  if (!pick) fail("Every HTTPS port Threebot tries is already used by Tailscale Serve.");
  if (!pick.ours) await ts.serve(pick.port, localUrl);
  await store.update({ tailscale: { enabled: true, port, httpsPort: pick.port, users: [state.login!.toLowerCase()] } });
  say(`Threebot on your tailnet: ${tailnetUrl(state.dnsName!, pick.port)} (only ${state.login})`);
  if (restart) await restartIfManaged();
}

async function tunnelCommand([action = "status"]: string[]) {
  const store = accessStore();
  const saved = await store.read();
  if (action === "status") {
    const url = await fs.readFile(path.join(appDirOf(), "tunnel-url"), "utf8").catch(() => "");
    return say(saved.tunnel?.enabled ? `Cloudflare link: ${url.trim() || "starting…"}` : "Cloudflare link: off");
  }
  if (action === "off") { await store.update({ tunnel: { enabled: false } }); say("Cloudflare link off."); return void (await restartIfManaged()); }
  if (action !== "on") fail(`Unknown tunnel action: ${action}`);
  if (!saved.password && !settings().BOT_PASSWORD) fail("A Cloudflare link is public. Set a password first with `threebot password`.");
  if (!findCloudflared(home)) { say("Downloading cloudflared"); await installCloudflared(home); }
  await store.update({ tunnel: { enabled: true } });
  if (await restartIfManaged()) {
    for (let i = 0; i < 45; i++) {
      const url = await fs.readFile(path.join(appDirOf(), "tunnel-url"), "utf8").catch(() => "");
      if (url.trim()) return say(`Cloudflare link: ${url.trim()}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    say("The tunnel is starting; `threebot tunnel status` shows the link.");
  }
}

async function passwordCommand() {
  const first = await ask("New password: ", { secret: true });
  if (first.length < MIN_PASSWORD) fail(`Use at least ${MIN_PASSWORD} characters.`);
  if (process.stdin.isTTY && (await ask("Again: ", { secret: true })) !== first) fail("The passwords don't match.");
  await accessStore().update({ password: await hashPassword(first) });
  // A new session secret signs out every device that signed in before.
  await fs.mkdir(appDirOf(), { recursive: true });
  await fs.writeFile(path.join(appDirOf(), "session-secret"), randomBytes(32).toString("hex"), { mode: 0o600 });
  say("Password set. Every device signs in again with it.");
  await restartIfManaged();
}

async function memoryCommand(args: string[]) {
  const action = args[0] ?? "reflect";
  const slug = args[1];
  if (!slug) fail("Use `threebot memory <reflect|status|disable> <bot>`.");
  if (!["reflect", "status", "disable"].includes(action)) fail(`Unknown memory action: ${action}`);
  const botsRoot = process.env.BOTS_ROOT || path.join(home, "bots");
  const botFile = path.join(botsRoot, slug, ".bot", "bot.json");
  if (!existsSync(botFile)) fail(`Bot not found: ${slug}`);
  const bot = JSON.parse(readFileSync(botFile, "utf8")) as { name?: string; projectId?: string | null; mainThreadId?: string | null; model?: unknown };
  const t3Token = (settings().T3_TOKEN ?? "").trim() || (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
  if (!t3Token) fail("No T3 token: set T3_TOKEN or run `threebot up` first.");
  const client = new T3Client({ baseUrl: settings().T3_URL || "http://127.0.0.1:3773", token: t3Token, clientLabel: "threebot-memory-routine" });
  await client.connect();
  try {
    if (action === "status") {
      const task = await findMemoryRoutine(client, bot as any);
      if (!task) return say(`No memory reflection routine for ${slug}.`);
      return say(`${slug}: ${task.enabled ? "enabled" : "disabled"}, ${task.schedule.type === "fixed_time" ? task.schedule.timeOfDay : task.schedule.type}, next ${task.nextRunAt ?? "not scheduled"}, last ${task.lastRunStatus ?? "never"}.`);
    }
    if (action === "disable") {
      const task = await setMemoryRoutineEnabled(client, bot as any, false);
      return say(`${slug}: memory reflection disabled.`);
    }
    const settingsFile = path.join(appDirOf(), "settings.json");
    const threebotSettings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
    const config = await client.call("server.getConfig", {});
    const modelSelection = threebotSettings.memoryReflectionModel ?? bot.model ?? config?.settings?.defaultModelSelection;
    if (!modelSelection) fail("Pick a model in Settings → Memory reflection model, or set a default model in T3.");
    const schedule = typeof flags.time === "string" ? { type: "fixed_time" as const, timeOfDay: String(flags.time) } : defaultMemorySchedule();
    const result = await ensureMemoryRoutine({ client, bot: bot as any, modelSelection, schedule, enabled: true });
    say(`${slug}: memory reflection ${result.created ? "created" : "updated"} (${result.task.enabled ? "enabled" : "disabled"}), next ${result.task.nextRunAt ?? "pending"}.`);
    if (flags.run) {
      const task = await runMemoryRoutine(client, bot as any);
      say(`${slug}: reflection triggered (${task.id}). Check the Bot transcript for the tool pass.`);
    }
  } finally {
    client.close();
  }
}

async function bridgeCommand(args: string[]) {
  const action = args[0] ?? "status";
  if (!["install", "uninstall", "status"].includes(action)) fail(`Unknown bridge action: ${action}`);
  const bridgePath = path.join(here, "threebot-mcp-bridge.mts");
  if (action !== "status" && !existsSync(bridgePath)) fail(`The bridge is missing: ${bridgePath}`);
  const options = { bridgePath };
  const result = action === "install" ? await installAntigravityBridge(options)
    : action === "uninstall" ? await uninstallAntigravityBridge(options)
      : { changed: false, status: await antigravityBridgeStatus(options), backup: null };
  if (flags.json) return say(JSON.stringify({ action, ...result }, null, 2));
  const { status } = result;
  say(`Antigravity config: ${status.configPath}`);
  say(`Bridge: ${status.bridgePath}`);
  say(`Status: ${status.installed ? "installed" : "not installed"}${status.bridgeExists ? "" : " (bridge file missing)"}`);
  if (status.otherServers.length) say(`Other MCP servers kept: ${status.otherServers.join(", ")}`);
  if (result.backup) say(`Backup: ${result.backup}`);
  if (action === "install" && result.changed) say("Restart Antigravity or start a new T3 thread to load it.");
}

// Every command reads THREEBOT_HOME/.env, without overriding the real environment.
for (const [k, v] of Object.entries(readEnvFile())) if (process.env[k] === undefined) process.env[k] = v;
const { flags, rest } = parseArgs(process.argv.slice(2));
const [command, ...args] = rest;
try {
  if (flags.version || command === "version") say(currentVersion());
  else if (!command || flags.help || command === "help") say(HELP);
  else if (command === "up") await up(flags);
  else if (command === "serve") await serve();
  else if (command === "status") await status(flags);
  else if (command === "update") await update(flags, args);
  else if (command === "rollback") await rollbackCommand();
  else if (command === "service") await serviceCommand(args);
  else if (command === "tailscale") await tailscaleCommand(args);
  else if (command === "tunnel") await tunnelCommand(args);
  else if (command === "bridge") await bridgeCommand(args);
  else if (command === "memory") await memoryCommand(args);
  else if (command === "password") await passwordCommand();
  else fail(`Unknown command: ${command}. Run \`threebot help\`.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
