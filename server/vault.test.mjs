import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createVault, matchesSite, siteDomain, redact, loadOrCreateKey, encrypt } from "./vault.mjs";
import { createBotTools, handleMcpHttp, TOOLS } from "./vault-mcp.mjs";

const PASSWORD = "hunter2-Sup3r$ecret";

async function tempVault() {
  const dir = await mkdtemp(path.join(tmpdir(), "bot-vault-"));
  const file = path.join(dir, "vault.enc");
  const keyFile = path.join(dir, ".vault-key");
  return { dir, file, keyFile, vault: createVault({ file, keyFile }), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("vault encrypts at rest and round-trips", async () => {
  const t = await tempVault();
  try {
    const login = await t.vault.create({ type: "login", website: "github.com", username: "octo@example.com", password: PASSWORD, hints: "Work account" });
    assert.equal(login.password, undefined, "create returns no password");
    assert.equal(login.hasPassword, true);
    assert.equal(login.website, "https://github.com");
    assert.equal(login.title, "github.com");
    await t.vault.create({ type: "contact", label: "Secondary (Wilmington)", name: "Ada Lovelace", email: "ada@example.com", street: "1 Main St", city: "Wilmington", state: "DE", zip: "19801", country: "US", kind: "home" });

    const raw = await readFile(t.file, "utf8");
    assert.ok(!raw.includes(PASSWORD), "password not in plaintext");
    assert.ok(!raw.includes("octo@example.com"), "username not in plaintext");
    assert.ok(!raw.includes("Lovelace"), "contact not in plaintext");
    const env = JSON.parse(raw);
    assert.equal(env.format, "bot-vault");
    assert.equal(env.version, 1);
    assert.equal(env.cipher, "aes-256-gcm");

    assert.equal((await stat(t.keyFile)).mode & 0o777, 0o600);
    assert.equal((await stat(t.file)).mode & 0o777, 0o600);
    assert.equal((await readFile(t.keyFile)).length, 32);

    // A fresh instance with the same key reads it back.
    const again = createVault({ file: t.file, keyFile: t.keyFile });
    const list = await again.list();
    assert.equal(list.length, 2);
    assert.ok(!JSON.stringify(list).includes(PASSWORD), "list never includes passwords");
    const full = await again.get(login.id, { reveal: true });
    assert.equal(full.password, PASSWORD);
    assert.equal((await again.get(login.id)).password, undefined);

    // Update keeps the password unless it's given.
    await again.update(login.id, { hints: "Personal" });
    assert.equal((await again.get(login.id, { reveal: true })).password, PASSWORD);
    await again.update(login.id, { password: "new-pass" });
    assert.equal((await again.get(login.id, { reveal: true })).password, "new-pass");

    // Export (the "edit as a file" path) has the Chrome header and the password.
    const csv = await again.exportCsv("login");
    assert.match(csv, /^name,url,username,password,note\r\n/);
    assert.ok(csv.includes("new-pass"));
    assert.match(await again.exportCsv("contact"), /^label,name,email,phone,street,apt,city,state,zip,country,kind,note\r\n"?Secondary \(Wilmington\)/);

    await again.remove(login.id);
    assert.equal((await again.list()).length, 1);
  } finally {
    await t.cleanup();
  }
});

test("vault refuses a wrong key or a tampered file without overwriting it", async () => {
  const t = await tempVault();
  try {
    await t.vault.create({ type: "login", website: "example.com", password: PASSWORD });
    const before = await readFile(t.file, "utf8");

    const otherKey = path.join(t.dir, "other-key");
    await assert.rejects(() => createVault({ file: t.file, keyFile: otherKey }).list(), /key file is missing/);
    await writeFile(otherKey, Buffer.alloc(32, 7));
    const wrong = createVault({ file: t.file, keyFile: otherKey });
    await assert.rejects(() => wrong.list(), (e) => /decrypt/.test(e.message) && !e.message.includes(PASSWORD));
    await assert.rejects(() => wrong.create({ type: "login", website: "x.com" }));
    assert.equal(await readFile(t.file, "utf8"), before, "file untouched");

    const env = JSON.parse(before);
    const data = Buffer.from(env.data, "base64");
    data[0] ^= 1;
    await writeFile(t.file, JSON.stringify({ ...env, data: data.toString("base64") }));
    await assert.rejects(() => createVault({ file: t.file, keyFile: t.keyFile }).list(), /decrypt/);
  } finally {
    await t.cleanup();
  }
});

test("import merges by domain and username", async () => {
  const t = await tempVault();
  try {
    await t.vault.create({ type: "login", website: "https://github.com", username: "octo", password: "old" });
    const r = await t.vault.importItems([
      { website: "https://www.github.com/login", username: "octo", password: "new" },
      { website: "https://github.com", username: "octo", password: "new" },
      { website: "https://gitlab.com", username: "octo", password: "x" },
      { type: "contact", name: "Ada", email: "ada@example.com" },
      { title: "" },
    ]);
    assert.deepEqual(r, { added: 2, updated: 1, skipped: 2 });
  } finally {
    await t.cleanup();
  }
});

test("domain matching allows subdomains and refuses lookalikes", () => {
  assert.equal(siteDomain("https://www.Google.com/signin"), "google.com");
  assert.equal(siteDomain("google.com"), "google.com");
  const site = "https://google.com";
  assert.ok(matchesSite("https://google.com/", site));
  assert.ok(matchesSite("https://accounts.google.com/v3/signin", site));
  assert.ok(matchesSite("https://www.google.com", site));
  assert.ok(matchesSite("https://a.b.google.com:8443/x", site));
  assert.ok(matchesSite("https://GOOGLE.COM./", site));
  assert.ok(!matchesSite("https://google.com.evil.io/", site));
  assert.ok(!matchesSite("https://accounts-google.com/", site));
  assert.ok(!matchesSite("https://evilgoogle.com/", site));
  assert.ok(!matchesSite("https://gооgle.com/", site), "Cyrillic homograph (punycode) doesn't match");
  assert.ok(!matchesSite("https://evil.io/?next=https://google.com", site));
  assert.ok(!matchesSite("https://google.com@evil.io/", site));
  assert.ok(!matchesSite("javascript:alert(1)//google.com", site));
  assert.ok(!matchesSite("about:blank", site));
  assert.ok(!matchesSite("http://google.com/", site), "plain http only matches an http:// login");
  assert.ok(matchesSite("http://router.local/", "http://router.local"));
  // A login saved for a subdomain doesn't fill on the parent domain.
  assert.ok(!matchesSite("https://google.com/", "https://accounts.google.com"));
  assert.ok(!matchesSite("https://google.com/", ""));
});

function fakeDeps(t, tabs) {
  const typed = [];
  const tools = createBotTools({
    vault: t.vault,
    findBotByThread: async (id) => (id === "thread-1" ? { slug: "scout", name: "Scout", mainThreadId: "thread-1" } : null),
    listTabs: async () => tabs,
    typeIntoTab: async (x) => typed.push(x),
    secretsDir: path.join(t.dir, "t3-secrets"),
    tokenDir: path.join(t.dir, "bot-secrets"),
  });
  return { tools, typed };
}

const textOf = (result) => result.content.map((c) => c.text).join("\n");

test("MCP tools/list and vault_list never expose passwords", async () => {
  const t = await tempVault();
  try {
    await t.vault.create({ type: "login", website: "github.com", username: "octo", password: PASSWORD, hints: "Use for work" });
    await t.vault.create({ type: "contact", name: "Ada", email: "ada@example.com" });
    const { tools } = fakeDeps(t, []);

    const init = await tools.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.capabilities.tools);
    assert.equal(await tools.handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null);

    const list = await tools.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(list.result.tools.map((x) => x.name).sort(), ["vault_fill_password", "vault_fill_username", "vault_list", "vault_save_contact", "vault_save_login", "vault_secret_file"]);
    for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, "object");

    const res = await tools.handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault_list", arguments: {} } });
    const text = textOf(res.result);
    assert.ok(!text.includes(PASSWORD));
    assert.ok(!/"password"/.test(text));
    const parsed = JSON.parse(text);
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items.find((i) => i.type === "login").username, "octo");
    assert.equal(parsed.items.find((i) => i.type === "contact").email, "ada@example.com");

    const missing = await tools.handleRpc({ jsonrpc: "2.0", id: 4, method: "nope" });
    assert.equal(missing.error.code, -32601);
  } finally {
    await t.cleanup();
  }
});

