// Bank accounts through Enable Banking (PSD2 account information, read-only): N26, Trade Republic
// and any other bank Enable Banking lists. No payments: this module never calls a payment endpoint.
//
// Why not Executor: Executor's accounts are OAuth or API keys. Enable Banking signs every request
// with the app's own RSA key (an RS256 JWT, kid = app id) and grants access per bank through a
// consent session the user approves in their bank app, so it lives next to the Vault instead.
//
// Storage: one AES-256-GCM file, BANKS_FILE (default `$THREEBOT_HOME/banks.enc`), encrypted with the
// Vault key (AAD "bot-banks:v1"). It holds the app id and private key, the pending sign-ins and the
// sessions. Nothing here is ever returned to a Bot or the app: not the key, not session ids, not IBANs.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const FORMAT = "bot-banks";
const VERSION = 1;
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`);
export const API_URL = "https://api.enablebanking.com";
const DAY = 24 * 3600 * 1000;
const PENDING_TTL_MS = 60 * 60 * 1000;
/** Sessions this close to expiry are flagged so the Bot asks for a reconnect in time. */
export const RECONNECT_WARNING_DAYS = 14;
const DEFAULT_CONSENT_DAYS = 90;
const MAX_CONSENT_DAYS = 180;
const CACHE_MS = 10 * 60 * 1000;
const MAX_PAGES = 20;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const text = (value) => (typeof value === "string" ? value.trim() : "");
const b64url = (value) => Buffer.from(value).toString("base64url");

// ---------- the private key ----------
/**
 * Accepts the PEM as Enable Banking gives it, or the same text with its line breaks lost
 * (a secure card or a chat paste often turns them into spaces). Returns a KeyObject.
 */
export function parsePrivateKey(input) {
  const raw = String(input ?? "").trim();
  const attempts = [raw];
  const m = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(raw);
  const body = (m ? m[2] : raw).replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(body)) {
    const lines = body.match(/.{1,64}/g)?.join("\n") ?? "";
    for (const label of m ? [m[1]] : ["PRIVATE KEY", "RSA PRIVATE KEY"]) attempts.push(`-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`);
  }
  for (const pem of attempts) {
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== "rsa") throw httpError(400, "The Enable Banking key must be an RSA private key.");
      return key;
    } catch (e) {
      if (e.status) throw e;
    }
  }
  // Never echo the input: it is the key.
  throw httpError(400, "That isn't a readable private key. Paste the whole .pem file Enable Banking gave you, including the BEGIN and END lines.");
}

/** The JWT Enable Banking expects on every call (at most 24 hours; we use one). */
export function signJwt({ appId, key, now = Date.now(), ttlSeconds = 3600 }) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const payload = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + ttlSeconds }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// ---------- encrypted file ----------
function seal(key, payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  return { format: FORMAT, version: VERSION, cipher: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
function unseal(key, envelope) {
  if (envelope?.format !== FORMAT || envelope.version !== VERSION || envelope.cipher !== "aes-256-gcm") throw httpError(500, "The bank connections file isn't readable by this version.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    throw httpError(500, "Couldn't decrypt the bank connections file. The Vault key doesn't match it, or the file is damaged.");
  }
}
async function writeAtomic(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await fs.open(tmp, "w", 0o600);
  try { await fh.writeFile(body); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, file);
}

// ---------- shapes Bots see ----------
/** Free text (remittance, names) can carry account numbers too: keep only their last 4. */
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
export const redactIbans = (value) => String(value).replace(IBAN_RE, (m) => `••••${m.replace(/ /g, "").slice(-4)}`);
const safeText = (value) => redactIbans(text(value));
const last4 = (iban) => { const s = text(iban).replace(/\s+/g, ""); return s.length >= 4 ? s.slice(-4) : ""; };
function publicAccount(raw) {
  const iban = raw?.account_id?.iban ?? raw?.all_account_ids?.find?.((id) => id?.scheme_name === "IBAN")?.identification;
  return {
    accountId: String(raw.uid),
    name: safeText(raw.name) || safeText(raw.product) || safeText(raw.details) || "Account",
    ...(text(raw.product) ? { product: safeText(raw.product) } : {}),
    ...(text(raw.cash_account_type) ? { type: text(raw.cash_account_type) } : {}),
    ...(text(raw.usage) ? { usage: text(raw.usage) } : {}),
    currency: text(raw.currency) || null,
    ...(last4(iban) ? { ibanEnding: last4(iban) } : {}),
  };
}
export function connectionHealth(connection, now = Date.now()) {
  const until = Date.parse(connection.validUntil);
  const daysLeft = Number.isFinite(until) ? Math.floor((until - now) / DAY) : null;
  const expired = connection.status !== "authorized" || (Number.isFinite(until) && until <= now);
  return { daysLeft, expired, reconnectSoon: !expired && daysLeft !== null && daysLeft <= RECONNECT_WARNING_DAYS };
}
function publicConnection(connection, now) {
  const health = connectionHealth(connection, now);
  return {
    connectionId: connection.id,
    bank: connection.aspsp.name,
    country: connection.aspsp.country,
    validUntil: connection.validUntil,
    ...health,
    status: health.expired ? "needs-reconnect" : health.reconnectSoon ? "reconnect-soon" : "connected",
    connectedAt: connection.createdAt,
    accounts: connection.accounts,
  };
}
function amountOf(value) {
  const n = Number(value?.amount);
  return Number.isFinite(n) ? n : null;
}
export function publicTransaction(raw) {
  const debit = raw.credit_debit_indicator === "DBIT";
  const amount = amountOf(raw.transaction_amount);
  const party = debit ? raw.creditor?.name : raw.debtor?.name;
  const remittance = Array.isArray(raw.remittance_information) ? raw.remittance_information.filter((s) => typeof s === "string").join(" ").trim() : text(raw.remittance_information);
  return {
    date: raw.booking_date ?? raw.value_date ?? raw.transaction_date ?? null,
    amount: amount === null ? null : debit ? -Math.abs(amount) : Math.abs(amount),
    currency: raw.transaction_amount?.currency ?? null,
    direction: debit ? "out" : raw.credit_debit_indicator === "CRDT" ? "in" : null,
    status: raw.status === "PDNG" ? "pending" : raw.status === "BOOK" ? "booked" : (raw.status ?? null),
    ...(text(party) ? { counterparty: safeText(party) } : {}),
    ...(remittance ? { description: redactIbans(remittance).slice(0, 500) } : {}),
    ...(text(raw.bank_transaction_code?.description) ? { kind: safeText(raw.bank_transaction_code.description) } : {}),
    ...(text(raw.merchant_category_code) ? { merchantCategory: text(raw.merchant_category_code) } : {}),
    ...(text(raw.entry_reference) ? { id: text(raw.entry_reference) } : {}),
  };
}
const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) && Number.isFinite(Date.parse(value)) ? String(value) : null);

/**
 * @param file         where the encrypted state lives
 * @param key          () => Promise<Buffer> — the Vault's 32-byte key
 * @param redirectUrl  () => string — default callback, e.g. `${APP_URL}/banks/callback`
 */
export function createBanks({ file, key: loadKey, redirectUrl: defaultRedirect = () => "", apiUrl = API_URL, fetch: request = globalThis.fetch, now = () => Date.now(), log = () => {} }) {
  let key = null;
  let state = null;
  let queue = Promise.resolve();
  let loading = null;
  const jwts = new Map();
  const cache = new Map();
  const inflight = new Map();

  /** One read of the file for every caller, so a slow first read can't overwrite a later save. */
  function load() {
    if (state) return Promise.resolve(state);
    loading ??= readState().then((value) => (state ??= value)).finally(() => { loading = null; });
    return loading;
  }
  async function readState() {
    key ??= await loadKey();
    let raw = null;
    try { raw = await fs.readFile(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (raw === null) return { app: null, pending: [], connections: [] };
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw httpError(500, "The bank connections file is damaged."); }
    const payload = unseal(key, envelope);
    return ({ app: payload.app ?? null, pending: Array.isArray(payload.pending) ? payload.pending : [], connections: Array.isArray(payload.connections) ? payload.connections : [] });
  }
  function mutate(fn) {
    const run = queue.then(async () => {
      const current = structuredClone(await load());
      const result = await fn(current);
      current.pending = current.pending.filter((p) => Date.parse(p.expiresAt) > now());
      await writeAtomic(file, JSON.stringify(seal(key, { ...current, updatedAt: new Date(now()).toISOString() })) + "\n");
      state = current;
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  function redirectFor(app) { return text(app?.redirectUrl) || text(defaultRedirect()); }

  async function api(app, method, route, body) {
    if (!app) throw httpError(409, "Enable Banking isn't set up yet. Run banks_setup first.");
    // Keyed by the credential itself, so checking a new key in setup never leaves a bad token behind.
    const credential = createHash("sha256").update(`${app.appId}\n${app.privateKey}`).digest("hex");
    let jwt = jwts.get(credential);
    if (!jwt || jwt.expires <= now() + 60_000) {
      jwt = { token: signJwt({ appId: app.appId, key: parsePrivateKey(app.privateKey), now: now() }), expires: now() + 3600_000 };
      jwts.clear();
      jwts.set(credential, jwt);
    }
    let response;
    try {
      response = await request(apiUrl + route, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${jwt.token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw httpError(502, "Enable Banking isn't reachable right now. Try again in a few minutes.");
    }
    let data = null;
    try { data = response.status === 204 ? null : await response.json(); } catch { data = null; }
    if (!response.ok) {
      // Enable Banking's errors describe the request, never the key; still keep them short.
      const detail = text(data?.message) || text(data?.error) || text(data?.code);
      const error = httpError(response.status, response.status === 401 && !route.startsWith("/accounts")
        ? "Enable Banking refused the app's signature. Check the app id and private key (banks_setup)."
        : response.status === 429 ? "The bank's daily limit for background reads was reached. Try again later or tomorrow."
        : `Enable Banking said ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
      error.code = text(data?.code) || text(data?.error);
      throw error;
    }
    return data;
  }

  async function connectionFor(id) {
    const all = (await load()).connections;
    const found = all.find((c) => c.id === id) ?? all.find((c) => c.accounts.some((a) => a.accountId === id));
    if (!found) throw httpError(404, "No bank connection with that id. Check banks_status.");
    return found;
  }
  async function accountFor(accountId) {
    const connection = (await load()).connections.find((c) => c.accounts.some((a) => a.accountId === accountId));
    if (!connection) throw httpError(404, "No connected account with that accountId. Check banks_status.");
    return { connection, account: connection.accounts.find((a) => a.accountId === accountId) };
  }

  /** A read on a session the bank has ended marks it, so banks_status says to reconnect. */
  async function accountCall(connection, route) {
    const { app } = await load();
    const health = connectionHealth(connection, now());
    if (health.expired) throw httpError(409, `${connection.aspsp.name} needs to be reconnected (access ended${connection.validUntil ? ` ${connection.validUntil.slice(0, 10)}` : ""}). Start banks_connect again.`);
    try {
      return await api(app, "GET", route);
    } catch (error) {
      if ([401, 403, 404, 422].includes(error.status)) {
        let status = null;
        try { status = (await api(app, "GET", `/sessions/${encodeURIComponent(connection.sessionId)}`))?.status; } catch {}
        if (status && status !== "AUTHORIZED") {
          await mutate((s) => { const c = s.connections.find((x) => x.id === connection.id); if (c) { c.status = String(status).toLowerCase(); c.updatedAt = new Date(now()).toISOString(); } });
          log(`banks: ${connection.aspsp.name} session is ${status}`);
          throw httpError(409, `${connection.aspsp.name} ended access (${String(status).toLowerCase()}). Start banks_connect again to reconnect.`);
        }
      }
      throw error;
    }
  }
  /** Banks allow a few unattended reads a day: identical reads share one call and its result for 10 minutes. */
  async function cached(cacheKey, fn) {
    const hit = cache.get(cacheKey);
    if (hit && hit.at > now() - CACHE_MS) return { ...hit.value, cachedAt: new Date(hit.at).toISOString() };
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    const run = fn().then((value) => { cache.set(cacheKey, { at: now(), value }); return value; }).finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, run);
    return run;
  }

  return {
    file,
    /** What Settings and banks_status show: whether it's set up and each bank's health. Never secrets. */
    async status() {
      const s = await load();
      const t = now();
      return {
        configured: Boolean(s.app),
        ...(s.app ? { appId: s.app.appId, ...(s.app.appName ? { appName: s.app.appName } : {}), redirectUrl: redirectFor(s.app) || null } : { redirectUrl: text(defaultRedirect()) || null }),
        connections: s.connections.map((c) => publicConnection(c, t)),
        pending: s.pending.filter((p) => Date.parse(p.expiresAt) > t).map((p) => ({ bank: p.aspsp.name, country: p.aspsp.country, startedAt: p.createdAt })),
      };
    },

    /** Saves the app id and private key after checking Enable Banking accepts them. */
    async setup({ appId, privateKey, redirectUrl }) {
      const id = text(appId);
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw httpError(400, "appId must be the Enable Banking application id (a UUID, shown in the control panel).");
      parsePrivateKey(privateKey);
      const redirect = text(redirectUrl);
      if (redirect) {
        let u;
        try { u = new URL(redirect); } catch { throw httpError(400, "redirectUrl must be a full https:// address."); }
        if (u.protocol !== "https:" || u.username || u.password) throw httpError(400, "redirectUrl must be a full https:// address.");
      }
      const app = { appId: id, privateKey: String(privateKey), ...(redirect ? { redirectUrl: redirect } : {}) };
      const info = await api(app, "GET", "/application");
      const registered = Array.isArray(info?.redirect_urls) ? info.redirect_urls.filter((u) => typeof u === "string") : null;
      const callback = redirectFor(app);
      app.appName = text(info?.name);
      app.environment = text(info?.environment);
      app.savedAt = new Date(now()).toISOString();
      await mutate((s) => { s.app = app; });
      log(`banks: saved Enable Banking app ${id}${app.appName ? ` (${app.appName})` : ""}`);
      return {
        saved: true, appId: id, appName: app.appName || null, environment: app.environment || null,
        redirectUrl: callback || null,
        redirectRegistered: registered && callback ? registered.includes(callback) : null,
        ...(registered && callback && !registered.includes(callback) ? { registeredRedirectUrls: registered } : {}),
      };
    },

    /** Banks Enable Banking can connect, by country (ISO 3166 alpha-2) and an optional name filter. */
    async findBanks({ country, search }) {
      const { app } = await load();
      const c = text(country).toUpperCase();
      if (!/^[A-Z]{2}$/.test(c)) throw httpError(400, "country must be a two-letter code, e.g. DE or ES.");
      const data = await api(app, "GET", `/aspsps?country=${c}&psu_type=personal`);
      const q = text(search).toLowerCase();
      return (Array.isArray(data?.aspsps) ? data.aspsps : [])
        .filter((a) => !q || String(a.name).toLowerCase().includes(q))
        .slice(0, 50)
        .map((a) => ({ bank: a.name, country: a.country, ...(a.maximum_consent_validity ? { maxAccessDays: Math.floor(a.maximum_consent_validity / 86400) } : {}) }));
    },

    /** Starts a sign-in: returns the bank's approval link. The callback finishes it. */
    async connect({ bank, country, startedBy = null }) {
      const { app } = await load();
      const c = text(country).toUpperCase();
      const name = text(bank);
      if (!name || !/^[A-Z]{2}$/.test(c)) throw httpError(400, "Give the bank's name and two-letter country as banks_find lists them, e.g. bank \"N26\", country \"DE\".");
      const redirect = redirectFor(app);
      if (!app) throw httpError(409, "Enable Banking isn't set up yet. Run banks_setup first.");
      if (!redirect) throw httpError(409, "There's no callback address. Set APP_URL (or ENABLE_BANKING_REDIRECT_URL) on the gateway, or pass redirectUrl to banks_setup, and register it in the Enable Banking control panel.");
      const listed = await api(app, "GET", `/aspsps?country=${c}&psu_type=personal`);
      const aspsp = (Array.isArray(listed?.aspsps) ? listed.aspsps : []).find((a) => String(a.name).toLowerCase() === name.toLowerCase());
      if (!aspsp) throw httpError(404, `Enable Banking has no bank called "${name}" in ${c}. Look it up with banks_find.`);
      const maxDays = aspsp.maximum_consent_validity ? Math.floor(aspsp.maximum_consent_validity / 86400) : DEFAULT_CONSENT_DAYS;
      const days = Math.max(1, Math.min(maxDays, MAX_CONSENT_DAYS));
      // A minute short of the bank's maximum: some banks refuse a validity exactly at it.
      const validUntil = new Date(now() + days * DAY - 60_000).toISOString();
      const stateToken = randomBytes(32).toString("hex");
      const result = await api(app, "POST", "/auth", {
        access: { valid_until: validUntil },
        aspsp: { name: aspsp.name, country: aspsp.country },
        state: stateToken,
        redirect_url: redirect,
        psu_type: "personal",
      });
      let url;
      try { url = new URL(result?.url); } catch { throw httpError(502, "Enable Banking didn't return a sign-in link."); }
      if (url.protocol !== "https:") throw httpError(502, "Enable Banking returned an unexpected sign-in link.");
      const t = now();
      await mutate((s) => {
        s.pending = s.pending.filter((p) => !(p.aspsp.name === aspsp.name && p.aspsp.country === aspsp.country));
        s.pending.push({ state: stateToken, aspsp: { name: aspsp.name, country: aspsp.country }, createdAt: new Date(t).toISOString(), expiresAt: new Date(t + PENDING_TTL_MS).toISOString(), startedBy });
      });
      log(`banks: started sign-in for ${aspsp.name} (${aspsp.country})${startedBy ? `, bot ${startedBy}` : ""}`);
      return { url: url.href, bank: aspsp.name, country: aspsp.country, accessDays: days, linkExpiresInMinutes: PENDING_TTL_MS / 60000 };
    },

    /**
     * The bank sent the user back. Turns the one-time code into a session and replaces any older
     * connection to the same bank. Returns {bank, accounts} or throws with a message safe to show.
     */
    async complete({ state: stateToken, code, error, errorDescription }) {
      const token = text(stateToken);
      if (!/^[a-f0-9]{64}$/.test(token)) throw httpError(400, "This sign-in link has expired or was already used. Ask your Bot for a new one.");
      // Found and removed under the store's lock: one use, even for callbacks that arrive together.
      const pending = await mutate((s) => {
        const found = s.pending.find((p) => p.state === token && Date.parse(p.expiresAt) > now()) ?? null;
        s.pending = s.pending.filter((p) => p.state !== token);
        return found;
      });
      if (!pending) throw httpError(400, "This sign-in link has expired or was already used. Ask your Bot for a new one.");
      const s0 = await load();
      if (text(error)) {
        log(`banks: ${pending.aspsp.name} sign-in was not approved (${text(error).slice(0, 60)})`);
        throw httpError(400, `${pending.aspsp.name} didn't grant access${text(errorDescription) ? `: ${text(errorDescription).slice(0, 200)}` : ""}. Ask your Bot for a new link to try again.`);
      }
      if (!text(code) || text(code).length > 2048) throw httpError(400, "The bank didn't send an approval code. Ask your Bot for a new link.");
      const session = await api(s0.app, "POST", "/sessions", { code: text(code) });
      if (!text(session?.session_id) || !Array.isArray(session?.accounts)) throw httpError(502, "Enable Banking didn't return the session.");
      const accounts = session.accounts.filter((a) => a && (typeof a.uid === "string" || typeof a.uid === "number")).map(publicAccount);
      const t = new Date(now()).toISOString();
      const replaced = await mutate((s) => {
        const old = s.connections.filter((c) => c.aspsp.name === pending.aspsp.name && c.aspsp.country === pending.aspsp.country);
        s.connections = s.connections.filter((c) => !old.includes(c));
        s.connections.push({
          id: `bank_${randomUUID().slice(0, 8)}`, sessionId: session.session_id, aspsp: pending.aspsp, accounts,
          validUntil: text(session.access?.valid_until) || null, status: "authorized", createdAt: t, updatedAt: t,
        });
        return old;
      });
      // The old consent is no longer needed; ending it is best effort.
      for (const old of replaced) await api(s0.app, "DELETE", `/sessions/${encodeURIComponent(old.sessionId)}`).catch(() => {});
      cache.clear();
      log(`banks: connected ${pending.aspsp.name} (${pending.aspsp.country}), ${accounts.length} account(s)${replaced.length ? ", replacing the old session" : ""}`);
      return { bank: pending.aspsp.name, country: pending.aspsp.country, accounts: accounts.length, startedBy: pending.startedBy };
    },

    async balances({ accountId }) {
      const { connection, account } = await accountFor(text(accountId));
      return cached(`b:${account.accountId}`, async () => {
        const data = await accountCall(connection, `/accounts/${encodeURIComponent(account.accountId)}/balances`);
        const balances = (Array.isArray(data?.balances) ? data.balances : []).map((b) => ({
          amount: amountOf(b.balance_amount), currency: b.balance_amount?.currency ?? null, type: b.balance_type ?? null,
          ...(text(b.name) ? { name: text(b.name) } : {}),
          asOf: b.last_change_date_time ?? b.reference_date ?? null,
        }));
        return { accountId: account.accountId, bank: connection.aspsp.name, account: account.name, balances };
      });
    },

    async transactions({ accountId, dateFrom, dateTo, limit }) {
      const { connection, account } = await accountFor(text(accountId));
      const from = isoDate(dateFrom) ?? new Date(now() - 30 * DAY).toISOString().slice(0, 10);
      const to = isoDate(dateTo);
      const max = Math.max(1, Math.min(Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 100, 1000));
      return cached(`t:${account.accountId}:${from}:${to ?? ""}:${max}`, async () => {
        const out = [];
        let continuation = null;
        let pages = 0;
        do {
          const query = new URLSearchParams({ date_from: from, ...(to ? { date_to: to } : {}), ...(continuation ? { continuation_key: continuation } : {}) });
          const data = await accountCall(connection, `/accounts/${encodeURIComponent(account.accountId)}/transactions?${query}`);
          for (const raw of Array.isArray(data?.transactions) ? data.transactions : []) out.push(publicTransaction(raw));
          continuation = text(data?.continuation_key) || null;
          pages++;
        } while (continuation && out.length < max && pages < MAX_PAGES);
        const more = Boolean(continuation) || out.length > max;
        out.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
        return { accountId: account.accountId, bank: connection.aspsp.name, account: account.name, dateFrom: from, ...(to ? { dateTo: to } : {}), count: Math.min(out.length, max), transactions: out.slice(0, max), ...(more ? { more: true } : {}) };
      });
    },

    /** Ends a bank's access here and at Enable Banking. */
    async disconnect({ connectionId }) {
      const connection = await connectionFor(text(connectionId));
      const { app } = await load();
      try {
        await api(app, "DELETE", `/sessions/${encodeURIComponent(connection.sessionId)}`);
      } catch (error) {
        // Already gone at Enable Banking (404) is fine; anything else keeps the connection so it can be retried.
        if (error.status !== 404) throw httpError(502, `${connection.aspsp.name} is still connected: Enable Banking couldn't end the access (${error.message}) Try again later.`);
      }
      await mutate((s) => { s.connections = s.connections.filter((c) => c.id !== connection.id); });
      cache.clear();
      log(`banks: disconnected ${connection.aspsp.name} (${connection.aspsp.country})`);
      return { disconnected: true, bank: connection.aspsp.name };
    },
  };
}
