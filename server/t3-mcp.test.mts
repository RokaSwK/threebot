import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createT3Mcp } from "./t3-mcp.mts";

/** A stand-in for T3's MCP sign-in and tool server, recording what each request carried. */
function fakeT3({ expireFirst = false } = {}) {
  const calls: { route: string; auth: string | null; body: any }[] = [];
  let issued = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname;
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization");
    const raw = String(init.body ?? "");
    const body = route === "/oauth/mcp/token" ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : null;
    calls.push({ route, auth, body });
    if (route === "/oauth/mcp/register") return Response.json({ client_id: "client-1" }, { status: 201 });
    if (route === "/oauth/mcp/approval" && body.resource !== "http://t3.test/mcp") return Response.json({ redirectTo: `${body.redirect_uri}?error=invalid_target&error_description=${encodeURIComponent("This server only issues tokens for http://other/mcp.")}` });
    if (route === "/oauth/mcp/approval") return auth === "Bearer gateway" ? Response.json({ csrfToken: "csrf" }) : Response.json({ clientName: "Threebot" });
    if (route === "/oauth/mcp/decision") {
      assert.equal(body.decision.csrfToken, "csrf");
      return Response.json({ redirectTo: `${body.authorization.redirect_uri}?code=code-${issued + 1}&state=${body.authorization.state}` });
    }
    if (route === "/oauth/mcp/token") {
      assert.ok(body.code_verifier && body.code === `code-${issued + 1}`);
      issued++;
      return Response.json({ access_token: `mcp-${issued}`, token_type: "Bearer", expires_in: 2592000, scope: "orchestration:read orchestration:operate" });
    }
    if (route === "/mcp") {
      if (expireFirst && auth === "Bearer mcp-1") return new Response("", { status: 401 });
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "mcp-session-id": "session-1" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.params.name === "t3_thread_read" && body.params.arguments.threadId === "missing") return Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ message: "Thread not found." }) }] } });
      // T3 may answer a call as one server-sent event.
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ echoed: body.params }) }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetcher };
}

test("the gateway approves its own MCP client once, keeps it private and calls tools with it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-"));
  try {
    const t3 = fakeT3();
    const file = path.join(root, "machines", "t3-mcp.json");
    const mcp = createT3Mcp({ baseUrl: "http://t3.test", token: "gateway", file, fetcher: t3.fetcher });
    const result = await mcp.call("t3_thread_list", { environmentId: "peer", limit: 1 });
    assert.deepEqual(result.echoed, { name: "t3_thread_list", arguments: { environmentId: "peer", limit: 1 } });
    // The gateway's own bearer only goes to the approval steps, never to registration, the code swap or /mcp.
    for (const call of t3.calls) assert.equal(call.auth === "Bearer gateway", ["/oauth/mcp/approval", "/oauth/mcp/decision"].includes(call.route), call.route);
    assert.ok(t3.calls.filter((call) => call.route === "/mcp").every((call) => call.auth === "Bearer mcp-1"));
    assert.equal(t3.calls.find((call) => call.route === "/oauth/mcp/decision")!.body.decision.access, "auto");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, "utf8")).accessToken, "mcp-1");
    // A second client reuses the stored credential instead of signing in again.
    const again = createT3Mcp({ baseUrl: "http://t3.test", token: "gateway", file, fetcher: t3.fetcher });
    await again.call("t3_thread_list", {});
    assert.equal(t3.calls.filter((call) => call.route === "/oauth/mcp/register").length, 1);
    await assert.rejects(mcp.call("t3_thread_read", { threadId: "missing" }), /Thread not found/);
  } finally { await rm(root, { recursive: true }); }
});

test("a refused MCP credential is replaced by a fresh sign-in", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-"));
  try {
    const t3 = fakeT3({ expireFirst: true });
    const mcp = createT3Mcp({ baseUrl: "http://t3.test", token: "gateway", file: path.join(root, "t3-mcp.json"), fetcher: t3.fetcher });
    assert.ok((await mcp.call("t3_thread_list", {})).echoed);
    assert.equal(t3.calls.filter((call) => call.route === "/oauth/mcp/token").length, 2);
  } finally { await rm(root, { recursive: true }); }
});

test("a gateway token that can't approve gets a plain explanation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-"));
  try {
    const t3 = fakeT3();
    const mcp = createT3Mcp({ baseUrl: "http://t3.test", token: "read-only", file: path.join(root, "t3-mcp.json"), fetcher: t3.fetcher });
    await assert.rejects(mcp.call("t3_thread_list", {}), (error: Error & { status?: number }) => error.status === 403 && /access:write/.test(error.message));
  } finally { await rm(root, { recursive: true }); }
});

test("T3's own reason comes through when it sends the sign-in back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-"));
  try {
    const t3 = fakeT3();
    const mcp = createT3Mcp({ baseUrl: "http://t3.test/", token: "gateway", file: path.join(root, "t3-mcp.json"), fetcher: (url, init) => t3.fetcher(url, init) });
    assert.ok((await mcp.call("t3_thread_list", {})).echoed, "a trailing slash still names the right resource");
    const elsewhere = createT3Mcp({ baseUrl: "http://t3.test:1", token: "gateway", file: path.join(root, "other.json"), fetcher: t3.fetcher });
    await assert.rejects(elsewhere.call("t3_thread_list", {}), /T3 refused the gateway's sign-in: This server only issues tokens/);
  } finally { await rm(root, { recursive: true }); }
});
