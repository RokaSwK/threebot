import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IncomingHttpHeaders } from "node:http";
import { createRooms } from "./rooms.mts";
import { createRoomRoutes } from "./rooms-routes.mts";

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
];

const launched: any[] = [];
const rpc = {
  async call(tag: string, payload: any) {
    if (tag === "orchestration.launchThread") { launched.push(payload); return { ok: true }; }
    return { thread: { runtimeMode: "auto", modelSelection: "model-1" } };
  },
};

async function setup() {
  launched.length = 0;
  const dir = await mkdtemp(path.join(tmpdir(), "room-routes-"));
  const rooms = createRooms({ file: path.join(dir, "rooms.json") });
  const routes = createRoomRoutes({
    rooms, rpc,
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
    rpc: { async call() { throw new Error("provider refused"); } },
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

test("settings can be changed and the room deleted; the threads are left alone", async () => {
  const { routes, rooms, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Studio", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  const patched = await call(routes, request({ method: "PATCH", body: { settings: { mode: "roundtable", defaultResponder: "everyone" }, guidance: "Short" } }), `/api/rooms/${id}`);
  assert.equal(patched.res.status, 200);
  assert.equal((patched.res.body as any).room.settings.mode, "roundtable");
  assert.equal((patched.res.body as any).room.guidance, "Short");
  const deleted = await call(routes, request({ method: "DELETE" }), `/api/rooms/${id}`);
  assert.deepEqual(deleted.res.body, { ok: true });
  assert.equal(await rooms.get(id), null);
  await done();
});

test("recreate threads also forgets the room's messages", async () => {
  const { routes, rooms, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Fresh", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  await rooms.appendTurn(id, { id: "t0", at: "2026-01-01T00:00:00.000Z", text: "hola", mentions: [], replyTo: null, status: "done", runs: [] });
  launched.length = 0;
  const recreated = await call(routes, request({ method: "POST", body: {} }), `/api/rooms/${id}/recreate`);
  assert.equal(recreated.res.status, 200);
  assert.deepEqual((recreated.res.body as any).room.turns, [], "the index is empty after a recreate");
  assert.equal(launched.length, 2, "one fresh thread per member");
  assert.deepEqual((recreated.res.body as any).room.members.map((member: any) => member.lastTurnAt), [null, null]);
  await done();
});

test("messages and stop are not routes before the engine exists", async () => {
  const { routes, done } = await setup();
  const created = await call(routes, request({ method: "POST", body: { name: "Live", members: ["alpha", "beta"] } }), "/api/rooms");
  const id = (created.res.body as any).room.id;
  const sent = await call(routes, request({ method: "POST", body: { text: "hola" } }), `/api/rooms/${id}/messages`);
  assert.equal(sent.res.status, 404);
  const stop = await call(routes, request({ method: "POST", body: {} }), `/api/rooms/${id}/stop`);
  assert.equal(stop.res.status, 404);
  await done();
});
