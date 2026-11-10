import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createProjects, detail, find, overview, type ProjectsError, type ProjectsEvent } from "./projects.mts";
import { PROJECT_TOOLS, createProjectTools, type ToolResult } from "./projects-mcp.mts";
import { createBotTools, handleMcpHttp } from "./vault-mcp.mts";
import { createProjectRoutes, sameOrigin } from "./projects-routes.mts";

const bot = { type: "bot", name: "Ops", slug: "ops" };
async function board() {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-"));
  let tick = 0;
  const store = createProjects({ file: path.join(dir, "projects.json"), now: () => new Date(Date.UTC(2026, 10, 3, 9, 0, tick++)).toISOString() });
  return { store, dir, file: path.join(dir, "projects.json"), done: () => rm(dir, { recursive: true, force: true }) };
}

test("a project and its to-dos are created in one batch with refs, defaults and authorship", async () => {
  const { store, file, done } = await board();
  const events: ProjectsEvent[] = [];
  store.subscribe((event) => events.push(event));
  const { items } = await store.save([
    { ref: "nas", kind: "machine", title: "NAS" },
    { ref: "tb", kind: "project", title: "Threebot", area: "Personal" },
    { kind: "task", title: "Ship the projects page", parentId: "ref:tb", fields: { priority: "high", due: "2026-11-05" } },
    { kind: "service", title: "bot-gateway", machineId: "ref:nas", parentId: "ref:tb", fields: { port: "3780" }, addLinks: [{ type: "thread", threadId: "t-1" }, { type: "thread", threadId: "t-1" }] },
  ], bot);
  const [nas, tb, task, svc] = items;
  assert.equal(nas.status, "unknown");
  assert.equal(tb.status, "active");
  assert.equal(tb.area, "personal");
  assert.equal(task.status, "todo");
  assert.equal(task.parentId, tb.id);
  assert.equal(svc.machineId, nas.id);
  assert.equal(svc.fields.port, 3780);
  assert.equal(svc.links.length, 1, "duplicate links collapse");
  assert.deepEqual(task.createdBy, bot);
  assert.match(nas.id, /^[a-z0-9]{8}$/);
  assert.equal(events.length, 1);
  assert.equal(events[0].activity.length, 4);
  assert.equal((events[0].activity[0].actor as { name?: string }).name, "Ops");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Object.keys(saved.items).length, 4);
  assert.equal(saved.version, 1);
  await done();
});

test("patches only change what they name, null clears, and done to-dos record when", async () => {
  const { store, done } = await board();
  const [task] = (await store.save([{ kind: "task", title: "Renew domain", body: "Before the 9th", fields: { tags: ["Admin", "admin", "web"] } }], { type: "user" })).items;
  assert.deepEqual(task.fields.tags, ["admin", "web"]);
  const [after] = (await store.save([{ id: task.id, status: "done", fields: { tags: null, url: "https://example.com/renew" } }], bot)).items;
  assert.equal(after.title, "Renew domain");
  assert.equal(after.body, "Before the 9th");
  assert.equal(after.fields.tags, undefined);
  assert.equal(after.fields.url, "https://example.com/renew");
  assert.ok(after.doneAt);
  assert.deepEqual(after.updatedBy, bot);
  const activity = await store.activity();
  assert.equal(activity.at(-1)!.action, "completed");
  const [reopened] = (await store.save([{ id: task.id, status: "todo" }], { type: "user" })).items;
  assert.equal(reopened.doneAt, undefined);
  const unchanged = await store.save([{ id: task.id, status: "todo" }], { type: "user" });
  assert.equal(unchanged.unchanged, true);
  await done();
});

