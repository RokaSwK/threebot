import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";
import type { MemberView } from "../src/lib/rooms.ts";
import type { Bot, RuntimeRequest, TurnItem } from "../src/lib/types.ts";

// `roomCards` reads the same `buildEntries` the chat uses, which pulls in the app's module graph;
// bundle it the way the other component tests do instead of asking Node to resolve Vite imports.
const source = new URL("../src/lib/roomCards.ts", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "room-cards-test",
    resolveId: (id) => id.endsWith("virtual:room-cards-tests") ? "\0room-cards-tests" : undefined,
    load: (id) => id === "\0room-cards-tests" ? `export { roomCards } from ${JSON.stringify(source)};` : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:room-cards-tests", write: false },
});
const entry = entryChunk(bundle);
const directory = await mkdtemp(join(tmpdir(), "bot-room-cards-"));
const filename = join(directory, "room-cards.mjs");
await writeFile(filename, entry.code);
const { roomCards } = await import(pathToFileURL(filename).href) as typeof import("../src/lib/roomCards.ts");
after(() => rm(directory, { recursive: true, force: true }));

const bot = (slug: string, name: string): Bot => ({
  slug, workspaceRoot: `/tmp/${slug}`, name, label: "", shape: "sphere", color: "blue",
  section: null, pinned: false, hidden: false, primary: false, notifications: true,
  projectId: `project-${slug}`, mainThreadId: `main-${slug}`, createdAt: "2026-01-01T00:00:00.000Z",
});

const member = (slug: string, threadId: string | null): MemberView => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1), label: "", color: "blue", shape: "sphere",
  avatarImage: null, threadId, status: "ready", model: null, runtimeMode: "inherit", lastTurnAt: null,
});

const item = (overrides: Partial<TurnItem> & Pick<TurnItem, "id" | "type">): TurnItem => ({
  threadId: "thread-beta", runId: "run-1", ordinal: 1, status: "waiting", title: null,
  startedAt: "2026-01-01T00:00:01.000Z", completedAt: null,
  updatedAt: "2026-01-01T00:00:02.000Z", parentItemId: null, ...overrides,
});

const request = (id: string, status: RuntimeRequest["status"]): RuntimeRequest => ({ id, kind: "approval", status });

test("roomCards returns pending approvals, questions and secrets with their member", () => {
  const room = { members: [member("alpha", "thread-alpha"), member("beta", "thread-beta")] };
  const threadData = {
    "thread-beta": {
      items: {
        approval: item({ id: "a1", type: "approval_request", requestId: "req-a" }),
        question: item({ id: "q1", type: "user_input_request", requestId: "req-q" }),
        secret: item({ id: "s1", type: "secret_request", secretStatus: "pending" }),
      },
      requests: { "req-a": request("req-a", "pending"), "req-q": request("req-q", "pending") },
    },
  };
  const cards = roomCards(room, threadData, { alpha: bot("alpha", "Alpha"), beta: bot("beta", "Beta") });
  assert.deepEqual(cards.map((card) => card.entry.kind).sort(), ["approval", "question", "secret"]);
  assert.ok(cards.every((card) => card.member.slug === "beta"));
  assert.ok(cards.every((card) => card.threadId === "thread-beta"));
});

test("roomCards drops resolved cards and members that are not ready", () => {
  const room = { members: [member("beta", "thread-beta"), member("gamma", null)] };
  const threadData = {
    "thread-beta": {
      items: {
        done: item({ id: "a1", type: "approval_request", requestId: "req-a" }),
        expired: item({ id: "q1", type: "user_input_request", requestId: "req-q" }),
        passed: item({ id: "s1", type: "secret_request", secretStatus: "saved" }),
      },
      requests: { "req-a": request("req-a", "resolved"), "req-q": request("req-q", "expired") },
    },
  };
  const cards = roomCards(room, threadData, { beta: bot("beta", "Beta"), gamma: bot("gamma", "Gamma") });
  assert.deepEqual(cards, []);
});

test("roomCards needs the member's Bot and thread data", () => {
  const room = { members: [member("beta", "thread-beta")] };
  const threadData = { "thread-beta": { items: { a: item({ id: "a1", type: "approval_request" }) }, requests: {} } };
  assert.deepEqual(roomCards(room, threadData, {}), []);
  assert.deepEqual(roomCards(null, threadData, { beta: bot("beta", "Beta") }), []);
});
