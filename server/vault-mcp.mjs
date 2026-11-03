// The Bots' own MCP server ("bot"), served by the gateway at POST /mcp/bot (Streamable HTTP,
// plain JSON responses). Its tools let a Bot use the Vault without ever seeing a password:
// the gateway types the password into the Bot's browser tab itself. New secrets come in through
// T3's own secure card (request_secret, delivery "file"), so asking works in every T3 client;
// vault_save_login then moves the value from T3's file into the Vault.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CONTACT_FIELDS, repeatedValues, matchesSite, siteDomain } from "./vault.mjs";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SECRET_FILE_TTL_MS = 60 * 60 * 1000;
const MAX_SECRET_BYTES = 16 * 1024;

const threadIdProp = { type: "string", description: "Your main conversation's T3 thread id (in AGENTS.md, or mainThreadId in .bot/bot.json)." };

export const TOOLS = [
  {
    name: "vault_list",
    title: "List Vault items",
    description:
      "List the user's saved logins (id, title, website, username, hints; never passwords) and contact info (name, email, phone, address). Check this first whenever a site needs signing in or a form needs the user's details.",
    inputSchema: { type: "object", properties: { type: { type: "string", enum: ["login", "contact"], description: "Only this kind of item." }, search: { type: "string", description: "Filter by site, title, username or name." } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vault_fill_password",
    title: "Fill a Vault password",
    description:
      "Type a saved login's password into the focused field of your browser tab. First open the site's sign-in page and click into the password field with your browser tools. Only works when the tab is on the login's website or one of its subdomains. Returns only whether it was filled; you never see the password. Take a fresh snapshot afterwards.",
    inputSchema: {
      type: "object",
      properties: { loginId: { type: "string", description: "The login's id from vault_list." }, threadId: threadIdProp, tabId: { type: "string", description: "Your browser tab id, if you have more than one open." } },
      required: ["loginId", "threadId"],
    },
  },
  {
    name: "vault_fill_username",
    title: "Fill a Vault username",
    description: "Type a saved login's username into the focused field of your browser tab (same rules as vault_fill_password). You can also type the username yourself; vault_list shows it.",
    inputSchema: {
      type: "object",
      properties: { loginId: { type: "string" }, threadId: threadIdProp, tabId: { type: "string" } },
      required: ["loginId", "threadId"],
    },
  },
  {
    name: "vault_save_login",
    title: "Save a login to the Vault",
    description:
      "Save a password, API token or key the user gave you to the Vault, so every Bot can use it later. First ask for the secret with T3's request_secret tool, delivery \"file\" (it shows the user a secure card); then pass the file it returns here, without reading it. The file is moved into the Vault and deleted. A login with the same site and username is updated. Returns {saved:true, loginId}.",
    inputSchema: {
      type: "object",
      properties: {
        website: { type: "string", description: "The site or service address, e.g. https://github.com" },
        secretFile: { type: "string", description: "The file request_secret returned." },
        username: { type: "string", description: "The username or email, if the site has one (ask in chat; it isn't secret)." },
        title: { type: "string", description: "A short name, e.g. \"Home Assistant token\". Defaults to the site." },
        hints: { type: "string", description: "When to use it, e.g. \"Long-lived access token for the REST API\"." },
        apiToken: { type: "boolean", description: "true for an API token or key you need to read to call an API (vault_secret_file). Leave false for website passwords: those are only ever filled into pages." },
        threadId: threadIdProp,
      },
      required: ["website", "secretFile", "threadId"],
    },
  },
  {
    name: "vault_secret_file",
    title: "Use a Vault API token",
    description:
      "Write a saved API token or key (a login saved with apiToken) to a private file for an API call, e.g. TOKEN=\"$(cat <file>)\" curl -H \"Authorization: Bearer $TOKEN\" …. Never print it. The file is deleted after an hour; call again whenever you need it. Website passwords can't be read; fill them with vault_fill_password.",
    inputSchema: {
      type: "object",
      properties: { loginId: { type: "string", description: "The login's id from vault_list." }, threadId: threadIdProp },
      required: ["loginId", "threadId"],
    },
  },
  {
    name: "vault_save_contact",
    title: "Save contact info to the Vault",
    description: "Save the user's contact info (name, email, phone, address) to the Vault after they give it to you in chat, so every Bot can use it for forms. Check vault_list first so you don't save a duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "e.g. \"Home\" or \"Work\"" },
        name: { type: "string" },
        email: { type: "string" },
        emails: { type: "array", maxItems: 20, items: { type: "string" }, description: "Saved email addresses, primary first." },
        phone: { type: "string" },
        phones: { type: "array", maxItems: 20, items: { type: "string" }, description: "Saved phone numbers, primary first." },
        street: { type: "string" },
        apt: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zip: { type: "string" },
        country: { type: "string" },
        kind: { type: "string", enum: ["home", "work", "other"] },
        hints: { type: "string", description: "When to use it." },
        threadId: threadIdProp,
      },
      required: ["threadId"],
    },
  },
];

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function toolJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * @param deps.vault          the store from createVault
 * @param deps.findBotByThread (threadId) => Promise<bot|null>
 * @param deps.listTabs       (threadId) => Promise<[{tabId, url, title}]> (server-browser tabs)
 * @param deps.typeIntoTab    ({threadId, tabId, text}) => Promise<void>
 * @param deps.secretsDir     where T3's request_secret (delivery "file") writes values; vault_save_login only reads from here
 * @param deps.tokenDir       private directory for vault_secret_file's files, emptied on start
 * @param deps.log            (line) => void, never given secrets
 */
