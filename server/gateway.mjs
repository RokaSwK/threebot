// Bot gateway: serves the web app, guards it with a password, proxies T3 Code,
// and reads/writes the small JSON files that describe Bots. No database.
import http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { renderAgentsMd, mergeManaged } from "./bot-template.mjs";
import { startProvisioner } from "./provisioner.mjs";
import { archivedBotIdentities } from "./bot-identities.mjs";
import { createMainBotRegistry } from "./main-bot.mjs";
import { createEnvironmentRouter, environmentPath } from "./environment-routes.mjs";
import { createThreadLinkResolver } from "./thread-link.mjs";
import { accessTokenFrom, createAccessVerifier } from "./access.mjs";
import { createVault } from "./vault.mjs";
import { createBotTools, handleMcpHttp } from "./vault-mcp.mjs";
import { T3Client } from "./t3rpc.mjs";
import { executorConfiguration, executorMcpDefinition, publicExecutorConfiguration } from "./executor-config.mjs";
import { createExecutorClient } from "./executor-client.mjs";
import { createThreadMeta, createThreadPreviews } from "./thread-meta.mjs";
import { createRoutineHistoryRoutes } from "./routine-history.mjs";
import { AVATAR_BODY_LIMIT, avatarImagePatch, decodeAvatarImage, storeAvatarImage, readAvatarImage } from "./avatar-images.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const resolveThreadLink = createThreadLinkResolver();
const dataRoot = process.env.THREEBOT_HOME ?? path.join(homedir(), ".threebot");
const cfg = {
  port: Number(process.env.PORT ?? 3780),
  host: process.env.HOST ?? "127.0.0.1",
  t3Url: (process.env.T3_URL ?? "http://127.0.0.1:3773").replace(/\/$/, ""),
  botsRoot: process.env.BOTS_ROOT ?? path.join(dataRoot, "bots"),
  staticDir: process.env.STATIC_DIR ?? path.join(here, "..", "web", "dist"),
  password: process.env.BOT_PASSWORD ?? "",
  vaultFile: process.env.VAULT_FILE ?? path.join(dataRoot, "vault.enc"),
  vaultKeyFile: process.env.VAULT_KEY_FILE ?? path.join(dataRoot, ".vault-key"),
  // Where T3's request_secret (delivery "file") leaves values; vault_save_login moves them into the Vault.
  t3SecretsDir: process.env.T3_SECRETS_DIR ?? path.join(homedir(), ".t3", "userdata", "secrets", "files"),
};
const executorConfig = executorConfiguration();
// Bots reach their own tool server (the Vault) here, from this machine only.
cfg.botMcpUrl = (process.env.BOT_MCP_URL ?? `http://127.0.0.1:${cfg.port}/mcp/bot`).replace(/\/$/, "");
const token = (process.env.T3_TOKEN ?? readIfExists(process.env.T3_TOKEN_FILE ?? path.join(here, ".t3-token")) ?? "").trim();
if (!token) {
  console.error("No T3 token: set T3_TOKEN or T3_TOKEN_FILE");
  process.exit(1);
}
const resolveEnvironment = createEnvironmentRouter({ local: { baseUrl: cfg.t3Url, token }, file: process.env.T3_ENVIRONMENTS_FILE });
const appDir = path.join(cfg.botsRoot, ".botapp");
await fs.mkdir(appDir, { recursive: true });
const secretPath = path.join(appDir, "session-secret");
if (!existsSync(secretPath)) await fs.writeFile(secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
const sessionSecret = readFileSync(secretPath, "utf8").trim();
// Bearer for the Bots' tool server: BOT_MCP_TOKEN, or a random one kept next to the vault key.
const botMcpTokenPath = path.join(path.dirname(cfg.vaultKeyFile), ".bot-mcp-token");
let botMcpToken = (process.env.BOT_MCP_TOKEN ?? readIfExists(botMcpTokenPath) ?? "").trim();
if (!botMcpToken) {
  botMcpToken = randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(botMcpTokenPath), { recursive: true });
  await fs.writeFile(botMcpTokenPath, botMcpToken + "\n", { mode: 0o600 });
}
const vault = createVault({ file: cfg.vaultFile, keyFile: cfg.vaultKeyFile });
const routineHistoryRoutes = createRoutineHistoryRoutes({ rpc: t3rpc, file: path.join(appDir, "routine-history.json") });
const threadMeta = createThreadMeta({ file: path.join(appDir, "thread-meta.json") });
const threadPreviews = createThreadPreviews({
  projection: async (threadId) => withTimeout((await withTimeout(t3rpc(), 10000, "T3 timed out")).call("orchestration.getThreadProjection", { threadId }), 15000, "T3 timed out"),
  nameFor: async () => {
    const names = new Map((await listBots()).map((bot) => [bot.mainThreadId, bot.name]));
    return (threadId) => names.get(threadId) ?? null;
  },
});

