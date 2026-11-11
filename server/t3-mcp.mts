// The gateway as an MCP client of the local T3 Code, so it can use T3's own forwarding to linked
// machines (t3_thread_read, t3_thread_send … with `environmentId`). T3 only forwards MCP tool calls
// between machines, and its /mcp endpoint only takes MCP client sessions, never the gateway's normal
// bearer. The gateway's bearer may approve one for itself, though (it holds access:write), so this
// runs T3's own OAuth sign-in without a browser: register, approve with the session, swap the code.
// The MCP credential is kept in a private file and renewed when T3 refuses it or it runs out.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;
type Credential = { accessToken: string; expiresAt: number };
/** A tool T3 refused or failed: its message is T3's, for the person reading the page. */
export class T3ToolError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

// Loopback redirects are never followed: the code comes back in the decision's JSON.
const REDIRECT = "http://127.0.0.1/threebot/t3-oauth";
const PROTOCOL = "2025-06-18";
// "auto" covers reading and messaging threads; the gateway never needs more over a link.
const ACCESS = "auto";

export function createT3Mcp({ baseUrl, token, file, fetcher = fetch, now = Date.now }: {
  baseUrl: string; token: string; file: string; fetcher?: McpFetch; now?: () => number;
}) {
  const base = baseUrl.replace(/\/$/, "");
  let credential: Credential | null = null;
  let session: string | null = null;
  let signingIn: Promise<Credential> | null = null;

  async function postJson(route: string, body: unknown, auth = false) {
    const response = await fetcher(base + route, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = null; }
    if (!response.ok) throw new T3ToolError(`T3 refused the gateway's sign-in (${route}, HTTP ${response.status})${value?.message || value?.error_description ? `: ${value.message ?? value.error_description}` : ""}`);
    return value;
  }

  async function signIn(): Promise<Credential> {
    const client = await postJson("/oauth/mcp/register", { client_name: "Threebot", redirect_uris: [REDIRECT] });
    const verifier = randomBytes(32).toString("base64url");
    const authorization = {
      response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, state: randomBytes(12).toString("hex"),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${base}/mcp`,
    };
    const approval = await postJson("/oauth/mcp/approval", authorization, true);
    // T3 sends a request it won't approve back to the redirect with its reason.
    if (typeof approval?.redirectTo === "string") {
      const reason = (() => { try { const back = new URL(approval.redirectTo).searchParams; return back.get("error_description") ?? back.get("error"); } catch { return null; } })();
      throw new T3ToolError(`T3 refused the gateway's sign-in${reason ? `: ${reason}` : "."}`);
    }
    if (!approval?.csrfToken) throw new T3ToolError("The gateway's T3 token can't approve its own access to linked machines. Issue it again with `t3 auth session issue` (it needs access:write).", 403);
    const decision = await postJson("/oauth/mcp/decision", { authorization, decision: { _tag: "browser-session", access: ACCESS, csrfToken: approval.csrfToken } }, true);
    const code = new URL(decision.redirectTo).searchParams.get("code");
    if (!code) throw new T3ToolError("T3 didn't approve the gateway's access to linked machines.");
    const response = await fetcher(base + "/oauth/mcp/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: `${base}/mcp` }) });
    const issued = await response.json().catch(() => null);
    if (!response.ok || typeof issued?.access_token !== "string") throw new T3ToolError("T3 didn't issue the gateway's access to linked machines.");
    const next = { accessToken: issued.access_token, expiresAt: now() + Math.max(60, Number(issued.expires_in) || 3600) * 1000 };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(next) + "\n", { mode: 0o600 });
    return next;
  }

  async function current(fresh = false): Promise<Credential> {
    if (!fresh && !credential) {
      try { credential = JSON.parse(await fs.readFile(file, "utf8")); } catch { credential = null; }
    }
    // Renew a day early so a call never races the expiry.
    if (!fresh && credential && typeof credential.accessToken === "string" && credential.expiresAt - 86_400_000 > now()) return credential;
    signingIn ??= signIn().finally(() => { signingIn = null; });
    credential = await signingIn;
    session = null;
    return credential;
  }

  async function rpc(body: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; value: any; session: string | null }> {
    const { accessToken } = await current();
    const response = await fetcher(base + "/mcp", { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: {
      authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}),
    }, body: JSON.stringify(body) });
    const text = await response.text();
    // Streamable HTTP may answer as one server-sent event; its data line is the JSON-RPC message.
    const json = /^\s*[{[]/.test(text) ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("");
    let value; try { value = json ? JSON.parse(json) : null; } catch { value = null; }
    return { status: response.status, value, session: response.headers.get("mcp-session-id") };
  }

  async function open() {
    const init = await rpc({ jsonrpc: "2.0", id: randomUUID(), method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "threebot", version: "1" } } }, 15000);
    if (init.status === 401) return false;
    if (init.status !== 200 || !init.session) throw new T3ToolError(`T3's tool server didn't start a session (HTTP ${init.status}).`);
    session = init.session;
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, 15000);
    return true;
  }

  /** One T3 tool call; the result is the tool's own JSON. */
  async function call(name: string, args: Record<string, unknown>, { timeoutMs = 30000 }: { timeoutMs?: number } = {}): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!session && !(await open())) { await current(true); continue; }
      const result = await rpc({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } }, timeoutMs);
      // 401: the credential ended; 404/400: T3 restarted and forgot the session.
      if (result.status === 401) { await current(true); continue; }
      if (result.status === 404 || (result.status === 400 && !result.value?.result)) { session = null; continue; }
      if (result.value?.error) throw new T3ToolError(String(result.value.error.message ?? "T3 tool call failed"));
      const content = result.value?.result?.content;
      const text = Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text).join("") : "";
      let value; try { value = JSON.parse(text); } catch { value = text; }
      if (result.value?.result?.isError) throw new T3ToolError(typeof value === "object" && value?.message ? String(value.message) : String(text || "T3 tool call failed"));
      if (result.status !== 200) throw new T3ToolError(`T3's tool server answered HTTP ${result.status}.`);
      return result.value?.result?.structuredContent ?? value;
    }
    throw new T3ToolError("T3 kept refusing the gateway's tool session.");
  }

  return { call };
}
export type T3Mcp = ReturnType<typeof createT3Mcp>;