test("vault_fill_password fills only on the saved site and never returns the password", async () => {
  const t = await tempVault();
  try {
    const login = await t.vault.create({ type: "login", website: "https://google.com", username: "me@gmail.com", password: PASSWORD });

    const evil = fakeDeps(t, [{ tabId: "tab-1", url: "https://google.com.evil.io/signin" }]);
    const refused = await evil.tools.callTool("vault_fill_password", { loginId: login.id, threadId: "thread-1" });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /Refused/);
    assert.ok(!textOf(refused).includes(PASSWORD));
    assert.equal(evil.typed.length, 0, "nothing typed on a lookalike");

    const unknown = await evil.tools.callTool("vault_fill_password", { loginId: login.id, threadId: "someone-else" });
    assert.equal(unknown.isError, true);

    const good = fakeDeps(t, [{ tabId: "tab-1", url: "https://accounts.google.com/v3/signin" }]);
    const ok = await good.tools.callTool("vault_fill_password", { loginId: login.id, threadId: "thread-1" });
    assert.equal(ok.isError, undefined);
    assert.ok(!textOf(ok).includes(PASSWORD));
    assert.deepEqual(JSON.parse(textOf(ok)), { filled: true, field: "password", site: "google.com", tabId: "tab-1" });
    assert.deepEqual(good.typed, [{ threadId: "thread-1", tabId: "tab-1", text: PASSWORD }]);

    const user = await good.tools.callTool("vault_fill_username", { loginId: login.id, threadId: "thread-1" });
    assert.equal(JSON.parse(textOf(user)).filled, true);
    assert.equal(good.typed[1].text, "me@gmail.com");

    // Several tabs: picks the one on the site, or asks for tabId.
    const many = fakeDeps(t, [{ tabId: "a", url: "https://news.ycombinator.com" }, { tabId: "b", url: "https://accounts.google.com" }]);
    assert.equal(JSON.parse(textOf(await many.tools.callTool("vault_fill_password", { loginId: login.id, threadId: "thread-1" }))).tabId, "b");
    const forced = await many.tools.callTool("vault_fill_password", { loginId: login.id, threadId: "thread-1", tabId: "a" });
    assert.equal(forced.isError, true);
  } finally {
    await t.cleanup();
  }
});