function readIfExists(p) {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

// ---------- auth ----------
const COOKIE = "bot_session";
function sign(value) {
  return createHmac("sha256", sessionSecret).update(value).digest("hex");
}
function makeSession() {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const v = `v1.${exp}`;
  return `${v}.${sign(v)}`;
}
function validSession(raw) {
  if (!raw) return false;
  const i = raw.lastIndexOf(".");
  const v = raw.slice(0, i), sig = raw.slice(i + 1);
  const expected = sign(v);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(v.split(".")[1]) > Date.now();
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}
// Login attempts per client: 5 failures lock that client out for 15 minutes.
const attempts = new Map();
function clientIp(req) {
  // The last hop is the one our proxy (Tailscale Funnel) added; earlier entries come from the client.
  return String(req.headers["x-forwarded-for"] ?? "").split(",").pop().trim() || req.socket.remoteAddress || "?";
}
function loginBlocked(ip) {
  const a = attempts.get(ip);
  return Boolean(a && a.count >= 5 && Date.now() - a.last < 15 * 60 * 1000);
}
function loginFailed(ip) {
  const a = attempts.get(ip);
  const fresh = !a || Date.now() - a.last > 15 * 60 * 1000;
  attempts.set(ip, { count: fresh ? 1 : a.count + 1, last: Date.now() });
}
function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

// Requests that came through Cloudflare Access with a valid token for an allowed email skip the password.
const verifyAccess = createAccessVerifier({
  teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
  aud: process.env.CF_ACCESS_AUD,
  emails: (process.env.CF_ACCESS_EMAILS ?? "").split(","),
});

async function authed(req) {
  const jar = cookies(req);
  if (verifyAccess) {
    const accessToken = accessTokenFrom(req, jar);
    if (accessToken && (await verifyAccess(accessToken))) return true;
  }
  if (cfg.password) return validSession(jar[COOKIE]);
  // No password: Cloudflare Access is the only way in. Without Access configured either, it's an open dev setup.
  return !verifyAccess;
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, { "content-type": isJson ? "application/json" : "text/plain", "x-content-type-options": "nosniff", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // JSON.parse errors quote the input, which may hold a password.
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}
/** Vault writes only accept JSON, so a cross-site form can't post to them. */
function requireJson(req) {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw Object.assign(new Error("content-type must be application/json"), { status: 415 });
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
function slugify(name) {
  return name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 48) || "bot";
}
async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; }
}
async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await fs.rename(tmp, p);
}

