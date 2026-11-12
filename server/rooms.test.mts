import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createRooms, DEFAULT_SETTINGS, MAX_TURNS, RoomsError, normalizeSettings, validateMembers, type RoomTurn,
} from "./rooms.mts";

const bots = [{ slug: "alpha", name: "Alpha" }, { slug: "beta", name: "Beta" }, { slug: "gamma", name: "Gamma" }];

async function dir() {
  const d = await mkdtemp(path.join(tmpdir(), "rooms-"));
  return { file: path.join(d, "rooms.json"), done: () => rm(d, { recursive: true, force: true }) };
}

const turn = (id: string): RoomTurn => ({ id, at: new Date().toISOString(), text: `m${id}`, mentions: [], replyTo: null, status: "done", runs: [] });

test("a new room stores the defaults and starts every member pending", async () => {
  const { file, done } = await dir();
  const rooms = createRooms({ file });
  const room = await rooms.create({ name: "Design", members: validateMembers(["alpha", "beta"], bots) });
  assert.equal(room.settings.mode, DEFAULT_SETTINGS.mode);
  assert.equal(room.settings.lead, "alpha", "the first member is the lead by default");
  assert.equal(room.settings.runtimeMode, "inherit");
  assert.equal(room.settings.maxWaves, 3);
  assert.deepEqual(room.members.map((member) => [member.slug, member.status, member.threadId]), [
    ["alpha", "pending", null], ["beta", "pending", null],
  ]);
  assert.deepEqual((await rooms.list()).map((entry) => entry.name), ["Design"]);
  await done();
});

test("settings are validated at their boundaries", () => {
  assert.equal(normalizeSettings({ maxWaves: 1 }, ["a", "b"]).maxWaves, 1);
  assert.equal(normalizeSettings({ maxWaves: 5 }, ["a", "b"]).maxWaves, 5);
  assert.throws(() => normalizeSettings({ maxWaves: 0 }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ maxWaves: 6 }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ maxReplies: 21 }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ memberTimeoutMin: 0 }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ turnDeadlineMin: 121 }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ mode: "party" }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ defaultResponder: "nobody" }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ runtimeMode: "root" }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ mentionPolicy: "sometimes" }, ["a"]), RoomsError);
  assert.throws(() => normalizeSettings({ lead: "ghost" }, ["a", "b"]), RoomsError);
  assert.equal(normalizeSettings({}, ["a", "b"]).lead, "a");
});

test("members are 2 to 8, known, and unique by name", () => {
  assert.deepEqual(validateMembers(["alpha", "beta"], bots).map((bot) => bot.slug), ["alpha", "beta"]);
  assert.throws(() => validateMembers(["alpha"], bots), /at least 2/);
  assert.throws(() => validateMembers([], bots), /at least 2/);
  assert.throws(() => validateMembers(["alpha", "beta", "gamma", "d", "e", "f", "g", "h", "i"], bots), /at most 8/);
  assert.throws(() => validateMembers(["alpha", "ghost"], bots), /unknown Bot/);
  assert.throws(() => validateMembers(["alpha", "alpha"], bots), /at least 2/, "duplicates collapse before the count");
  // Two Bots with the same name would make @Name ambiguous.
  assert.throws(() => validateMembers(["beta", "beta2"], [...bots, { slug: "beta2", name: "Beta" }]), /unique names/);
});

test("CRUD keeps the file consistent and refuses duplicate names", async () => {
  const { file, done } = await dir();
  const rooms = createRooms({ file });
  const room = await rooms.create({ name: "Design", members: validateMembers(["alpha", "beta"], bots), description: "d" });
  await assert.rejects(rooms.create({ name: "design", members: validateMembers(["alpha", "beta"], bots) }), /already exists/);

  const updated = await rooms.update(room.id, { name: "Studio", settings: { mode: "roundtable", maxWaves: 2 } });
  assert.equal(updated.name, "Studio");
  assert.equal(updated.settings.mode, "roundtable");
  assert.equal(updated.settings.maxWaves, 2);
  assert.equal(updated.settings.maxReplies, DEFAULT_SETTINGS.maxReplies, "untouched settings keep their value");
  assert.equal(updated.description, "d");

  await rooms.remove(room.id);
  assert.equal(await rooms.get(room.id), null);
  assert.deepEqual((await rooms.list()), []);
  await assert.rejects(rooms.remove(room.id), /no such room/);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.rooms, [], "the file follows the deletion");
  await done();
});