test("vault_save_login moves a request_secret file into the Vault", async () => {
  const t = await tempVault();
  try {
    const { tools } = fakeDeps(t, []);
    const secrets = path.join(t.dir, "t3-secrets");
    await mkdir(secrets, { recursive: true });
    const file = path.join(secrets, "a1ca01a31bae");
    await writeFile(file, `${PASSWORD}\n`, { mode: 0o600 });

    const saved = await tools.callTool("vault_save_login", { website: "home.example.com", secretFile: file, title: "Home Assistant token", hints: "REST API", apiToken: true, threadId: "thread-1" });
    const text = textOf(saved);
    assert.ok(!text.includes(PASSWORD));
    const out = JSON.parse(text);
    assert.equal(out.saved, true);
    assert.equal(out.apiToken, true);
    const item = await t.vault.get(out.loginId, { reveal: true });
    assert.equal(item.password, PASSWORD, "trailing newline dropped");
    assert.equal(item.botCanRead, true);
    await assert.rejects(() => stat(file), "T3's copy is deleted");

    // Same site and username updates instead of duplicating; title and hints stay unless given.
    await writeFile(file, "rotated", { mode: 0o600 });
    const again = JSON.parse(textOf(await tools.callTool("vault_save_login", { website: "https://home.example.com", secretFile: file, apiToken: true, threadId: "thread-1" })));
    assert.equal(again.loginId, out.loginId);
    assert.equal(again.updated, true);
    const updated = await t.vault.get(out.loginId, { reveal: true });
    assert.equal(updated.password, "rotated");
    assert.equal(updated.title, "Home Assistant token");
    assert.equal(updated.hints, "REST API");
    assert.equal((await t.vault.list()).length, 1);

    // Only files in T3's secrets folder.
    const outside = path.join(t.dir, "not-a-secret");
    await writeFile(outside, "x");
    assert.equal((await tools.callTool("vault_save_login", { website: "x.com", secretFile: outside, threadId: "thread-1" })).isError, true);
    assert.equal((await tools.callTool("vault_save_login", { website: "x.com", secretFile: path.join(secrets, "..", "not-a-secret"), threadId: "thread-1" })).isError, true);
    assert.match(textOf(await tools.callTool("vault_save_login", { website: "x.com", secretFile: path.join(secrets, "gone"), threadId: "thread-1" })), /expired/);
    assert.equal((await tools.callTool("vault_save_login", { website: "x.com", secretFile: file, threadId: "nobody" })).isError, true);
  } finally {
    await t.cleanup();
  }
});