// ---------- bots & settings ----------
const DEFAULT_SETTINGS = {
  userName: "",
  theme: "dark",
  palette: "amoled",
  accent: "bot",
  timezone: "",
  autoReview: true,
  rules: { alwaysAsk: [], allowWithoutAsking: [] },
  sections: [],
  defaultModel: null,
};
const settingsPath = path.join(appDir, "settings.json");
async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await readJson(settingsPath, {})) };
}
function botDir(slug) {
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error("bad slug"), { status: 400 });
  return path.join(cfg.botsRoot, slug);
}
const mainBots = createMainBotRegistry({
  botsRoot: cfg.botsRoot,
  onBotChanged: async (bot) => {
    await writeAgentsMd(bot, await getSettings()).catch((error) => console.error("refreshing Bot instructions failed", error));
  },
});
const getBot = (slug) => mainBots.get(slug);
const listBots = () => mainBots.list();
const saveBot = async (slug, patch) => {
  const bot = await getBot(slug);
  if (!bot) throw Object.assign(new Error("Bot not found"), { status: 404 });
  return mainBots.save(slug, await avatarImagePatch(bot, patch));
};
// Codex only reads a project's .codex/config.toml when the project is trusted in its global config.
const codexGlobalConfig = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "config.toml");
async function trustInCodex(dir) {
  const existing = await fs.readFile(codexGlobalConfig, "utf8").catch(() => "");
  const header = `[projects.${JSON.stringify(dir)}]`;
  if (existing.includes(header)) return;
  const prefix = existing ? (existing.endsWith("\n") ? existing : existing + "\n") + "\n" : "# Bot folders are trusted so Codex loads each Bot's own .codex/config.toml (Executor MCP).\n";
  await fs.mkdir(path.dirname(codexGlobalConfig), { recursive: true });
  await fs.writeFile(codexGlobalConfig, `${prefix}${header}\ntrust_level = "trusted"\n`, { mode: 0o600 });
}

async function writeMcpConfig(dir) {
  // Every Bot gets its own tool server (the Vault); Executor when it's configured.
  const servers = { bot: { type: 'http', url: cfg.botMcpUrl, headers: { Authorization: `Bearer ${botMcpToken}` } } };
  try { const definition = executorMcpDefinition(executorConfig.profile); if (definition) servers.executor = definition; }
  catch { console.error('Executor credential unavailable; managed Executor MCP is disabled.'); }
  const mcpPath = path.join(dir, ".mcp.json");
  const mcp = (await readJson(mcpPath, {})) ?? {};
  mcp.mcpServers = { ...(mcp.mcpServers ?? {}) };
  delete mcp.mcpServers.executor;
  for (const [name, definition] of Object.entries(servers)) mcp.mcpServers[name] = definition;
  await writeJson(mcpPath, mcp);
  await fs.chmod(mcpPath, 0o600).catch(() => {});
  const codexConfig = path.join(dir, ".codex", "config.toml");
  await fs.mkdir(path.dirname(codexConfig), { recursive: true });
  let toml = "# Written by the Bot gateway. bot = the Vault and other Bot tools; executor = connected apps.\n";
  for (const [name, s] of Object.entries(servers)) {
    const headers = Object.entries(s.headers).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ');
    toml += `[mcp_servers.${name}]\nurl = ${JSON.stringify(s.url)}\nhttp_headers = { ${headers} }\n`;
  }
  await fs.writeFile(codexConfig, toml, { mode: 0o600 });
  await fs.chmod(codexConfig, 0o600).catch(() => {});
  await trustInCodex(dir);
  const claudeSettings = path.join(dir, ".claude", "settings.json");
  const cs = (await readJson(claudeSettings, {})) ?? {};
  cs.enableAllProjectMcpServers = true;
  await writeJson(claudeSettings, cs);
  return Boolean(servers.executor);
}

