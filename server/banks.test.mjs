import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { connectionHealth, createBanks, parsePrivateKey, publicTransaction, redactIbans, signJwt } from "./banks.mjs";
import { BANK_TOOLS, createBankTools } from "./banks-mcp.mjs";
import { PROJECT_TOOLS, createProjectTools } from "./projects-mcp.mjs";
import { createBotTools } from "./vault-mcp.mjs";
import { renderAgentsMd } from "./bot-template.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const APP_ID = "0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const IBAN = "DE89370400440532013000";
const SESSION = "sess-7f3a9c2b-secret";
const DAY = 86400_000;

/** A small Enable Banking: checks the JWT and answers the calls the module makes. */
function fakeEnableBanking({ redirectUrls = ["https://bot.example/banks/callback"] } = {}) {
  const calls = [];
  const faults = { deleteStatus: 204 };
  const sessions = new Map();
  let txPages = 0;
  const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  async function fetch(url, init) {
    const u = new URL(url);
    const [h, p, sig] = String(init.headers.authorization).replace(/^Bearer /, "").split(".");
    assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url")), "JWT is signed with the app key");
    assert.equal(JSON.parse(Buffer.from(h, "base64url")).kid, APP_ID);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: u.pathname, search: u.search, body });
    if (u.pathname === "/application") return json(200, { name: "Roka Grok", environment: "PRODUCTION", redirect_urls: redirectUrls });
    if (u.pathname === "/aspsps") return json(200, { aspsps: [{ name: "N26", country: u.searchParams.get("country"), maximum_consent_validity: 90 * 86400 }, { name: "Trade Republic", country: u.searchParams.get("country"), maximum_consent_validity: 180 * 86400 }] });
    if (u.pathname === "/auth") return json(200, { url: `https://tilisy.enablebanking.com/welcome?sessionid=abc&state=${body.state}`, authorization_id: "auth-1" });
    if (u.pathname === "/sessions" && init.method === "POST") {
      if (body.code !== "good-code") return json(422, { code: 422, message: "Invalid code" });
      sessions.set(SESSION, "AUTHORIZED");
      return json(200, { session_id: SESSION, access: { valid_until: new Date(Date.now() + 90 * DAY).toISOString() }, accounts: [
        { uid: "acc-main", name: "Main", currency: "EUR", cash_account_type: "CACC", account_id: { iban: IBAN } },
        { uid: "acc-savings", product: "Savings", currency: "EUR", all_account_ids: [{ scheme_name: "IBAN", identification: "DE02120300000000202051" }] },
      ] });
    }
    if (u.pathname.startsWith("/sessions/")) {
      const id = decodeURIComponent(u.pathname.slice(10));
      if (init.method === "DELETE") { if (faults.deleteStatus >= 400) return json(faults.deleteStatus, { message: "unavailable" }); sessions.delete(id); return json(204, null); }
      return json(200, { status: sessions.get(id) ?? "EXPIRED" });
    }
    if (sessions.get(SESSION) !== "AUTHORIZED") return json(401, { message: "Session expired" });
    if (u.pathname === "/accounts/acc-main/balances") return json(200, { balances: [{ name: "Booked", balance_amount: { currency: "EUR", amount: "1234.56" }, balance_type: "CLBD", reference_date: "2026-11-05" }] });
    if (u.pathname === "/accounts/acc-main/transactions") {
      txPages++;
      if (!u.searchParams.get("continuation_key")) return json(200, { continuation_key: "page2", transactions: [
        { entry_reference: "t1", transaction_amount: { currency: "EUR", amount: "12.50" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-11-01", creditor: { name: "Bakery" }, creditor_account: { iban: "DE00999" }, remittance_information: ["Bread"] },
      ] });
      return json(200, { transactions: [
        { entry_reference: "t2", transaction_amount: { currency: "EUR", amount: "2000" }, credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-11-03", debtor: { name: "Employer" } },
      ] });
    }
    return json(404, { message: "not found" });
  }
  return { fetch, calls, sessions, faults, get txPages() { return txPages; } };
}

async function setup(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "banks-"));
  const file = path.join(dir, "banks.enc");
  const key = randomBytes(32);
  const eb = fakeEnableBanking(options);
  let clock = Date.now();
  const banks = createBanks({ file, key: async () => key, redirectUrl: () => "https://bot.example/banks/callback", fetch: eb.fetch, now: () => clock, ...options.banks });
  return { dir, file, key, eb, banks, advance: (ms) => { clock += ms; }, done: () => rm(dir, { recursive: true, force: true }) };
}

