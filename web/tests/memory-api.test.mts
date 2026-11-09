import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { memoryApi } from "../src/lib/memory.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

test("memoryApi reads both layers and reads a note", async () => {
  const view = {
    bot: { text: "# Tester\n", revision: "rev", truncated: false, facts: [] },
    shared: { text: "# Shared\n", revision: "shared-rev", truncated: false, facts: [] },
    notes: [{ path: "memory/notes/a.md", description: "A", chars: 10, tokens: 3, updatedAt: null }],
    forgotten: 0,
    limits: { memoryLines: 120, memoryChars: 6000, factChars: 200, noteTokens: 2000, noteChars: 8000, noteCount: 20 },
  };
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).startsWith("/api/memory/note")) return new Response(JSON.stringify({ path: "memory/notes/a.md", text: "Body", revision: "n" }), { status: 200 });
    return new Response(JSON.stringify(view), { status: 200 });
  }) as typeof fetch;
  assert.equal((await memoryApi.get("tester")).bot.revision, "rev");
  assert.equal((await memoryApi.note("tester", "memory/notes/a.md")).text, "Body");
  assert.match(calls[0]!, /slug=tester/u);
  assert.match(calls[1]!, /path=memory%2Fnotes%2Fa\.md/u);
});

test("memoryApi surfaces a conflict message", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, code: "conflict", message: "Memory changed" }), { status: 409 })) as typeof fetch;
  await assert.rejects(() => memoryApi.forget({ slug: "tester", scope: "bot", fact: "- x", expectedRevision: "old" }), /Memory changed/u);
});