async function writeAgentsMd(bot, settings) {
  const dir = botDir(bot.slug);
  const executorReady = await writeMcpConfig(dir);
  const file = path.join(dir, "AGENTS.md");
  const existing = await fs.readFile(file, "utf8").catch(() => "");
  const executor = executorReady ? { kind: executorConfig.profile.kind, publicUrl: executorConfig.profile.publicUrl,
    organization: executorConfig.profile.organization, skippedApps: executorConfig.profile.skippedApps ?? [] } : null;
  await fs.writeFile(file, mergeManaged(existing, renderAgentsMd({ bot, settings, botsRoot: cfg.botsRoot, executor })));
  const claude = path.join(dir, "CLAUDE.md");
  if (!existsSync(claude)) await fs.symlink("AGENTS.md", claude).catch(() => {});
}
async function createBot(input) {
  const picture = input.avatarImage == null ? null : await decodeAvatarImage(input.avatarImage);
  const base = slugify(input.name ?? "bot");
  let slug = base, n = 2;
  while (existsSync(path.join(cfg.botsRoot, slug))) slug = `${base}-${n++}`;
  const dir = botDir(slug);
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  await fs.mkdir(path.join(dir, "library"), { recursive: true });
  const mem = path.join(dir, "memory", "MEMORY.md");
  if (!existsSync(mem)) await fs.writeFile(mem, `# ${input.name} memory\n\n`);
  const log = path.join(dir, "memory", "log.md");
  if (!existsSync(log)) await fs.writeFile(log, `# Work log\n\n`);
  const shared = path.join(appDir, "shared-memory.md");
  if (!existsSync(shared)) await fs.writeFile(shared, "# Shared facts (all Bots)\n\n");
  const bot = await mainBots.save(slug, {
    name: input.name,
    label: input.label ?? "",
    shape: input.shape ?? "sphere",
    color: input.color ?? "teal",
    ...(picture ? { avatarImage: await storeAvatarImage({ workspaceRoot: dir, slug }, picture) } : {}),
    section: input.section ?? null,
    pinned: Boolean(input.pinned),
    hidden: false,
    primary: Boolean(input.primary),
    notifications: true,
    projectId: null,
    mainThreadId: null,
    model: input.model ?? null,
    createdAt: new Date().toISOString(),
  }, { create: true });
  await provisioner.runNow();
  return (await getBot(slug)) ?? bot;
}
async function refreshAllAgentsMd() {
  await mainBots.refreshInstructions();
}

// ---------- Executor ----------
async function executorStatus() {
  const out = { ...publicExecutorConfiguration(executorConfig), connections: [] };
  if (!out.configured) return out;
  if (!out.hasToken) return { ...out, error: 'Executor needs a server access token.' };
  try { out.connections = await executorClient().apps(); }
  catch (error) { out.error = error.message; }
  return out;
}
function executorClient(backend = executorConfig.active) {
  if (backend !== executorConfig.active) throw Object.assign(new Error('This connection belongs to another Executor backend'), { status: 409 });
  return createExecutorClient(executorConfig.profile);
}

// ---------- Vault ----------
// A T3 RPC connection for looking up the Bots' browser tabs, opened on first use.
let rpcClient = null;
async function t3rpc() {
  if (rpcClient) return rpcClient;
  const c = new T3Client({ baseUrl: cfg.t3Url, token, clientLabel: "bot-gateway-vault" });
  await c.connect();
  c.ws.addEventListener("close", () => {
    if (rpcClient === c) rpcClient = null;
  });
  rpcClient = c;
  return c;
}
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer));
}
async function listServerTabs(threadId) {
  let r;
  try {
    const c = await withTimeout(t3rpc(), 10000, "timeout");
    r = await withTimeout(c.call("preview.list", { threadId }), 10000, "timeout");
  } catch {
    throw new Error("Couldn't reach your browser on T3 right now. Try again in a moment.");
  }
  return (r?.sessions ?? []).filter((s) => s.runtime === "server").map((s) => ({ tabId: s.tabId, url: s.navStatus?.url ?? "", title: s.navStatus?.title ?? "" }));
}

/**
 * Types text into the focused element of a Bot's browser tab through T3's preview stream, like a
 * person using Take control: take control, insert the text, wait until it's applied, release.
 * Errors never include the text.
 */