test("a private key is read even when its line breaks were lost, and a JWT is signed for Enable Banking", () => {
  const flattened = PEM.replace(/\n/g, " ");
  const key = parsePrivateKey(flattened);
  assert.equal(key.asymmetricKeyType, "rsa");
  assert.throws(() => parsePrivateKey("nope"), (e) => e.status === 400 && !/nope/.test(e.message));
  const token = signJwt({ appId: APP_ID, key, now: 1_700_000_000_000 });
  const [h, p, s] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "RS256", kid: APP_ID });
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.iss, "enablebanking.com");
  assert.equal(claims.aud, "api.enablebanking.com");
  assert.ok(claims.exp - claims.iat <= 86400);
  assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")));
});

test("connect, approve, read: balances and transactions without IBANs or session ids", async () => {
  const t = await setup();
  try {
    assert.deepEqual((await t.banks.status()).configured, false);
    const saved = await t.banks.setup({ appId: APP_ID, privateKey: PEM });
    assert.equal(saved.redirectRegistered, true);
    assert.equal(saved.appName, "Roka Grok");

    const link = await t.banks.connect({ bank: "n26", country: "de", startedBy: "money" });
    assert.equal(link.bank, "N26");
    assert.equal(link.accessDays, 90);
    const auth = t.eb.calls.find((c) => c.path === "/auth").body;
    assert.equal(auth.redirect_url, "https://bot.example/banks/callback");
    assert.equal(auth.psu_type, "personal");
    assert.deepEqual(auth.aspsp, { name: "N26", country: "DE" });
    assert.ok(Date.parse(auth.access.valid_until) <= Date.now() + 90 * DAY);
    const stateToken = new URL(link.url).searchParams.get("state");

    await assert.rejects(t.banks.complete({ state: "0".repeat(64), code: "good-code" }), (e) => e.status === 400);
    const done = await t.banks.complete({ state: stateToken, code: "good-code" });
    assert.deepEqual(done, { bank: "N26", country: "DE", accounts: 2, startedBy: "money" });
    await assert.rejects(t.banks.complete({ state: stateToken, code: "good-code" }), /expired or was already used/, "one use only");

    const status = await t.banks.status();
    const shown = JSON.stringify(status);
    assert.ok(!shown.includes(IBAN) && !shown.includes(SESSION) && !shown.includes("BEGIN"), "no IBAN, session or key");
    assert.equal(status.connections[0].status, "connected");
    assert.deepEqual(status.connections[0].accounts.map((a) => [a.accountId, a.name, a.ibanEnding]), [["acc-main", "Main", "3000"], ["acc-savings", "Savings", "2051"]]);

    const balances = await t.banks.balances({ accountId: "acc-main" });
    assert.deepEqual(balances.balances, [{ amount: 1234.56, currency: "EUR", type: "CLBD", name: "Booked", asOf: "2026-11-05" }]);

    const tx = await t.banks.transactions({ accountId: "acc-main", dateFrom: "2026-10-01" });
    assert.equal(t.eb.txPages, 2, "follows continuation_key");
    assert.deepEqual(tx.transactions.map((x) => [x.date, x.amount, x.counterparty]), [["2026-11-03", 2000, "Employer"], ["2026-11-01", -12.5, "Bakery"]]);
    assert.ok(!JSON.stringify(tx).includes("DE00999"), "counterparty IBANs are dropped");
    await t.banks.transactions({ accountId: "acc-main", dateFrom: "2026-10-01" });
    assert.equal(t.eb.txPages, 2, "cached: banks limit background reads");

    const raw = await readFile(t.file, "utf8");
    assert.ok(!raw.includes(SESSION) && !raw.includes("PRIVATE KEY") && !raw.includes(APP_ID), "encrypted at rest");
    assert.equal((await stat(t.file)).mode & 0o777, 0o600);
    // A fresh process reads it back with the same key.
    const again = createBanks({ file: t.file, key: async () => t.key, fetch: t.eb.fetch });
    assert.equal((await again.status()).connections.length, 1);
    await assert.rejects(createBanks({ file: t.file, key: async () => randomBytes(32) }).status(), /Couldn't decrypt/);
  } finally { await t.done(); }
});

test("reconnecting replaces the old session; expiry and revocation ask for a reconnect", async () => {
  const t = await setup();
  try {
    await t.banks.setup({ appId: APP_ID, privateKey: PEM });
    const first = await t.banks.connect({ bank: "Trade Republic", country: "ES" });
    assert.equal(first.accessDays, 180);
    await t.banks.complete({ state: new URL(first.url).searchParams.get("state"), code: "good-code" });
    const second = await t.banks.connect({ bank: "Trade Republic", country: "ES" });
    await t.banks.complete({ state: new URL(second.url).searchParams.get("state"), code: "good-code" });
    assert.equal((await t.banks.status()).connections.length, 1);
    assert.ok(t.eb.calls.some((c) => c.method === "DELETE" && c.path === `/sessions/${SESSION}`), "old consent ended");

    // The fake deleted the session above; the next read finds it gone and marks it.
    await assert.rejects(t.banks.balances({ accountId: "acc-main" }), /ended access/);
    assert.equal((await t.banks.status()).connections[0].status, "needs-reconnect");

    const now = Date.parse("2026-11-06T00:00:00Z");
    assert.deepEqual(connectionHealth({ status: "authorized", validUntil: new Date(now + 10 * DAY).toISOString() }, now), { daysLeft: 10, expired: false, reconnectSoon: true });
    assert.equal(connectionHealth({ status: "authorized", validUntil: new Date(now - DAY).toISOString() }, now).expired, true);
  } finally { await t.done(); }
});

test("a denied approval, an unknown bank and a missing callback are explained", async () => {
  const t = await setup({ redirectUrls: ["https://finance.example/banks/callback"] });
  try {
    await assert.rejects(t.banks.connect({ bank: "N26", country: "DE" }), /isn't set up/);
    const saved = await t.banks.setup({ appId: APP_ID, privateKey: PEM });
    assert.equal(saved.redirectRegistered, false);
    assert.deepEqual(saved.registeredRedirectUrls, ["https://finance.example/banks/callback"]);
    await assert.rejects(t.banks.connect({ bank: "Nope Bank", country: "DE" }), /banks_find/);
    const link = await t.banks.connect({ bank: "N26", country: "DE" });
    await assert.rejects(t.banks.complete({ state: new URL(link.url).searchParams.get("state"), error: "access_denied", errorDescription: "User cancelled" }), /didn't grant access: User cancelled/);
    assert.equal((await t.banks.status()).connections.length, 0);
  } finally { await t.done(); }
  const n = await setup({ banks: { redirectUrl: () => "" } });
  try {
    await n.banks.setup({ appId: APP_ID, privateKey: PEM });
    await assert.rejects(n.banks.connect({ bank: "N26", country: "DE" }), /APP_URL/);
  } finally { await n.done(); }
});

test("races, a failed setup and a failed disconnect leave the store right", async () => {
  const t = await setup();
  try {
    // Reads that start before a save don't undo it.
    const early = t.banks.status();
    await t.banks.setup({ appId: APP_ID, privateKey: PEM });
    await early;
    assert.equal((await t.banks.status()).configured, true);

    // A wrong key for the same app fails without spoiling the saved key's token.
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    await assert.rejects(t.banks.setup({ appId: APP_ID, privateKey: other }));
    assert.equal((await t.banks.findBanks({ country: "DE" })).length, 2);

    // Two callbacks with the same state: only one becomes a session.
    const link = await t.banks.connect({ bank: "N26", country: "DE" });
    const stateToken = new URL(link.url).searchParams.get("state");
    const results = await Promise.allSettled([t.banks.complete({ state: stateToken, code: "good-code" }), t.banks.complete({ state: stateToken, code: "good-code" })]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(t.eb.calls.filter((c) => c.method === "POST" && c.path === "/sessions").length, 1);

    // Identical reads at once share one bank call.
    const before = t.eb.calls.length;
    await Promise.all([1, 2, 3, 4].map(() => t.banks.balances({ accountId: "acc-main" })));
    assert.equal(t.eb.calls.length - before, 1);

    // A transaction cap below what came back says there is more.
    assert.equal((await t.banks.transactions({ accountId: "acc-main", dateFrom: "2026-10-01", limit: 1 })).more, true);

    // Disconnect keeps the connection when Enable Banking can't end the access.
    const id = (await t.banks.status()).connections[0].connectionId;
    t.eb.faults.deleteStatus = 503;
    await assert.rejects(t.banks.disconnect({ connectionId: id }), /still connected/);
    assert.equal((await t.banks.status()).connections.length, 1);
    t.eb.faults.deleteStatus = 204;
    assert.deepEqual(await t.banks.disconnect({ connectionId: id }), { disconnected: true, bank: "N26" });
    assert.equal((await t.banks.status()).connections.length, 0);
  } finally { await t.done(); }
});

test("account numbers in free text are cut to their last 4", () => {
  assert.equal(redactIbans("Transfer to DE89 3704 0044 0532 0130 00 thanks"), "Transfer to ••••3000 thanks");
  const tx = publicTransaction({ transaction_amount: { amount: "1", currency: "EUR" }, credit_debit_indicator: "CRDT", remittance_information: [`From ${IBAN}`], debtor: { name: `Acct ${IBAN}` } });
  assert.ok(!JSON.stringify(tx).includes(IBAN));
  assert.equal(tx.description, "From ••••3000");
});

test("a transaction keeps only what a Bot needs", () => {
  assert.deepEqual(publicTransaction({ transaction_amount: { amount: "5", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "PDNG", value_date: "2026-11-02", creditor_account: { iban: IBAN } }),
    { date: "2026-11-02", amount: -5, currency: "EUR", direction: "out", status: "pending" });
});

test("the banks_* tools sit beside the Projects tools on the bot server and save the key from T3's secret file", async () => {
  const t = await setup();
  const secretsDir = path.join(t.dir, "secrets");
  await mkdir(secretsDir);
  const secretFile = path.join(secretsDir, "s1");
  await writeFile(secretFile, PEM.replace(/\n/g, " ") + "\n", { mode: 0o600 });
  const logs = [];
  const bank = { tools: BANK_TOOLS, call: createBankTools({ banks: t.banks, log: (l) => logs.push(l) }), instructions: "Banks too." };
  const projects = { tools: PROJECT_TOOLS, call: createProjectTools({ projects: { snapshot: async () => ({ items: [], activity: [] }) } }), instructions: "Projects too." };
  let on = { projects: true, banks: false };
  const tools = createBotTools({ vault: {}, findBotByThread: async (id) => (id === "t" ? { slug: "money", name: "Money", mainThreadId: "t" } : null), listTabs: async () => [], typeIntoTab: async () => {}, secretsDir,
    extra: async () => [on.projects ? projects : null, on.banks ? bank : null] });
  const names = async () => (await tools.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((x) => x.name);
  const call = async (name, args = {}) => (await tools.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }));
  try {
    assert.ok((await names()).includes("projects_overview"));
    assert.ok(!(await names()).includes("banks_status"));
    assert.equal((await call("banks_status")).error.code, -32602);
    on = { projects: false, banks: true };
    assert.ok((await names()).includes("banks_connect"));
    assert.ok(!(await names()).includes("projects_overview"));
    assert.match((await tools.handleRpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })).result.instructions, /Banks too/);

    assert.match((await call("banks_status")).result.content[0].text, /isn't set up/);
    const refused = await call("banks_setup", { appId: APP_ID, secretFile: path.join(t.dir, "elsewhere"), threadId: "t" });
    assert.equal(refused.result.isError, true);
    const setupOut = await call("banks_setup", { appId: APP_ID, secretFile, threadId: "t" });
    assert.notEqual(setupOut.result.isError, true, setupOut.result.content[0].text);
    assert.ok(!setupOut.result.content[0].text.includes("PRIVATE"));
    await assert.rejects(stat(secretFile), "T3's copy is deleted");
    assert.equal((await call("banks_connect", { bank: "N26", country: "DE", threadId: "nope" })).result.isError, true, "needs a Bot's thread");
    const connect = JSON.parse((await call("banks_connect", { bank: "N26", country: "DE", threadId: "t" })).result.content[0].text);
    assert.match(connect.send, /^\[Connect N26\]\(https:\/\/tilisy\.enablebanking\.com\//);
    assert.ok(!logs.join("\n").includes("BEGIN"));
  } finally { await t.done(); }
});

test("the Bot instructions carry the Bank accounts section only while the beta is on", () => {
  const render = (beta) => renderAgentsMd({ bot: { name: "Money", slug: "money", mainThreadId: "t" }, settings: { userName: "Roka", beta }, botsRoot: "/bots" });
  assert.doesNotMatch(render({ projects: false }), /banks_|Enable Banking/);
  const on = render({ banks: true });
  assert.match(on, /## Bank accounts\n- Roka's bank accounts/);
  assert.match(on, /never payments/);
  assert.match(on, /\n\n## Bank accounts[\s\S]*don't try to find the rest\.\n\n## Computer/);
});