test("vault_secret_file hands out API tokens only", async () => {
  const t = await tempVault();
  try {
    const { tools } = fakeDeps(t, []);
    const token = await t.vault.create({ type: "login", website: "home.example.com", password: "tok-123", botCanRead: true });
    const site = await t.vault.create({ type: "login", website: "github.com", username: "octo", password: PASSWORD });

    const res = await tools.callTool("vault_secret_file", { loginId: token.id, threadId: "thread-1" });
    const out = JSON.parse(textOf(res));
    assert.ok(!textOf(res).includes("tok-123"));
    assert.equal(await readFile(out.file, "utf8"), "tok-123");
    assert.equal((await stat(out.file)).mode & 0o777, 0o600);
    assert.equal(path.dirname(out.file), path.join(t.dir, "bot-secrets"));

    const refused = await tools.callTool("vault_secret_file", { loginId: site.id, threadId: "thread-1" });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /vault_fill_password/);

    const list = JSON.parse(textOf(await tools.callTool("vault_list", {})));
    assert.equal(list.items.find((i) => i.id === token.id).apiToken, true);
    assert.equal(list.items.find((i) => i.id === site.id).apiToken, false);
  } finally {
    await t.cleanup();
  }
});

test("vault_save_contact saves contact fields", async () => {
  const t = await tempVault();
  try {
    const { tools } = fakeDeps(t, []);
    const out = JSON.parse(textOf(await tools.callTool("vault_save_contact", { name: "Ada", email: "ada@example.com", city: "Madrid", kind: "home", password: "nope", threadId: "thread-1" })));
    const c = await t.vault.get(out.contactId);
    assert.equal(c.type, "contact");
    assert.equal(c.city, "Madrid");
    assert.equal(c.password, undefined);
    assert.equal((await tools.callTool("vault_save_contact", { label: "Empty", threadId: "thread-1" })).isError, true);
  } finally {
    await t.cleanup();
  }
});

