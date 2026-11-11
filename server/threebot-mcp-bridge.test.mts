import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("the stdio bridge exposes a Bot's HTTP MCP tools and forwards calls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "threebot-bridge-"));
  const bot = path.join(root, "bots", "alpha");
  await mkdir(path.join(bot, ".bot"), { recursive: true });
  await writeFile(path.join(bot, ".bot", "bot.json"), JSON.stringify({ name: "Alpha" }));
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    if (message.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (message.method === "tools/list") return reply({ tools: [{ name: "vault_list", description: "List Vault items", inputSchema: { type: "object" } }] });
    if (message.method === "tools/call") return reply({ content: [{ type: "text", text: JSON.stringify({ called: message.params.name }) }] });
    return reply({});
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`;
  await writeFile(path.join(bot, ".mcp.json"), JSON.stringify({ mcpServers: { bot: { url, headers: { Authorization: "Bearer test" } } } }));
  const child = spawn(process.execPath, [new URL("./threebot-mcp-bridge.mts", import.meta.url).pathname], { cwd: bot, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bot__vault_list", arguments: { scope: "bot" } } }) + "\n");
    const deadline = Date.now() + 10_000;
    while (lines.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(lines.length >= 3, `bridge answered (${lines.length})`);
    const messages = lines.map((line) => JSON.parse(line));
    assert.equal(messages.find((message) => message.id === 2)?.result.tools[0].name, "bot__vault_list");
    assert.deepEqual(JSON.parse(messages.find((message) => message.id === 3)?.result.content[0].text), { called: "vault_list" });
  } finally {
    child.kill();
    await once(child, "exit").catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