test("the file is written atomically with mode 0600", async () => {
  const { file, done } = await dir();
  const rooms = createRooms({ file });
  await rooms.create({ name: "One", members: validateMembers(["alpha", "beta"], bots) });
  await rooms.create({ name: "Two", members: validateMembers(["alpha", "beta"], bots) });
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.rooms.length, 2, "two writes in a row both landed");
  await done();
});

test("the turn index keeps the newest 200", async () => {
  const { file, done } = await dir();
  const rooms = createRooms({ file });
  const room = await rooms.create({ name: "Busy", members: validateMembers(["alpha", "beta"], bots) });
  for (let index = 0; index < MAX_TURNS + 5; index += 1) await rooms.appendTurn(room.id, turn(String(index)));
  const stored = (await rooms.get(room.id))!;
  assert.equal(stored.turns.length, MAX_TURNS);
  assert.equal(stored.turns[0].id, "5", "the oldest five were pruned");
  assert.equal(stored.turns.at(-1)!.id, String(MAX_TURNS + 4));
  await done();
});

test("a running turn is interrupted on startup", async () => {
  const { file, done } = await dir();
  const rooms = createRooms({ file });
  const room = await rooms.create({ name: "Crash", members: validateMembers(["alpha", "beta"], bots) });
  await rooms.appendTurn(room.id, { ...turn("open"), status: "running" });
  await rooms.appendTurn(room.id, turn("done"));
  const interrupted = await rooms.interruptRunning();
  assert.deepEqual(interrupted, [`${room.id}/open`]);
  const stored = (await rooms.get(room.id))!;
  assert.deepEqual(stored.turns.map((entry) => entry.status), ["interrupted", "done"]);
  assert.deepEqual(await rooms.interruptRunning(), [], "a second pass has nothing to do");
  await done();
});

test("a fresh start forgets the room's messages and every member's clock", async () => {
  const { file, done } = await dir();
  const rooms = createRooms({ file });
  const room = await rooms.create({ name: "Reset", members: validateMembers(["alpha", "beta"], bots) });
  await rooms.appendTurn(room.id, turn("one"));
  await rooms.setMember(room.id, "alpha", { threadId: "thread-alpha", status: "ready", lastTurnAt: "2026-01-01T00:00:05.000Z" });
  const cleared = await rooms.clearTurns(room.id);
  assert.deepEqual(cleared.turns, []);
  assert.deepEqual(cleared.members.map((member) => member.lastTurnAt), [null, null]);
  assert.equal(cleared.members[0].threadId, "thread-alpha", "clearTurns does not touch the threads");
  assert.equal(cleared.settings.mode, room.settings.mode);
  const reloaded = (await createRooms({ file }).get(room.id))!;
  assert.deepEqual(reloaded.turns, [], "the file follows");
  await done();
});

test("changing members keeps existing threads and leaves the new one pending", async () => {
  const { file, done } = await dir();
  const rooms = createRooms({ file });
  const room = await rooms.create({ name: "Growing", members: validateMembers(["alpha", "beta"], bots) });
  await rooms.setMember(room.id, "alpha", { threadId: "thread-alpha", status: "ready" });
  const grown = await rooms.update(room.id, { members: ["alpha", "beta", "gamma"] });
  assert.deepEqual(grown.members.map((member) => [member.slug, member.threadId]), [
    ["alpha", "thread-alpha"], ["beta", null], ["gamma", null],
  ]);
  const shrunk = await rooms.update(room.id, { members: ["alpha", "gamma"] });
  assert.deepEqual(shrunk.members.map((member) => member.slug), ["alpha", "gamma"]);
  assert.equal(shrunk.members[0].threadId, "thread-alpha");
  await done();
});