test("bad input is refused with a plain reason and leaves the board as it was", async () => {
  const { store, done } = await board();
  const [project] = (await store.save([{ kind: "project", title: "Home" }], { type: "user" })).items;
  const rejects = async (items: unknown[], pattern: RegExp) => assert.rejects(store.save(items, bot), (error: ProjectsError) => error.status === 400 && pattern.test(error.message));
  await rejects([{ kind: "task" }], /needs a title/);
  await rejects([{ kind: "spaceship", title: "x" }], /kind must be/);
  await rejects([{ kind: "task", title: "x", status: "active" }], /status is one of todo/);
  await rejects([{ kind: "task", title: "x", fields: { colour: "red" } }], /Unknown field "colour"/);
  await rejects([{ kind: "task", title: "x", fields: { url: "javascript:alert(1)" } }], /http/);
  await rejects([{ kind: "task", title: "x", fields: { due: "tomorrow" } }], /date like/);
  await rejects([{ kind: "task", title: "x", parentId: "ref:nope" }], /doesn't name an item/);
  await rejects([{ kind: "service", title: "x", machineId: project.id }], /must point at a machine/);
  await rejects([{ id: "missing1", title: "x" }], /no item "missing1"/);
  await rejects([{ kind: "task", title: "ok" }, { kind: "task" }], /needs a title/);
  await rejects([{ id: project.id, parentId: project.id }], /its own parent/);
  const [child] = (await store.save([{ kind: "project", title: "Garden", parentId: project.id }], { type: "user" })).items;
  await rejects([{ id: project.id, parentId: child.id }], /inside itself/);
  const items = await store.list();
  assert.equal(items.length, 2, "the half-valid batch saved nothing");
  assert.equal(items.find((item) => item.id === project.id)!.parentId, undefined);
  await done();
});

test("deleting moves children up and drops links to the deleted item", async () => {
  const { store, done } = await board();
  const { items } = await store.save([
    { ref: "a", kind: "project", title: "Work" },
    { ref: "b", kind: "project", title: "Launch", parentId: "ref:a" },
    { ref: "m", kind: "machine", title: "Air" },
    { kind: "task", title: "Write post", parentId: "ref:b", addLinks: [{ type: "item", id: "ref:m" }] },
    { kind: "repo", title: "threebot", machineId: "ref:m" },
  ], { type: "user" });
  const events: ProjectsEvent[] = [];
  store.subscribe((event) => events.push(event));
  await store.remove([items[1].id, items[2].id], bot);
  const left = await store.list();
  const task = left.find((item) => item.title === "Write post")!;
  assert.equal(task.parentId, items[0].id);
  assert.deepEqual(task.links, []);
  assert.equal(left.find((item) => item.title === "threebot")!.machineId, undefined);
  assert.deepEqual(events[0].removed.sort(), [items[1].id, items[2].id].sort());
  assert.equal(events[0].activity.every((entry) => entry.action === "deleted"), true);
  await done();
});

test("concurrent saves from two Bots both land", async () => {
  const { store, done } = await board();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.save([{ kind: "task", title: `Task ${i}` }], i % 2 ? bot : { type: "user" })));
  assert.equal((await store.list()).length, 20);
  assert.equal((await store.snapshot()).version, 20);
  await done();
});

test("a fresh store reads what an earlier one wrote", async () => {
  const { store, file, done } = await board();
  await store.save([{ kind: "note", title: "Wifi is on the fridge" }], { type: "user" });
  const again = createProjects({ file });
  assert.equal((await again.list())[0].title, "Wifi is on the fridge");
  await done();
});