test("MCP over HTTP needs the bearer, refuses tunnel traffic and GET", async () => {
  const t = await tempVault();
  const { tools } = fakeDeps(t, []);
  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };
  const server = http.createServer((req, res) => handleMcpHttp(req, res, { tools, token: "secret-token", readBody }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/mcp/bot`;
  const post = (body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer secret-token", "cf-connecting-ip": "1.2.3.4" })).status, 403);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer secret-token" } })).status, 405);
    const ok = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer secret-token" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.tools.length, TOOLS.length);
    assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { authorization: "Bearer secret-token" })).status, 202);
  } finally {
    server.close();
    await t.cleanup();
  }
});

test("redact drops only the password", () => {
  const r = redact({ id: "1", type: "login", website: "https://x.com", username: "u", password: "p" });
  assert.equal(r.password, undefined);
  assert.equal(r.hasPassword, true);
  assert.equal(r.domain, "x.com");
});


test("repeated values persist, mirror primary fields and fill only explicitly saved sites", async () => {
  const t = await tempVault();
  try {
    const login = await t.vault.create({ type: "login", websites: ["example.invalid", "https://login.other.invalid", "example.invalid"], username: "sample", password: PASSWORD });
    assert.deepEqual(login.websites, ["https://example.invalid", "https://login.other.invalid"]);
    assert.equal(login.website, "https://example.invalid");
    assert.equal(login.password, undefined);
    const fresh = createVault({ file: t.file, keyFile: t.keyFile });
    assert.deepEqual((await fresh.get(login.id)).websites, login.websites);
    for (const [url,allowed] of [["https://sub.login.other.invalid/signin",true],["https://login.other.invalid.evil.test",false],["http://login.other.invalid",false],["https://other.invalid",false]]) {
      const deps = fakeDeps(t, [{ tabId: "sample", url }]);
      const result = await deps.tools.callTool("vault_fill_password", { loginId: login.id, threadId: "thread-1" });
      assert.equal(deps.typed.length, allowed ? 1 : 0, url);
      assert.equal(Boolean(result.isError), !allowed);
      assert.ok(!textOf(result).includes(PASSWORD));
    }
    await t.vault.saveLogin({ website: "https://login.other.invalid", username: "sample", password: "synthetic-new-value" });
    assert.deepEqual((await t.vault.get(login.id)).websites, login.websites, "updating a secret preserves secondary sites");
    await t.vault.update(login.id, { websites: ["example.invalid"] });
    const removed = fakeDeps(t, [{ tabId: "sample", url: "https://login.other.invalid" }]);
    assert.equal((await removed.tools.callTool("vault_fill_password", { loginId: login.id, threadId: "thread-1" })).isError, true);
    assert.equal(removed.typed.length, 0);
    const tools = fakeDeps(t, []).tools;
    const toolContact = JSON.parse(textOf(await tools.callTool("vault_save_contact", { threadId: "thread-1", emails: ["primary@example.invalid", "other@example.invalid"], phones: ["+15555550101", "+15555550102"] })));
    const contact = await t.vault.get(toolContact.contactId);
    assert.deepEqual(contact.emails, ["primary@example.invalid", "other@example.invalid"]);
    assert.equal(contact.email, "primary@example.invalid");
    await t.vault.update(contact.id, { emails: ["other@example.invalid", "primary@example.invalid"], phones: ["+15555550102"] });
    const saved = await t.vault.get(contact.id);
    assert.equal(saved.email, "other@example.invalid");
    assert.equal(saved.phone, "+15555550102");
    await t.vault.update(contact.id, { email: "legacy@example.invalid" });
    assert.deepEqual((await t.vault.get(contact.id)).emails, ["legacy@example.invalid", "primary@example.invalid"], "legacy scalar edits preserve secondary values");
    for (const websites of ["example.invalid", [null], Array(21).fill("example.invalid"), [{ secret: "never echo this" }]]) {
      await assert.rejects(t.vault.update(login.id, { websites }), error => error.status === 400 && !error.message.includes("never echo"));
    }
    assert.equal((await t.vault.get(login.id)).website, "https://example.invalid");
  } finally { await t.cleanup(); }
});

test("legacy encrypted records need no migration and repeated CSV exports retain every value", async () => {
  const t = await tempVault();
  try {
    const key = await loadOrCreateKey(t.keyFile);
    await writeFile(t.file, JSON.stringify(encrypt(key, { items: [{id:"old",type:"login",title:"Old",website:"https://old.invalid",password:PASSWORD}] })));
    const legacy = createVault({ file: t.file, keyFile: t.keyFile });
    const old = await legacy.get("old");
    assert.equal(old.website, "https://old.invalid");
    assert.equal(old.password, undefined);
    await legacy.update("old", { websites: ["old.invalid", "other.invalid"] });
    const csv = await legacy.exportCsv();
    assert.match(csv, /^name,url,username,password,note,websites/);
    assert.match(csv, /other.invalid/);
    await legacy.create({type:"contact",emails:["first@example.invalid","second@example.invalid"],phones:["111","222"]});
    const contacts = await legacy.exportCsv("contact");
    assert.match(contacts, /kind,note,emails,phones/);
    assert.match(contacts, /second@example.invalid/);
    assert.match(contacts, /222/);
  } finally { await t.cleanup(); }
});
