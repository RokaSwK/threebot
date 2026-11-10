#!/usr/bin/env node
// A small stdio MCP server for harnesses that do not load a project's MCP config.
// It reads the Bot's own `.mcp.json` from the working directory and exposes every HTTP
// server there as `server__tool` (for example `bot__memory_read`). The gateway still sees the
// Bot's bearer, so identity, evidence, revisions and tombstones are enforced exactly as usual.
//
// Antigravity can load this once from ~/.gemini/config/mcp_config.json; Pi can point at it from
// a user or project mcp.json. It never prints the bearer.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type Headers = Record<string, string>;
type Server = { name: string; url: string; headers: Headers };
type Tool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>; outputSchema?: Record<string, unknown> };
type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

const PROTOCOL = "2025-06-18";

function findConfig(start: string): string | null {
  let current = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, ".mcp.json");
    // Only a Bot workspace gets the bridge. A normal T3 project with a .mcp.json is not ours.
    if (existsSync(candidate) && existsSync(path.join(current, ".bot", "bot.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function serversFromConfig(file: string): Server[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, any> };
    return Object.entries(raw.mcpServers ?? {}).flatMap(([name, value]) => {
      if (!value || typeof value !== "object" || typeof value.url !== "string") return [];
      const headers = value.headers && typeof value.headers === "object" ? Object.fromEntries(Object.entries(value.headers).filter(([, header]) => typeof header === "string")) as Headers : {};
      return [{ name, url: value.url, headers }];
    });
  } catch {
    return [];
  }
}

function parseBody(body: string, contentType: string): Rpc {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      const value = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!value) continue;
      try {
        const parsed = JSON.parse(value) as Rpc;
        if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) return parsed;
      } catch { /* keep scanning */ }
    }
    throw new Error("MCP returned an empty event stream");
  }
  return JSON.parse(body) as Rpc;
}

class HttpMcp {
  private session: string | null = null;
  private initialized = false;
  private server: Server;
  constructor(server: Server) { this.server = server; }

  private async post(method: string, params: unknown, id: number | string | null): Promise<Rpc> {
    const response = await fetch(this.server.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        ...this.server.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.session = session;
    const text = await response.text();
    if (!response.ok) throw new Error(`${this.server.name}: HTTP ${response.status}`);
    if (!text.trim()) return { jsonrpc: "2.0", id, result: undefined };
    const parsed = parseBody(text, response.headers.get("content-type") ?? "");
    if (parsed.error) throw new Error(`${this.server.name}: ${parsed.error.message}`);
    return parsed;
  }

  async connect(): Promise<void> {
    if (this.initialized) return;
    await this.post("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "threebot-bridge", version: "1.0.0" } }, 1);
    await this.post("notifications/initialized", {}, null).catch(() => {});
    this.initialized = true;
  }

  async tools(): Promise<Tool[]> {
    await this.connect();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.post("tools/list", cursor ? { cursor } : {}, 2);
      const result = response.result as { tools?: Tool[]; nextCursor?: string } | undefined;
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
    } while (cursor);
    return tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const response = await this.post("tools/call", { name, arguments: args }, 3);
    return response.result;
  }
}

function write(message: Rpc): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main(): Promise<void> {
  const config = findConfig(process.env.THREEBOT_BOT_DIR ?? process.cwd());
  const servers = config ? serversFromConfig(config) : [];
  const clients = new Map(servers.map((server) => [server.name, new HttpMcp(server)]));
  let buffer = "";

  async function handle(message: Rpc): Promise<void> {
    const id = message.id ?? null;
    try {
      if (message.method === "initialize") {
        write({ jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "threebot", version: "1.0.0" } } });
        return;
      }
      if (message.method === "notifications/initialized") return;
      if (message.method === "ping") {
        write({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (message.method === "tools/list") {
        const tools: Tool[] = [];
        for (const [server, client] of clients) {
          try {
            for (const tool of await client.tools()) tools.push({ ...tool, name: `${server}__${tool.name}`, description: `[${server}] ${tool.description ?? ""}`.trim() });
          } catch { /* a broken server must not hide the others */ }
        }
        write({ jsonrpc: "2.0", id, result: { tools } });
        return;
      }
      if (message.method === "tools/call") {
        const name = String(message.params?.name ?? "");
        const split = name.indexOf("__");
        const server = split > 0 ? name.slice(0, split) : "";
        const tool = split > 0 ? name.slice(split + 2) : "";
        const client = clients.get(server);
        if (!client || !tool) {
          write({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${name}` } });
          return;
        }
        const result = await client.call(tool, message.params?.arguments ?? {});
        write({ jsonrpc: "2.0", id, result });
        return;
      }
      if (id !== null) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    } catch (error) {
      if (id !== null) write({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "Bridge failed" } });
    }
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as Rpc;
          if (Array.isArray(message)) { for (const item of message) void handle(item); }
          else void handle(message);
        } catch { /* ignore malformed lines */ }
      }
      newline = buffer.indexOf("\n");
    }
  });
}

void main();