test("the overview, find and detail views give agents ids, links and placement", async () => {
  const { store, done } = await board();
  const { items } = await store.save([
    { ref: "p", kind: "project", title: "Threebot", area: "personal" },
    { ref: "m", kind: "machine", title: "NAS", status: "online" },
    { kind: "task", title: "Low thing", parentId: "ref:p", fields: { priority: "low" } },
    { kind: "task", title: "Urgent thing", parentId: "ref:p", fields: { priority: "high" } },
    { kind: "task", title: "Finished", parentId: "ref:p", status: "done" },
    { kind: "service", title: "bot-gateway", machineId: "ref:m", addLinks: [{ type: "thread", threadId: "thread-9" }] },
    { kind: "repo", title: "threebot-source", machineId: "ref:m", fields: { path: "/mnt/apps/t3/projects/threebot-source" } },
  ], bot);
  const all = await store.list();
  const view = overview(all, await store.activity(), { appUrl: "https://bot.example" });
  assert.equal(view.projects[0].openTasks, 2);
  assert.deepEqual(view.openTasks.map((t) => t.title), ["Urgent thing", "Low thing"]);
  assert.equal(view.openTasks[0].project, "Threebot");
  assert.equal(view.machines[0].services[0].title, "bot-gateway");
  assert.equal(view.machines[0].repos[0].title, "threebot-source");
  assert.equal(view.page, "https://bot.example/?page=projects");
  assert.equal(view.recent[0].who, "Ops");
  assert.match(view.openTasks[0].link, /^https:\/\/bot\.example\/\?item=[a-z0-9]{8}$/);
  assert.deepEqual(find(all, { search: "source mnt" }).items.map((i) => i.title), ["threebot-source"]);
  assert.deepEqual(find(all, { kind: "task", open: true }).items.map((i) => i.title).sort(), ["Low thing", "Urgent thing"]);
  assert.deepEqual(find(all, { threadId: "thread-9" }).items.map((i) => i.title), ["bot-gateway"]);
  const machine = detail(all, items[1].id);
  assert.deepEqual(machine!.onThisMachine!.map((i) => i.title).sort(), ["bot-gateway", "threebot-source"]);
  assert.equal(detail(all, items[0].id)!.children.length, 3);
  await done();
});

test("Bots reach the board through the bot MCP server, and their saves carry their name", async () => {
  const { store, done } = await board();
  const findBotByThread = async (threadId: string) => (threadId === "main-ops" ? { slug: "ops", name: "Ops", mainThreadId: "main-ops" } : null);
  const tools = createBotTools({ vault: {} as Parameters<typeof createBotTools>[0]["vault"], findBotByThread, listTabs: async () => [], typeIntoTab: async () => {}, extra: { tools: PROJECT_TOOLS, call: createProjectTools({ projects: store, appUrl: "https://bot.example" }), instructions: "Projects too." } });
  const list = await tools.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const name of ["projects_overview", "projects_find", "projects_get", "projects_save", "projects_delete", "vault_list"]) assert.ok((list!.result as { tools: { name: string }[] }).tools.some((tool) => tool.name === name), name);
  const init = await tools.handleRpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  assert.match((init!.result as { instructions: string }).instructions, /Projects too\./);
  const call = (name: string, args: Record<string, unknown>) => tools.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }).then((r) => r!.result as ToolResult);
  const refused = await call("projects_save", { items: [{ kind: "task", title: "x" }], threadId: "someone-else" });
  assert.equal(refused.isError, true);
  const saved = await call("projects_save", { items: [{ kind: "task", title: "Book dentist", area: "personal" }], threadId: "main-ops" });
  const out = JSON.parse(saved.content[0].text);
  assert.equal(out.saved[0].title, "Book dentist");
  assert.match(out.saved[0].link, /^https:\/\/bot\.example\/\?item=/);
  assert.deepEqual((await store.list())[0].createdBy, { type: "bot", name: "Ops", slug: "ops" });
  const bad = await call("projects_save", { items: [{ kind: "task", title: "y", status: "nope" }], threadId: "main-ops" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /status is one of/);
  const got = JSON.parse((await call("projects_get", { id: out.saved[0].id })).content[0].text);
  assert.equal(got.title, "Book dentist");
  const overviewOut = JSON.parse((await call("projects_overview", {})).content[0].text);
  assert.equal(overviewOut.openTasks.length, 1);
  await done();
});

type FakeResponse = {
  status: number;
  headers: Record<string, unknown> | undefined;
  chunks: string[];
  ended: boolean;
  listeners: Record<string, () => void>;
  writeHead(status: number, headers?: Record<string, unknown>): void;
  write(chunk: unknown): boolean;
  end(body?: unknown): void;
  on(event: string, fn: () => void): void;
};
type FakeRequest = { method: string; headers: IncomingHttpHeaders; body: unknown; on(event: string, fn: () => void): void; close(): void };
function fakeResponse() {
  // The methods are added just below.
  const res = { status: 0, headers: {}, chunks: [] as string[], ended: false, listeners: {} } as FakeResponse;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = (body) => { if (body !== undefined) res.chunks.push(String(body)); res.ended = true; };
  res.on = (event, fn) => { res.listeners[event] = fn; };
  return res;
}
const send = (res: FakeResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, headers); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
function fakeRequest({ method = "GET", headers = {}, body }: { method?: string; headers?: IncomingHttpHeaders; body?: unknown } = {}): FakeRequest {
  const listeners: Record<string, () => void> = {};
  return { method, headers: { host: "bot.example", ...headers }, body, on: (event, fn) => { listeners[event] = fn; }, close: () => listeners.close?.() };
}

