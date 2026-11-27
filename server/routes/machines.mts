// Machine & remote thread routes: /api/machines*, /api/thread-link.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRouter, type SendFn } from "./router.mts";
import type { EventStream } from "./events.mts";
import type { EnvironmentTarget } from "../environment-routes.mts";
import type { Machine } from "../machines.mts";
import { T3ToolError } from "../t3-mcp.mts";

export function createMachineRoutes({
  machines,
  machineFor,
  readLinkedThread,
  t3McpCall,
  resolveEnvironment,
  resolveThreadLink,
  events,
  send,
  readBody,
  requireJson,
}: {
  machines: {
    list: (opts?: { maxAge?: number }) => Promise<{ machines: Machine[]; linksSupported: boolean }>;
    pair: (environmentId: string, code: string, url?: string) => Promise<{ baseUrl: string } & Record<string, unknown>>;
    unpair: (environmentId: string) => Promise<unknown>;
  };
  machineFor: (environmentId: string) => Promise<Machine>;
  readLinkedThread: (environmentId: string, threadId: string, after: number | null) => Promise<unknown>;
  t3McpCall: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  resolveEnvironment: (environmentId: string) => Promise<EnvironmentTarget>;
  resolveThreadLink: (ref: { environmentId: string; threadId: string }) => Promise<string>;
  events: EventStream;
  send: SendFn;
  readBody: (req: IncomingMessage, limit?: number) => Promise<any>;
  requireJson: (req: IncomingMessage) => void;
}) {
  const router = createRouter();

  router.get("/api/machines", async ({ res, url }) => {
    const { machines: list, linksSupported } = await machines.list({ maxAge: url.searchParams.get("fresh") === "1" ? 0 : 15_000 });
    return send(res, 200, { machines: list, linksSupported }, { "cache-control": "no-store" });
  });

  router.post(/^\/api\/machines\/([a-zA-Z0-9_-]{1,128})\/pair$/, async ({ req, res, match }) => {
    requireJson(req);
    const body = await readBody(req, 8192);
    const paired = await machines.pair(match![1], body?.code, typeof body?.url === "string" && body.url ? body.url : undefined);
    console.log(`machines: paired ${match![1]} directly at ${new URL(paired.baseUrl).host}`);
    events.emit("machines", { action: "paired", environmentId: match![1] });
    return send(res, 200, paired);
  });

  router.delete(/^\/api\/machines\/([a-zA-Z0-9_-]{1,128})\/pair$/, async ({ res, match }) => {
    const result = await machines.unpair(match![1]);
    events.emit("machines", { action: "unpaired", environmentId: match![1] });
    return send(res, 200, result);
  });

  router.any(/^\/api\/machines\/([a-zA-Z0-9_-]{1,128})\/threads\/([\w:.-]{1,256})(\/messages)?$/, async ({ req, res, url, match }) => {
    const [, environmentId, threadId, messages] = match!;
    const machine = await machineFor(environmentId);
    if (machine.route === "none") return send(res, 409, { error: `The link to ${machine.label} has expired. Link it again in T3 Code.` });
    try {
      if (!messages && req.method === "GET") {
        const after = url.searchParams.get("after");
        return send(res, 200, { machine, read: await readLinkedThread(environmentId, threadId, after !== null && /^\d{1,9}$/.test(after) ? Number(after) : null) }, { "cache-control": "no-store" });
      }
      if (messages && req.method === "POST") {
        requireJson(req);
        const text = String((await readBody(req, 256 * 1024))?.text ?? "").trim();
        if (!text) return send(res, 400, { error: "Write a message first" });
        return send(res, 200, await t3McpCall("t3_thread_send", { environmentId, threadId, message: text, mode: "auto", clientRequestId: randomUUID() }));
      }
    } catch (error) {
      if (error instanceof T3ToolError) return send(res, machine.status === "online" ? error.status : 503, { error: machine.status === "online" ? error.message : `${machine.label} isn't reachable right now${machine.status === "asleep" ? " (it's asleep)" : ""}.` });
      throw error;
    }
    return send(res, 405, { error: "method not allowed" });
  });

  router.get("/api/thread-link", async ({ res, url }) => {
    const environmentId = url.searchParams.get("environmentId") ?? "";
    const threadId = url.searchParams.get("threadId") ?? "";
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId) || !/^[\w:%.-]{1,1024}$/.test(threadId)) return send(res, 400, { error: "Invalid thread reference" });
    // Machines the gateway can reach (paired, configured, or linked in T3) stay inside the app;
    // anything else keeps the existing T3 handoff.
    const reachable = await resolveEnvironment(environmentId).then(() => true, () => false)
      || (await machines.list().catch(() => null))?.machines.some((machine) => machine.environmentId === environmentId && !machine.local && machine.route !== "none");
    if (reachable) {
      res.writeHead(302, { location: `/?environment=${encodeURIComponent(environmentId)}&thread=${encodeURIComponent(threadId)}`, "cache-control": "no-store" });
      return res.end();
    }
    const href = await resolveThreadLink({ environmentId, threadId });
    res.writeHead(302, { location: href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    return res.end();
  });

  return { handle: router.handle };
}
