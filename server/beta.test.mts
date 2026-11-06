import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { betaSettings, boardHasItems, patchBeta, settleBetaDefaults } from "./beta.mts";
import { createProjects } from "./projects.mts";
import { PROJECT_TOOLS, createProjectTools } from "./projects-mcp.mts";
import { createProjectRoutes } from "./projects-routes.mts";
import { createBotTools } from "./vault-mcp.mts";
import { renderAgentsMd } from "./bot-template.mts";

async function dir() {
  const d = await mkdtemp(path.join(tmpdir(), "beta-"));
  return { d, file: path.join(d, "projects.json"), done: () => rm(d, { recursive: true, force: true }) };
}

test("a new install starts with the Projects board off", async () => {
  const { file, done } = await dir();
  assert.deepEqual(await settleBetaDefaults(undefined, { projectsFile: file }), { beta: { projects: false } });
  assert.deepEqual(await settleBetaDefaults({ userName: "Sam" }, { projectsFile: file }), { userName: "Sam", beta: { projects: false } });
  await writeFile(file, JSON.stringify({ version: 3, items: {} }));
  assert.equal((await settleBetaDefaults({}, { projectsFile: file })).beta.projects, false, "an empty board doesn't count");
  await done();
});

test("an existing install with a non-empty board keeps it on", async () => {
  const { file, done } = await dir();
  const store = createProjects({ file });
  await store.save([{ kind: "task", title: "Renew the domain" }], { type: "user" });
  assert.equal(await boardHasItems(file), true);
  const settled = await settleBetaDefaults({ userName: "Sam", theme: "dark" }, { projectsFile: file });
  assert.deepEqual(settled, { userName: "Sam", theme: "dark", beta: { projects: true } });
  // A damaged board is not hidden.
  await writeFile(file, "{ not json");
  assert.equal(await boardHasItems(file), true);
  await done();
});

test("once the switch has been set, the default never overrides it and the board file is kept", async () => {
  const { file, done } = await dir();
  await createProjects({ file }).save([{ kind: "task", title: "x" }], { type: "user" });
  assert.equal(await settleBetaDefaults({ beta: { projects: false } }, { projectsFile: file }), null);
  assert.equal(await settleBetaDefaults({ beta: { projects: true } }, { projectsFile: file }), null);
  assert.match(await readFile(file, "utf8"), /"title":"x"/);
  await done();
});

test("the toggle round-trips and refuses anything but known booleans", () => {
  let saved = betaSettings(undefined);
  assert.deepEqual(saved, { projects: false });
  saved = patchBeta(saved, { projects: true });
  assert.deepEqual(betaSettings(saved), { projects: true });
  saved = patchBeta(saved, { projects: false });
  assert.deepEqual(betaSettings(saved), { projects: false });
  assert.deepEqual(betaSettings({ projects: "yes", other: true }), { projects: false });
  assert.throws(() => patchBeta(saved, { projects: "on" }), (e) => e.status === 400);
  assert.throws(() => patchBeta(saved, { nope: true }), (e) => e.status === 400);
  assert.throws(() => patchBeta(saved, null), (e) => e.status === 400);
});

function fakeResponse() {
  const res = { status: 0, chunks: [], ended: false };
  res.writeHead = (status) => { res.status = status; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = (body) => { if (body !== undefined) res.chunks.push(String(body)); res.ended = true; };
  res.on = () => {};
  return res;
}
const send = (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
const fakeRequest = ({ method = "GET", body } = {}) => ({ method, headers: { host: "bot.example", origin: "https://bot.example" }, body, on: () => {} });

test("switched off, every /api/projects route is a 404; on, they work again without a restart", async () => {
  const { file, done } = await dir();
  let on = false;
  const routes = createProjectRoutes({ projects: createProjects({ file }), send, readBody: async (r) => r.body, requireJson: () => {}, heartbeatMs: 60_000, enabled: async () => on });
  const url = (p) => new URL(`http://x${p}`);
  for (const [method, p, body] of [["GET", "/api/projects"], ["GET", "/api/projects/events"], ["POST", "/api/projects/items", { items: [{ kind: "task", title: "x" }] }], ["POST", "/api/projects/delete", { ids: [] }]]) {
    const res = fakeResponse();
    assert.equal(await routes.handle(fakeRequest({ method, body }), res, url(p)), true);
    assert.equal(res.status, 404, `${method} ${p}`);
  }
  assert.equal(await routes.handle(fakeRequest(), fakeResponse(), url("/api/other")), false);
  on = true;
  const ok = fakeResponse();
  await routes.handle(fakeRequest(), ok, url("/api/projects"));
  assert.equal(ok.status, 200);
  const stream = fakeResponse();
  await routes.handle(fakeRequest(), stream, url("/api/projects/events"));
  assert.equal(routes.streamCount(), 1);
  routes.closeStreams();
  assert.equal(routes.streamCount(), 0);
  assert.equal(stream.ended, true, "switching off ends open live streams");
  await done();
});

test("switched off, projects_* tools are neither listed nor callable; the Vault tools still are", async () => {
  const { file, done } = await dir();
  let on = false;
  const store = createProjects({ file });
  const extra = { tools: PROJECT_TOOLS, call: createProjectTools({ projects: store, appUrl: "https://bot.example" }), instructions: "Projects too." };
  const vault = { list: async () => [{ id: "c1", type: "contact", name: "Sam" }] };
  const tools = createBotTools({ vault, findBotByThread: async () => ({ slug: "ops", name: "Ops", mainThreadId: "t" }), listTabs: async () => [], typeIntoTab: async () => {}, extra: async () => (on ? extra : null) });
  const names = async () => (await tools.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
  const call = (name, args = {}) => tools.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const init = async () => (await tools.handleRpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })).result.instructions;

  assert.ok(!(await names()).some((n) => n.startsWith("projects_")));
  assert.ok((await names()).includes("vault_list"));
  assert.doesNotMatch(await init(), /Projects too/);
  const refused = await call("projects_overview");
  assert.equal(refused.error.code, -32602);
  assert.match(refused.error.message, /Unknown tool: projects_overview/);
  const vaultOut = await call("vault_list", { threadId: "t" });
  assert.notEqual(vaultOut.result.isError, true);
  assert.match(vaultOut.result.content[0].text, /Sam/);

  on = true;
  for (const n of PROJECT_TOOLS.map((t) => t.name)) assert.ok((await names()).includes(n), n);
  assert.match(await init(), /Projects too/);
  assert.equal((await call("projects_overview")).result.isError, undefined);
  await done();
});

test("the Bot instructions carry the Projects board section only while the beta is on", () => {
  const render = (beta) => renderAgentsMd({ bot: { name: "Ops", slug: "ops", projectId: "p", mainThreadId: "t" }, settings: { userName: "Sam", beta }, botsRoot: "/bots" });
  const off = render({ projects: false });
  assert.doesNotMatch(off, /Projects board|projects_|the board/i);
  assert.match(off, /## Running other threads[\s\S]*\n\n## Other Bots/, "sections stay separated by one blank line");
  assert.doesNotMatch(render(undefined), /Projects board/);
  const on = render({ projects: true });
  assert.match(on, /## Projects board\n- Sam's Projects page is a live board/);
  assert.match(on, /Keep it true without being asked/);
  assert.match(on, /\n\n## Projects board[\s\S]*Don't put secrets on the board; they belong in the Vault\.\n\n## Other Bots/);
});