function typeIntoTab({ threadId, tabId, text }) {
  return new Promise((resolve, reject) => {
    const target = new URL(cfg.t3Url.replace(/^http/, "ws") + "/api/preview-stream/ws");
    for (const [k, v] of Object.entries({ threadId, tabId, interactive: "true", maxWidth: "320", maxHeight: "240", quality: "10" })) target.searchParams.set(k, v);
    const ws = new WebSocket(target, { headers: { authorization: `Bearer ${token}` } });
    let stage = "connecting"; // → taking → typing → releasing
    let settled = false;
    const timers = [];
    const finish = (err) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve();
    };
    timers.push(setTimeout(() => finish(new Error(stage === "typing" ? "The browser didn't confirm the input. Take a fresh snapshot to check the field." : "The browser didn't respond in time.")), 15000));
    const sendJson = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    ws.on("open", () => {
      stage = "taking";
      sendJson({ type: "takeControl" });
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendJson({ type: "ack" }); // frames are paced by acks
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "control") {
        if (msg.canOperate === false) return finish(new Error("The gateway's T3 token can't operate the browser (it needs the preview:operate scope)."));
        if (stage === "taking" && msg.controller === "you") {
          stage = "typing";
          sendJson({ type: "text", text });
          // Viewer input runs in order, so the probe's answer means the text is in.
          timers.push(setTimeout(() => sendJson({ type: "probe", x: 1, y: 1 }), 150));
        } else if (stage === "taking" && msg.controller === "another-viewer") {
          finish(new Error("The user is controlling this tab right now (Take over). Try again when they're done."));
        } else if (stage === "releasing" && msg.controller !== "you") {
          finish();
        }
      } else if (msg.type === "probe" && stage === "typing") {
        stage = "releasing";
        sendJson({ type: "releaseControl" });
        timers.push(setTimeout(() => finish(), 1000));
      }
    });
    ws.on("unexpected-response", (_r, res) => finish(new Error(res.statusCode === 404 ? "That browser tab isn't open." : `The browser stream refused the connection (${res.statusCode}).`)));
    ws.on("error", () => finish(new Error("Couldn't connect to the browser.")));
    ws.on("close", (code) => {
      if (stage === "releasing") return finish();
      finish(new Error(code === 4404 ? "That browser tab was closed." : "The browser closed the connection before the text was typed."));
    });
  });
}

const botTools = createBotTools({
  vault,
  async findBotByThread(threadId) {
    return (await listBots()).find((b) => b.mainThreadId === threadId) ?? null;
  },
  listTabs: listServerTabs,
  typeIntoTab,
  secretsDir: cfg.t3SecretsDir,
  tokenDir: path.join(path.dirname(cfg.vaultKeyFile), "bot-secrets"),
  log: (line) => console.log(line),
});

async function vaultRoutes(req, res, p, url) {
  if (p === "/api/vault" && req.method === "GET") {
    const items = await vault.list();
    return send(res, 200, { items }, { "cache-control": "no-store" });
  }
  if (p === "/api/vault" && req.method === "POST") {
    requireJson(req);
    return send(res, 200, await vault.create(await readBody(req)));
  }
  if (p === "/api/vault/import" && req.method === "POST") {
    requireJson(req);
    const body = await readBody(req, 8 << 20);
    const result = await vault.importItems(body.items);
    console.log(`vault: imported ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`);
    return send(res, 200, result);
  }
  if (p === "/api/vault/export.csv" && req.method === "GET") {
    const type = url.searchParams.get("type") === "contact" ? "contact" : "login";
    console.log(`vault: exported ${type}s as CSV`);
    const name = type === "contact" ? "bot-vault-contacts.csv" : "bot-vault-logins.csv";
    return send(res, 200, await vault.exportCsv(type), { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
  }
  const m = p.match(/^\/api\/vault\/([\w-]+)$/);
  if (m && req.method === "GET") {
    const reveal = url.searchParams.get("reveal") === "1";
    const item = await vault.get(m[1], { reveal });
    if (!item) return send(res, 404, { error: "not found" });
    if (reveal) console.log(`vault: revealed item ${m[1]} in the app`);
    return send(res, 200, item, { "cache-control": "no-store" });
  }
  if (m && req.method === "PUT") {
    requireJson(req);
    return send(res, 200, await vault.update(m[1], await readBody(req)));
  }
  if (m && req.method === "DELETE") return send(res, 200, await vault.remove(m[1]));
  return send(res, 404, { error: "not found" });
}

// ---------- T3 HTTP proxy ----------
async function proxyT3(req, res, t3Path, target = { baseUrl: cfg.t3Url, token }) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.cookie;
  delete headers.connection;
  headers.authorization = `Bearer ${target.token}`;
  delete headers["cf-access-jwt-assertion"];
  const upstream = await fetch(target.baseUrl + t3Path, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    duplex: "half",
    redirect: "manual",
  });
  const out = {};
  upstream.headers.forEach((v, k) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"].includes(k)) out[k] = v;
  });
  res.writeHead(upstream.status, out);
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

