import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, createRooms, validateMembers, type RoomSettings } from "./rooms.mts";
import { launchRoomThread, resolveMemberLaunch, type RoomBot, type RoomRpc } from "./rooms-threads.mts";

const roster = [
  { slug: "alpha", name: "Alpha" },
  { slug: "beta", name: "Beta" },
];
const bot = (slug: string, mainThreadId: string | null = `main-${slug}`): RoomBot => ({
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  projectId: `project-${slug}`,
  mainThreadId,
});

const settings = (patch: Partial<RoomSettings> = {}): RoomSettings => ({ ...DEFAULT_SETTINGS, lead: "alpha", ...patch });

function fakeRpc(projection: unknown = { thread: { runtimeMode: "auto", modelSelection: { instanceId: "pi", model: "model-1" } } }) {
  const calls: { tag: string; payload: any }[] = [];
  const rpc: RoomRpc = {
    async call(tag, payload) {
      calls.push({ tag, payload });
      if (tag === "orchestration.getThreadProjection") return projection;
      if (tag === "orchestration.launchThread") return { ok: true };
      throw new Error(`unexpected ${tag}`);
    },
  };
  return { rpc, calls };
}

test("inherit reads the Bot's main thread once", async () => {
  const { rpc, calls } = fakeRpc();
  const resolved = await resolveMemberLaunch({ rpc, bot: bot("alpha"), settings: settings(), defaults: { runtimeMode: "full-access" } });
  assert.equal(resolved.runtimeMode, "auto");
  assert.deepEqual(resolved.modelSelection, { instanceId: "pi", model: "model-1" });
  assert.deepEqual(calls, [{ tag: "orchestration.getThreadProjection", payload: { threadId: "main-alpha" } }]);
});

test("an explicit room mode and model win over inherit", async () => {
  const { rpc } = fakeRpc();
  const resolved = await resolveMemberLaunch({
    rpc,
    bot: bot("alpha"),
    settings: settings({ runtimeMode: "approval-required", model: { instanceId: "codex", model: "pinned" } }),
    defaults: {},
  });
  assert.equal(resolved.runtimeMode, "approval-required");
  assert.deepEqual(resolved.modelSelection, { instanceId: "codex", model: "pinned" });
});

test("a Bot without a main thread falls back to the app defaults", async () => {
  const { rpc, calls } = fakeRpc();
  const resolved = await resolveMemberLaunch({ rpc, bot: bot("alpha", null), settings: settings(), defaults: { runtimeMode: "auto", model: "default-model" } });
  assert.equal(resolved.runtimeMode, "auto");
  assert.equal(resolved.modelSelection, "default-model");
  assert.deepEqual(calls, [], "there is no main thread to read");
});

test("launchRoomThread launches an idle room thread in the Bot's project", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "room-threads-"));
  const rooms = createRooms({ file: path.join(dir, "rooms.json") });
  const room = await rooms.create({ name: "Design", members: validateMembers(["alpha", "beta"], roster), settings: { runtimeMode: "auto", model: { instanceId: "pi", model: "model-1" } } });
  const { rpc, calls } = fakeRpc();

  const launched = await launchRoomThread({ rpc, room, slug: "alpha", bot: bot("alpha"), settings: room.settings, defaults: {} });
  const launch = calls.find((call) => call.tag === "orchestration.launchThread")!;
  assert.equal(launch.payload.projectId, "project-alpha");
  assert.equal(launch.payload.title, "#Design");
  assert.equal(launch.payload.workspaceStrategy.type, "root");
  assert.equal(launch.payload.interactionMode, "default");
  assert.equal(launched.runtimeMode, "auto");
  assert.ok(launched.threadId);
  assert.equal(launch.payload.threadId, launched.threadId);

  await rooms.setMember(room.id, "alpha", { threadId: launched.threadId, status: "ready", runtimeMode: launched.runtimeMode, model: launched.modelSelection });
  const stored = (await rooms.get(room.id))!;
  calls.length = 0;
  const again = await launchRoomThread({ rpc, room: stored, slug: "alpha", bot: bot("alpha"), settings: stored.settings, defaults: {} });
  assert.equal(again.threadId, launched.threadId);
  assert.deepEqual(calls, [], "an existing thread is reused, not launched twice");
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});
