import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { memoryApi } from "../src/lib/memory.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

test("memoryApi reads both files and saves one with its revision", async () => {
  const files = {
    bot: { path: "memory/MEMORY.md", text: "# Tester\n", revision: "rev" },
    shared: { path: ".botapp/shared-memory.md", text: "", revision: "shared-rev" },
    tidyPrompt: "Tidy your memory now.\n",
  };
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(init.method === "PUT" ? { ok: true, revision: "next" } : files), { status: 200 });
  }) as typeof fetch;
  const loaded = await memoryApi.get("tester");
  assert.equal(loaded.bot.text, "# Tester\n");
  assert.equal(loaded.tidyPrompt, "Tidy your memory now.\n");
  assert.deepEqual(await memoryApi.save({ slug: "tester", scope: "bot", text: "# Tester\n- New\n", expectedRevision: "rev" }), { ok: true, revision: "next" });
  assert.match(calls[0]!.url, /slug=tester/u);
  assert.deepEqual(calls[1], { url: "/api/memory", method: "PUT", body: { slug: "tester", scope: "bot", text: "# Tester\n- New\n", expectedRevision: "rev" } });
});

test("a conflict comes back as an answer with the current text", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, code: "conflict", message: "Memory changed", revision: "theirs", text: "- Bot edit\n" }), { status: 409 })) as typeof fetch;
  const result = await memoryApi.save({ slug: "tester", scope: "bot", text: "- Mine\n", expectedRevision: "old" });
  assert.deepEqual(result, { ok: false, code: "conflict", message: "Memory changed", revision: "theirs", text: "- Bot edit\n" });
});

test("other failures are errors", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Bot not found" }), { status: 404 })) as typeof fetch;
  await assert.rejects(() => memoryApi.save({ slug: "nobody", scope: "bot", text: "", expectedRevision: "" }), /Bot not found/u);
});

test("tidy posts the chosen frequency and surfaces a refused schedule", async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ frequency: "weekly", task: { id: "task-1", enabled: true, threadId: null, schedule: {} } }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await memoryApi.tidy("tester", "weekly"), { frequency: "weekly", task: { id: "task-1", enabled: true, threadId: null, schedule: {} } });
  assert.deepEqual(calls, [{ url: "/api/memory/tidy", body: { slug: "tester", frequency: "weekly" } }]);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "This Bot needs a main conversation first." }), { status: 409 })) as typeof fetch;
  await assert.rejects(() => memoryApi.tidy("tester", "nightly"), /needs a main conversation/u);
});