/**
 * `extra` adds more tools to the same server (the Projects board): { tools, call(name, args, { botFor }) }.
 */
export function createBotTools({ vault, findBotByThread, listTabs, typeIntoTab, secretsDir, tokenDir, log = () => {}, secretFileTtlMs = SECRET_FILE_TTL_MS, extra = null }) {
  // Files from an earlier run have no timer left to delete them.
  const ready = tokenDir ? fs.rm(tokenDir, { recursive: true, force: true }).then(() => fs.mkdir(tokenDir, { recursive: true, mode: 0o700 })).catch(() => {}) : Promise.resolve();

  /** The value of a file T3 wrote for request_secret; anything outside secretsDir is refused. */
  async function readT3Secret(file) {
    if (!secretsDir) throw new Error("Saving secrets isn't set up on this server.");
    let real, root;
    try {
      [real, root] = await Promise.all([fs.realpath(String(file ?? "")), fs.realpath(secretsDir)]);
    } catch {
      throw new Error("That secret file doesn't exist. It may have expired (T3 deletes them after 24 hours); ask the user again with request_secret, delivery \"file\".");
    }
    if (path.dirname(real) !== root) throw new Error("secretFile must be the file request_secret returned.");
    const st = await fs.stat(real);
    if (!st.isFile() || st.size > MAX_SECRET_BYTES) throw new Error("That isn't a secret file from request_secret.");
    const value = (await fs.readFile(real, "utf8")).replace(/\r?\n$/, "");
    if (!value) throw new Error("That secret file is empty.");
    return { value, path: real };
  }

  async function botFor(threadId) {
    if (typeof threadId !== "string" || !threadId) throw new Error("threadId is required: pass your main thread id from AGENTS.md.");
    const bot = await findBotByThread(threadId);
    if (!bot) throw new Error("That threadId isn't a Bot's main conversation. Pass your main thread id from AGENTS.md (or mainThreadId in .bot/bot.json).");
    return bot;
  }

  async function fill(args, field) {
    const bot = await botFor(args.threadId);
    const login = typeof args.loginId === "string" ? await vault.get(args.loginId, { reveal: true }) : null;
    if (!login || login.type !== "login") return toolError("No login with that id. Check vault_list.");
    const value = field === "password" ? login.password : login.username;
    if (!value) return toolError(`That login has no saved ${field}.`);
    const websites = repeatedValues(login, "website");
    const domain = websites.map(siteDomain).filter(Boolean).join(", ");
    if (!domain) return toolError("That login has no website saved, so it can't be filled anywhere. Ask the user to add the website in Settings › Vault.");

    const tabs = await listTabs(args.threadId);
    let tab;
    if (args.tabId) {
      tab = tabs.find((t) => t.tabId === args.tabId);
      if (!tab) return toolError("That tab isn't open in your browser. Open the sign-in page with your browser tools first.");
    } else if (tabs.length === 1) {
      tab = tabs[0];
    } else if (tabs.length === 0) {
      return toolError("You have no browser tab open. Open the site's sign-in page with your browser tools first.");
    } else {
      const onSite = tabs.filter((t) => websites.some(site => matchesSite(t.url, site)));
      if (onSite.length !== 1) return toolError(`You have several tabs open; pass tabId. Tabs: ${tabs.map((t) => `${t.tabId} (${hostOf(t.url)})`).join(", ")}`);
      tab = onSite[0];
    }
    if (!websites.some(site => matchesSite(tab.url, site))) {
      log(`vault: refused ${field} fill for login ${login.id} on ${hostOf(tab.url)} (saved for ${domain}), bot ${bot.slug}`);
      return toolError(
        `Refused: your tab is on ${hostOf(tab.url) || "an unknown page"}, but this login is saved for ${domain} (and its subdomains). ` +
          `A lookalike site could take the password. If this really is the same service, ask the user (question tool) to confirm and add this site to the login in Settings › Vault, or to sign in themselves with Take over.`,
      );
    }
    await typeIntoTab({ threadId: args.threadId, tabId: tab.tabId, text: value });
    log(`vault: filled ${field} for login ${login.id} on ${hostOf(tab.url)}, bot ${bot.slug}`);
    return toolJson({ filled: true, field, site: siteDomain(websites.find(site => matchesSite(tab.url, site))), tabId: tab.tabId });
  }

  async function callTool(name, args = {}) {
    try {
      switch (name) {
        case "vault_list": {
          const all = await vault.list();
          const q = String(args.search ?? "").trim().toLowerCase();
          const items = all
            .filter((i) => !args.type || i.type === args.type)
            .filter((i) => !q || JSON.stringify(i).toLowerCase().includes(q))
            .map((i) =>
              i.type === "login"
                ? { id: i.id, type: "login", title: i.title, website: i.website, websites: repeatedValues(i, "website"), fillsOn: repeatedValues(i, "website").map(siteDomain).filter(Boolean).map(domain => `${domain} and its subdomains`).join(", ") || null, username: i.username ?? "", hasPassword: i.hasPassword, apiToken: i.botCanRead === true, hints: i.hints ?? "" }
                : (({ createdAt: _c, updatedAt: _u, ...c }) => c)(i),
            );
          return toolJson({ items, note: items.length ? "Passwords are never shown. Fill them with vault_fill_password; read API tokens with vault_secret_file." : "Nothing saved. Ask the user with request_secret (delivery \"file\"), then vault_save_login." });
        }
        case "vault_fill_password":
          return await fill(args, "password");
        case "vault_fill_username":
          return await fill(args, "username");
        case "vault_save_login": {
          const bot = await botFor(args.threadId);
          const website = String(args.website ?? "").trim();
          if (!siteDomain(website)) return toolError("website must be a site address like https://example.com");
          const secret = await readT3Secret(args.secretFile);
          const input = { website, username: String(args.username ?? "").trim(), password: secret.value, botCanRead: args.apiToken === true };
          if (args.title) input.title = String(args.title);
          if (args.hints) input.hints = String(args.hints);
          const { item, updated } = await vault.saveLogin(input);
          await fs.rm(secret.path, { force: true }).catch(() => {});
          log(`vault: ${updated ? "updated" : "saved"} login ${item.id} for ${item.domain}${item.botCanRead ? " (api token)" : ""}, bot ${bot.slug}`);
          return toolJson({ saved: true, updated, loginId: item.id, site: item.domain, title: item.title, apiToken: item.botCanRead === true });
        }
        case "vault_secret_file": {
          const bot = await botFor(args.threadId);
          const login = typeof args.loginId === "string" ? await vault.get(args.loginId, { reveal: true }) : null;
          if (!login || login.type !== "login") return toolError("No login with that id. Check vault_list.");
          if (login.botCanRead !== true) return toolError("That's a website password, which Bots never read. Fill it into the sign-in page with vault_fill_password. If it's really an API token, ask the user to turn on \"Bots can read this\" for it in Settings › Vault.");
          if (!login.password) return toolError("That login has no saved token.");
          if (!tokenDir) return toolError("Reading tokens isn't set up on this server.");
          await ready;
          const file = path.join(tokenDir, randomBytes(16).toString("hex"));
          await fs.writeFile(file, login.password, { mode: 0o600, flag: "wx" });
          setTimeout(() => fs.rm(file, { force: true }).catch(() => {}), secretFileTtlMs).unref?.();
          log(`vault: wrote token file for login ${login.id}, bot ${bot.slug}`);
          return toolJson({ file, site: siteDomain(login.website), expiresInMinutes: Math.round(secretFileTtlMs / 60000) });
        }
        case "vault_save_contact": {
          const bot = await botFor(args.threadId);
          const fields = Object.fromEntries(CONTACT_FIELDS.filter((f) => f !== "title" && ((typeof args[f] === "string" && args[f].trim()) || ((f === "emails" || f === "phones") && f in args))).map((f) => [f, args[f]]));
          if (!fields.name && !fields.email && !fields.phone && !fields.emails?.length && !fields.phones?.length && !fields.street) return toolError("Give at least a name, email, phone or street.");
          const item = await vault.create({ ...fields, type: "contact" });
          log(`vault: saved contact ${item.id}, bot ${bot.slug}`);
          return toolJson({ saved: true, contactId: item.id, title: item.title });
        }
        default:
          return toolError(`Unknown tool ${name}`);
      }
    } catch (e) {
      // Errors from here never contain secrets: vault errors are generic and fill errors are ours.
      return toolError(String(e?.message ?? e));
    }
  }

  /** One JSON-RPC message → response object, or null for notifications. */
  async function handleRpc(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    }
    const isNotification = !("id" in msg);
    const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "bot", title: "Bot", version: "0.1.0" },
          instructions: "The user's Vault: saved logins, API tokens and contact info. You never see website passwords; fill them into your browser tab with vault_fill_password. To save a new one, ask with T3's request_secret (delivery \"file\"), then vault_save_login." + (extra?.instructions ? ` ${extra.instructions}` : ""),
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: [...TOOLS, ...(extra?.tools ?? [])] });
      case "tools/call": {
        const name = msg.params?.name;
        if (extra?.tools.some((t) => t.name === name)) return reply(await extra.call(name, msg.params?.arguments ?? {}, { botFor }));
        if (!TOOLS.some((t) => t.name === name)) return isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        return reply(await callTool(name, msg.params?.arguments ?? {}));
      }
      default:
        if (isNotification || msg.method.startsWith("notifications/")) return null;
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  }

  return { callTool, handleRpc };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Constant-time bearer check. */
export function bearerMatches(header, expected) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header ?? ""));
  if (!m || !expected) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * HTTP handler for /mcp/bot. Only local processes with the bearer may call it; requests that came
 * through the Cloudflare tunnel (which also arrive from 127.0.0.1) carry forwarding headers and are refused.
 */
export async function handleMcpHttp(req, res, { tools, token, readBody }) {
  const sendJson = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const viaTunnel = req.headers["cf-ray"] || req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["cf-access-jwt-assertion"];
  const remote = req.socket.remoteAddress ?? "";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (viaTunnel || !local) return sendJson(403, { error: "The Bot tool server only accepts local requests." });
  if (!bearerMatches(req.headers.authorization, token)) return sendJson(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  if (req.method !== "POST") return sendJson(405, { error: "Method not allowed" }, { allow: "POST" });

  let body;
  try {
    body = await readBody(req, 1 << 20);
  } catch {
    return sendJson(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const batch = Array.isArray(body);
  const responses = (await Promise.all((batch ? body : [body]).map((m) => tools.handleRpc(m)))).filter(Boolean);
  if (responses.length === 0) return sendJson(202, undefined);
  if (res.destroyed) return;
  return sendJson(200, batch ? responses : responses[0]);
}