// ---------- static ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".webp": "image/webp", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
async function serveStatic(req, res, urlPath) {
  const safe = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  // The public landing page is the one route outside the single-page app.
  let file = path.join(cfg.staticDir, /^\/welcome\/?$/.test(safe) ? "welcome/index.html" : safe);
  if (!file.startsWith(cfg.staticDir)) return send(res, 403, "forbidden");
  let stat = await fs.stat(file).catch(() => null);
  if (!stat || stat.isDirectory()) { file = path.join(cfg.staticDir, "index.html"); stat = await fs.stat(file).catch(() => null); }
  if (!stat) return send(res, 404, "web app not built");
  const ext = path.extname(file);
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": cache });
  res.end(await fs.readFile(file));
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    // Access leaves everything under /welcome public, so the landing page must be
    // the only thing that answers there, even for encoded paths that climb out of it.
    const landingAsset = /^\/welcome\/(img|fonts)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p);
    if (/^\/welcome(\/|\\|%2f|%5c)/i.test(p) && p !== "/welcome/" && !landingAsset) return send(res, 404, "not found");
    // A missing landing file must not fall through to the app shell.
    if (landingAsset && !existsSync(path.join(cfg.staticDir, p))) return send(res, 404, "not found");
    if (p === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (loginBlocked(ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      const { password } = await readBody(req, 4096);
      const ok = !cfg.password || (typeof password === "string" && password.length === cfg.password.length && timingSafeEqual(Buffer.from(password), Buffer.from(cfg.password)));
      if (!ok) {
        loginFailed(ip);
        console.warn(`failed login from ${ip}`);
        return send(res, 401, { error: "wrong password" });
      }
      attempts.delete(ip);
      const secure = isHttps(req) ? "; Secure" : "";
      return send(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}${secure}` });
    }
    // The Bots' own tool server: local callers with its bearer only, never the app's login.
    if (p === "/mcp/bot") return await handleMcpHttp(req, res, { tools: botTools, token: botMcpToken, readBody });

    if (p === "/api/session") return send(res, 200, { authenticated: await authed(req), passwordRequired: Boolean(cfg.password), accessLogin: Boolean(verifyAccess) });
    if (p === "/api/logout") return send(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` });

    if (p.startsWith("/api/") || p.startsWith("/t3/")) {
      if (!(await authed(req))) return send(res, 401, { error: "login required" });
    }
    if (p.startsWith("/t3/")) {
      const route = environmentPath(p);
      return await proxyT3(req, res, route.path + url.search, await resolveEnvironment(route.environmentId));
    }

    if (p === "/api/config") return send(res, 200, { botsRoot: cfg.botsRoot, accessLogout: Boolean(process.env.CF_ACCESS_TEAM_DOMAIN), executorUrl: executorConfig.profile?.credential ? executorConfig.profile.publicUrl : null });
    if (p === "/api/thread-link" && req.method === "GET") {
      const environmentId = url.searchParams.get("environmentId") ?? "";
      const threadId = url.searchParams.get("threadId") ?? "";
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId) || !/^[\w:%.-]{1,1024}$/.test(threadId)) return send(res, 400, { error: "Invalid thread reference" });
      // Configured machines stay inside the app; unconfigured links keep the existing T3 handoff.
      if (process.env.T3_ENVIRONMENTS_FILE) {
        await resolveEnvironment(environmentId);
        res.writeHead(302, { location: `/?environment=${encodeURIComponent(environmentId)}&thread=${encodeURIComponent(threadId)}`, "cache-control": "no-store" });
        return res.end();
      }
      const href = await resolveThreadLink({ environmentId: url.searchParams.get("environmentId") ?? "", threadId: url.searchParams.get("threadId") ?? "" });
      res.writeHead(302, { location: href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return res.end();
    }
    if (p === "/api/executor" && req.method === 'GET') return send(res, 200, await executorStatus());
    if (p === "/api/executor/catalog" && req.method === 'GET') return send(res, 200, await executorClient().catalog(url.searchParams.get('search') ?? ''));
    if (p === "/api/executor/install" && req.method === 'POST') return send(res, 200, await executorClient().install(await readBody(req)));
    if (p === '/api/executor/resolve-link' && req.method === 'POST') return send(res, 200, await executorClient().resolveLink((await readBody(req)).url));
    const executorAppRoute = p.match(/^\/api\/executor\/apps\/([^/]+)(?:\/(accounts|connections))?$/);
    if (executorAppRoute) {
      let id;
      try { id = decodeURIComponent(executorAppRoute[1]); } catch { return send(res, 400, { error: 'Invalid app identifier' }); }
      const client = executorClient();
      if (!executorAppRoute[2] && req.method === 'GET') return send(res, 200, { app: await client.app(id) });
      if (executorAppRoute[2] === 'accounts' && req.method === 'POST') return send(res, 200, await client.link(id, await readBody(req)));
      if (executorAppRoute[2] === 'connections' && req.method === 'POST') return send(res, 200, await client.connect(id, await readBody(req)));
    }
    const executorConnectionRoute = p.match(/^\/api\/executor\/connections\/([^/]+)$/);
    if (executorConnectionRoute && req.method === 'GET') {
      let id;
      try { id = decodeURIComponent(executorConnectionRoute[1]); } catch { return send(res, 400, { error: 'Invalid connection identifier' }); }
      return send(res, 200, await executorClient(url.searchParams.get('backend') ?? executorConfig.active).connection(id));
    }
    if (p === "/api/settings" && req.method === "GET") return send(res, 200, await getSettings());
    if (p === "/api/settings" && req.method === "PUT") {
      const patch = await readBody(req);
      const next = { ...(await getSettings()), ...patch };
      await writeJson(settingsPath, next);
      if ("rules" in patch || "userName" in patch || "timezone" in patch) await refreshAllAgentsMd();
      return send(res, 200, next);
    }
    if (p === "/api/vault" || p.startsWith("/api/vault/")) return await vaultRoutes(req, res, p, url);
    if (p === "/api/main-bot" && req.method === "PUT") {
      requireJson(req);
      const body = await readBody(req);
      return send(res, 200, { bots: await mainBots.select(body?.slug) }, { "cache-control": "no-store" });
    }
    if (p === "/api/thread-previews" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, { previews: await threadPreviews((await readBody(req))?.stamps) }, { "cache-control": "no-store" });
    }
    if (await routineHistoryRoutes.handle(req, res, url)) return;
    if (p === "/api/thread-meta" && req.method === "GET") return send(res, 200, await threadMeta.get(url.searchParams.get("thread")), { "cache-control": "no-store" });
    if (p === "/api/thread-meta/reactions" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await threadMeta.toggleReaction(await readBody(req)));
    }
    if (p === "/api/thread-meta/voice-calls" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await threadMeta.addVoiceCall(await readBody(req)));
    }
    if (p === "/api/bots" && req.method === "GET") return send(res, 200, { bots: await listBots() }, { "cache-control": "no-store" });
    if (p === "/api/bot-identities" && req.method === "GET") return send(res, 200, { bots: await archivedBotIdentities(path.join(appDir, "trash")) }, { "cache-control": "no-store" });
    if (p === "/api/bots" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await createBot(await readBody(req, AVATAR_BODY_LIMIT)));
    }
    const avatar = p.match(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/avatar\/([a-f0-9]{64})\.png$/);
    if (avatar && req.method === "GET") {
      const candidates = [await getBot(avatar[1]), ...await archivedBotIdentities(path.join(appDir, "trash"))].filter(b => b?.slug === avatar[1]);
      for (const bot of candidates) {
        try { return send(res, 200, await readAvatarImage(bot, p), { "content-type": "image/png", "content-security-policy": "default-src 'none'", "cache-control": "private, max-age=31536000, immutable" }); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return send(res, 404, { error: "not found" });
    }
    const m = p.match(/^\/api\/bots\/([^/]+)$/);
    if (m && req.method === "GET") {
      const b = await getBot(m[1]);
      return b ? send(res, 200, b) : send(res, 404, { error: "not found" });
    }
    if (m && req.method === "PUT") {
      requireJson(req);
      return send(res, 200, await saveBot(m[1], await readBody(req, AVATAR_BODY_LIMIT)));
    }
    if (m && req.method === "DELETE") { const bots = await mainBots.remove(m[1]); return send(res, 200, { ok: true, bots }); }
    if (p.startsWith("/api/")) return send(res, 404, { error: "not found" });

    return await serveStatic(req, res, p);
  } catch (err) {
    console.error(req.method, p, err);
    if (!res.headersSent) send(res, err.status ?? 500, { error: String(err.message ?? err) });
    else res.end();
  }
});