test("the page's routes save as the user, refuse other websites and stream every change live", async () => {
  const { store, done } = await board();
  const routes = createProjectRoutes({ projects: store, send, readBody: async (req: FakeRequest) => req.body, requireJson: () => {}, heartbeatMs: 60_000 });
  const url = (p: string) => new URL(`http://x${p}`);
  const stream = fakeResponse();
  const streamReq = fakeRequest();
  assert.equal(await routes.handle(streamReq, stream, url("/api/projects/events")), true);
  assert.equal(stream.headers!["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(routes.streamCount(), 1);

  const foreign = fakeResponse();
  await routes.handle(fakeRequest({ method: "POST", headers: { origin: "https://evil.example" }, body: { items: [{ kind: "task", title: "x" }] } }), foreign, url("/api/projects/items"));
  assert.equal(foreign.status, 403);

  const ok = fakeResponse();
  await routes.handle(fakeRequest({ method: "POST", headers: { origin: "https://bot.example" }, body: { items: [{ kind: "task", title: "From the page" }] } }), ok, url("/api/projects/items"));
  assert.equal(ok.status, 200);
  const change = stream.chunks.find((chunk) => chunk.startsWith("event: change"));
  assert.ok(change, "the open stream got the change");
  assert.equal(JSON.parse(change.split("data: ")[1]).items[0].title, "From the page");

  await store.save([{ kind: "task", title: "From a Bot" }], bot);
  const fromBot = stream.chunks.filter((chunk) => chunk.startsWith("event: change")).at(-1);
  assert.equal(JSON.parse(fromBot!.split("data: ")[1]).activity[0].actor.name, "Ops");

  const invalid = fakeResponse();
  await routes.handle(fakeRequest({ method: "POST", headers: { origin: "https://bot.example" }, body: { items: [{ kind: "task" }] } }), invalid, url("/api/projects/items"));
  assert.equal(invalid.status, 400);
  assert.match(JSON.parse(invalid.chunks.join("")).error, /needs a title/);

  const snapshot = fakeResponse();
  await routes.handle(fakeRequest(), snapshot, url("/api/projects"));
  assert.equal(JSON.parse(snapshot.chunks.join("")).items.length, 2);

  streamReq.close();
  assert.equal(routes.streamCount(), 0);
  assert.equal(await routes.handle(fakeRequest(), fakeResponse(), url("/api/other")), false);
  await done();
});

test("same-origin checks accept the app behind a proxy and refuse cross-site writes", () => {
  assert.equal(sameOrigin({ headers: { host: "bot.example", origin: "https://bot.example" } }), true);
  assert.equal(sameOrigin({ headers: { host: "127.0.0.1:3781", "x-forwarded-host": "nas.tailnet.ts.net:8443", origin: "https://nas.tailnet.ts.net:8443" } }), true);
  assert.equal(sameOrigin({ headers: { host: "bot.example", origin: "https://bot.example.evil.test" } }), false);
  assert.equal(sameOrigin({ headers: { host: "bot.example", origin: "null" } }), false);
  assert.equal(sameOrigin({ headers: { host: "bot.example", "sec-fetch-site": "cross-site" } }), false);
});

test("the Bot tool server still only answers local callers", async () => {
  const res = fakeResponse();
  await handleMcpHttp({ headers: { "cf-ray": "1" }, socket: { remoteAddress: "127.0.0.1" }, method: "POST" } as unknown as IncomingMessage, res as unknown as ServerResponse, { tools: {} as Parameters<typeof handleMcpHttp>[2]["tools"], resolveAuth: async () => ({ botSlug: null, legacy: true }), readBody: async () => ({}) });
  assert.equal(res.status, 403);
});
