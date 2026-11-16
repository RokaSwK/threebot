import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IncomingHttpHeaders } from "node:http";
import { createRooms } from "./rooms.mts";
import { createRoomRoutes } from "./rooms-routes.mts";
import type { RoomEngine } from "./room-turn.mts";

type FakeResponse = { status: number; body: unknown; headers: Record<string, string> };
type FakeRequest = { method: string; headers: IncomingHttpHeaders; body: unknown };

const send = (res: FakeResponse, status: number, body: unknown) => { res.status = status; res.body = body; };
const request = ({ method = "GET", body, origin = "https://bot.example", json = true }: { method?: string; body?: unknown; origin?: string | null; json?: boolean } = {}): FakeRequest => ({
  method,
  body,
  headers: { host: "bot.example", ...(origin ? { origin } : {}), ...(json ? { "content-type": "application/json" } : {}) },
});

const bots = [
  { slug: "alpha", name: "Alpha", label: "First", color: "teal", shape: "sphere", avatarImage: null, projectId: "project-alpha", mainThreadId: "main-alpha" },
  { slug: "beta", name: "Beta", label: "Second", color: "violet", shape: "blob", avatarImage: null, projectId: "project-beta", mainThreadId: "main-beta" },
  { slug: "gamma", name: "Gamma", label: "Third", color: "amber", shape: "sphere", avatarImage: null, projectId: "project-gamma", mainThreadId: "main-gamma" },
];

const launched: any[] = [];
const deleted: string[] = [];
const sentToEngine: any[] = [];
const rpc = {
  async call(tag: string, payload: any): Promise<any> {
    if (tag === "orchestration.launchThread") { launched.push(payload); return { ok: true }; }
    return { thread: { runtimeMode: "auto", modelSelection: "model-1" } };
  },
  async dispatch(command: any) {
    if (command.type === "thread.delete") deleted.push(command.threadId);
    return { ok: true };
  },
};

const engine = {
  isBusy: () => false,
  send: async (_id: string, message: any) => {
    sentToEngine.push(message);
    return { turn: { id: "t1", at: "2026-01-01T00:00:00.000Z", text: "x", mentions: [], replyTo: null, status: "running" as const, runs: [] }, queued: false };
  },
  stop: async () => true,
  recover: async () => [],
} as unknown as RoomEngine;

async function setup() {
  launched.length = 0;
  deleted.length = 0;
  sentToEngine.length = 0;
  const dir = await mkdtemp(path.join(tmpdir(), "room-routes-"));
  const rooms = createRooms({ file: path.join(dir, "rooms.json") });
  const routes = createRoomRoutes({
    rooms, engine, rpc,
    bots: async () => bots,
    launch: async () => ({ runtimeMode: "auto" }),
    send,
    readBody: async (req: FakeRequest) => req.body,
    requireJson: (req: FakeRequest) => {
      if (!String(req.headers["content-type"] ?? "").includes("application/json")) throw Object.assign(new Error("expected JSON"), { status: 415 });
    },
    checkOrigin: (req: FakeRequest) => req.headers.origin === "https://bot.example",
    log: () => {},
  });
  return { rooms, routes, done: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) };
}

const url = (p: string) => new URL(`http://bot.example${p}`);
const call = async (routes: any, req: FakeRequest, p: string) => {
  const res: FakeResponse = { status: 0, body: null, headers: {} };
  const handled = await routes.handle(req, res, url(p));
  return { handled, res };
};