// ---------- T3 browser stream (the Bots' computer screen) ----------
function proxyPreviewStream(req, socket, head, url, environment) {
  wss.handleUpgrade(req, socket, head, (client) => {
    const target = new URL(environment.baseUrl.replace(/^http/, "ws") + "/api/preview-stream/ws");
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${environment.token}` } });
    const queue = [];
    upstream.on("open", () => { for (const m of queue.splice(0)) upstream.send(m.data, { binary: m.binary }); });
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queue.push({ data, binary: isBinary });
    });
    upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
    const close = (code, reason) => {
      try { client.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011, String(reason ?? "")); } catch {}
      try { upstream.close(); } catch {}
    };
    upstream.on("close", (code, reason) => close(code, reason));
    upstream.on("unexpected-response", (_r, res) => close(4000 + (res.statusCode % 1000), `upstream ${res.statusCode}`));
    upstream.on("error", () => close(1011, "upstream error"));
    client.on("close", () => { try { upstream.close(); } catch {} });
    client.on("error", () => { try { upstream.close(); } catch {} });
  });
}

// ---------- T3 WebSocket proxy ----------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  let route;
  try { route = environmentPath(url.pathname); } catch { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
  const isPreview = route.path === "/api/preview-stream/ws";
  if ((route.path !== "/ws" && !isPreview) || !(await authed(req).catch(() => false))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  let environment;
  try { environment = await resolveEnvironment(route.environmentId); } catch (error) {
    socket.end(`HTTP/1.1 ${error.status ?? 502} Environment unavailable\r\nConnection: close\r\n\r\n`); return;
  }
  if (isPreview) return proxyPreviewStream(req, socket, head, url, environment);
  wss.handleUpgrade(req, socket, head, (client) => {
    const target = new URL(environment.baseUrl.replace(/^http/, "ws") + "/ws");
    target.searchParams.set("orchestrationProtocol", "2");
    target.searchParams.set("clientSurface", "web");
    target.searchParams.set("clientAppVersion", "bot-0.1.0");
    const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${environment.token}` } });
    const queue = [];
    upstream.on("open", () => { for (const m of queue.splice(0)) upstream.send(m); });
    client.on("message", (data, isBinary) => {
      const msg = isBinary ? data : data.toString();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      else queue.push(msg);
    });
    upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(isBinary ? data : data.toString()));
    const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
    upstream.on("close", closeBoth);
    upstream.on("error", (e) => { console.error("upstream ws error", e.message); closeBoth(); });
    client.on("close", closeBoth);
    client.on("error", closeBoth);
  });
});

const provisioner = startProvisioner({ t3Url: cfg.t3Url, token, listBots, saveBot, getSettings });

// Bot instructions may have changed with this version of the gateway.
refreshAllAgentsMd().catch((e) => console.error("refreshing AGENTS.md failed", e));

server.listen(cfg.port, cfg.host, () => {
  console.log(`bot gateway on http://${cfg.host}:${cfg.port} → T3 ${cfg.t3Url}, bots in ${cfg.botsRoot}`);
});