test("creating a room validates, persists and launches one thread per member", async () => {
  const { routes, rooms, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Design", members: ["alpha", "beta"] } }), "/api/rooms");
  assert.equal(created.res.status, 201);
  const room = (created.res.body as any).room;
  assert.equal(room.name, "Design");
  assert.deepEqual(room.members.map((member: any) => [member.slug, member.name, member.status, member.runtimeMode]), [
    ["alpha", "Alpha", "ready", "auto"], ["beta", "Beta", "ready", "auto"],
  ]);
  assert.equal(launched.length, 2);
  assert.deepEqual(launched.map((payload) => payload.title), ["#Design", "#Design"]);
  assert.deepEqual(launched.map((payload) => payload.modelSelection), ["model-1", "model-1"]);

  const listed = await call(routes, request(), "/api/rooms");
  assert.equal(listed.res.status, 200);
  assert.deepEqual((listed.res.body as any).rooms.map((entry: any) => entry.name), ["Design"]);
  assert.equal((await rooms.list()).length, 1);
  await done();
});

test("a member whose thread cannot be launched stays pending", async () => {
  const { routes, done } = await setup();
  const failing = createRoomRoutes({
    rooms: createRooms({ file: path.join(tmpdir(), `room-routes-${Date.now()}-${Math.random()}.json`) }),
    engine,
    rpc: { async call() { throw new Error("provider refused"); }, async dispatch() { return { ok: true }; } },
    bots: async () => bots,
    launch: async () => ({}),
    send, readBody: async (req: FakeRequest) => req.body,
    requireJson: () => {}, checkOrigin: () => true, log: () => {},
  });
  const created = await call(failing, request({ method: "POST", body: { name: "Broken", members: ["alpha", "beta"] } }), "/api/rooms");
  assert.equal(created.res.status, 201);
  assert.deepEqual((created.res.body as any).room.members.map((member: any) => member.status), ["pending", "pending"]);
  await done();
  void routes;
});

test("requests are refused without JSON, from another origin, or with bad settings", async () => {
  const { routes, done } = await setup();
  const noJson = await call(routes, request({ method: "POST", body: { name: "X", members: ["alpha", "beta"] }, json: false }), "/api/rooms");
  assert.equal(noJson.res.status, 415);
  const foreign = await call(routes, request({ method: "POST", body: { name: "X", members: ["alpha", "beta"] }, origin: "https://evil.example" }), "/api/rooms");
  assert.equal(foreign.res.status, 403);
  const oneMember = await call(routes, request({ method: "POST", body: { name: "X", members: ["alpha"] } }), "/api/rooms");
  assert.equal(oneMember.res.status, 400);
  assert.match(String((oneMember.res.body as any).error), /at least 2/);
  const badSettings = await call(routes, request({ method: "POST", body: { name: "X", members: ["alpha", "beta"], settings: { maxWaves: 9 } } }), "/api/rooms");
  assert.equal(badSettings.res.status, 400);
  await done();
});

test("unknown rooms are 404 and paths outside /api/rooms are not ours", async () => {
  const { routes, done } = await setup();
  const missing = await call(routes, request(), "/api/rooms/nope");
  assert.equal(missing.res.status, 404);
  assert.deepEqual(missing.res.body, { error: "no such room" });
  const outside = await routes.handle(request(), { status: 0, body: null, headers: {} }, url("/api/other"));
  assert.equal(outside, false);
  await done();
});

test("settings can be changed and deleting the room deletes its member threads", async () => {
  const { routes, rooms, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Studio", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  const threads = (created.res.body as any).room.members.map((member: any) => member.threadId).sort();
  const patched = await call(routes, request({ method: "PATCH", body: { settings: { mode: "roundtable", defaultResponder: "everyone" }, guidance: "Short" } }), `/api/rooms/${id}`);
  assert.equal(patched.res.status, 200);
  assert.equal((patched.res.body as any).room.settings.mode, "roundtable");
  assert.equal((patched.res.body as any).room.guidance, "Short");
  const deletedResponse = await call(routes, request({ method: "DELETE" }), `/api/rooms/${id}`);
  assert.deepEqual(deletedResponse.res.body, { ok: true, threads: { deleted: 2, failed: [] } });
  assert.deepEqual(deleted.sort(), threads, "every member thread is deleted in T3");
  assert.equal(await rooms.get(id), null);
  await done();
});

test("start over keeps the threads, forgets the messages and arms a fresh session", async () => {
  const { routes, rooms, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Fresh", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  const threads = (created.res.body as any).room.members.map((member: any) => member.threadId).sort();
  await rooms.appendTurn(id, { id: "t0", at: "2026-01-01T00:00:00.000Z", text: "hola", mentions: [], replyTo: null, status: "done", runs: [] });
  launched.length = 0;
  deleted.length = 0;
  const reset = await call(routes, request({ method: "POST", body: {} }), `/api/rooms/${id}/reset`);
  assert.equal(reset.res.status, 200);
  assert.deepEqual((reset.res.body as any).room.turns, [], "the index is empty after start over");
  assert.deepEqual((reset.res.body as any).room.members.map((member: any) => member.threadId).sort(), threads, "the threads stay");
  assert.deepEqual((reset.res.body as any).room.members.map((member: any) => member.lastTurnAt), [null, null]);
  assert.equal(launched.length, 0, "nothing is relaunched");
  assert.equal(deleted.length, 0, "nothing is deleted");
  const stored = (await rooms.get(id))!;
  assert.deepEqual(stored.members.map((member) => member.fresh), [true, true], "every member starts a new session");
  await done();
});

test("start over replaces a member's thread that T3 no longer has", async () => {
  const { routes, rooms, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Repair", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  const betaThread = (created.res.body as any).room.members.find((member: any) => member.slug === "beta").threadId;
  const original = rpc.call;
  rpc.call = async (tag: string, payload: any) => {
    if (tag === "orchestration.getThreadProjection" && payload.threadId === betaThread) return { thread: null };
    return original(tag, payload);
  };
  try {
    launched.length = 0;
    const reset = await call(routes, request({ method: "POST", body: {} }), `/api/rooms/${id}/reset`);
    assert.equal(reset.res.status, 200);
    assert.equal(launched.length, 1, "only the missing thread is launched again");
    const stored = (await rooms.get(id))!;
    assert.equal(stored.members.find((member) => member.slug === "beta")!.threadId, launched[0].threadId);
    assert.equal(stored.members.find((member) => member.slug === "alpha")!.threadId, (created.res.body as any).room.members.find((member: any) => member.slug === "alpha").threadId);
  } finally {
    rpc.call = original;
  }
  await done();
});

test("start over applies the room's current model and the Bot's current mode", async () => {
  const { routes, rooms, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Refresh", members: ["alpha"] } }), "/api/rooms");
  assert.equal(created.res.status, 400, "a room still needs two members");
  const two = await call(routes, request({ method: "POST", body: { name: "Refresh", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (two.res.body as any).room.id;
  const original = rpc.call, originalDispatch = rpc.dispatch;
  const refreshes: any[] = [];
  rpc.call = async (tag: string, payload: any) => {
    if (tag === "orchestration.getThreadProjection") return { thread: { runtimeMode: "full-access", modelSelection: "model-2" } };
    return original(tag, payload);
  };
  rpc.dispatch = async (command: any) => { refreshes.push(command); return { ok: true }; };
  try {
    const reset = await call(routes, request({ method: "POST", body: {} }), `/api/rooms/${id}/reset`);
    assert.equal(reset.res.status, 200);
    assert.deepEqual(refreshes.map((command) => command.type).sort(), ["thread.model-selection.set", "thread.runtime-mode.set", "thread.runtime-mode.set", "thread.model-selection.set"].sort());
    const alpha = (await rooms.get(id))!.members.find((member) => member.slug === "alpha")!;
    assert.equal(alpha.runtimeMode, "full-access");
    assert.equal(alpha.model, "model-2");
  } finally {
    rpc.call = original; rpc.dispatch = originalDispatch;
  }
  await done();
});

test("messages and stop go through the engine", async () => {
  const { routes, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Live", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  const sent = await call(routes, request({ method: "POST", body: { text: "hola" } }), `/api/rooms/${id}/messages`);
  assert.equal(sent.res.status, 202);
  assert.equal((sent.res.body as any).turn.id, "t1");
  const empty = await call(routes, request({ method: "POST", body: { text: "  " } }), `/api/rooms/${id}/messages`);
  assert.equal(empty.res.status, 400);
  const stop = await call(routes, request({ method: "POST", body: {} }), `/api/rooms/${id}/stop`);
  assert.deepEqual(stop.res.body, { ok: true });
  launched.length = 0;
  const reset = await call(routes, request({ method: "POST", body: {} }), `/api/rooms/${id}/reset`);
  assert.equal(reset.res.status, 200);
  assert.equal(launched.length, 0, "start over relaunched nothing");
  await done();
});

test("removing the lead promotes another member and keeps the former member's thread", async () => {
  const { routes, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Rotate", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  const alphaThread = (created.res.body as any).room.members.find((member: any) => member.slug === "alpha").threadId;
  assert.equal((created.res.body as any).room.settings.lead, "alpha");

  const removed = await call(routes, request({ method: "PATCH", body: { members: ["beta", "gamma"] } }), `/api/rooms/${id}`);
  assert.equal(removed.res.status, 200);
  assert.equal((removed.res.body as any).room.settings.lead, "beta", "the lead is promoted instead of failing the patch");
  assert.deepEqual((removed.res.body as any).room.formerMembers.map((member: any) => [member.slug, member.removed]), [["alpha", true]]);
  assert.equal((removed.res.body as any).room.formerMembers[0].threadId, alphaThread);

  const restored = await call(routes, request({ method: "PATCH", body: { members: ["alpha", "beta", "gamma"] } }), `/api/rooms/${id}`);
  assert.equal(restored.res.status, 200);
  assert.deepEqual((restored.res.body as any).room.formerMembers, []);
  const alpha = (restored.res.body as any).room.members.find((member: any) => member.slug === "alpha");
  assert.equal(alpha.threadId, alphaThread, "re-adding a member reuses its thread");
  assert.equal(alpha.status, "ready");
  assert.equal(launched.length, 3, "only beta and gamma were launched; alpha kept its thread");
  await done();
});

const file = { type: "file", id: "pending-abc", name: "informe.pdf", mimeType: "application/pdf", sizeBytes: 2_048 };

test("a room message carries its files, and an attachment-only message is allowed", async () => {
  const { routes, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Files", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  const sent = await call(routes, request({ method: "POST", body: { text: "", attachments: [file] } }), `/api/rooms/${id}/messages`);
  assert.equal(sent.res.status, 202);
  assert.deepEqual(sentToEngine.at(-1).attachments, [file]);
  assert.equal(sentToEngine.at(-1).text, "");

  for (const attachments of [
    [{ ...file, type: "audio" }],
    [{ ...file, sizeBytes: 1.5 }],
    Array.from({ length: 11 }, (_, index) => ({ ...file, id: `pending-${index}` })),
    "not-a-list",
  ]) {
    const rejected = await call(routes, request({ method: "POST", body: { text: "hi", attachments } }), `/api/rooms/${id}/messages`);
    assert.equal(rejected.res.status, 400, `${JSON.stringify(attachments).slice(0, 40)} is refused`);
    assert.equal(sentToEngine.length, 1, "nothing reached the engine");
  }
  await done();
});
