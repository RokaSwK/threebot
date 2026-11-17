// Runs the real worker source, not a copy of its rules: the install handler is executed in a
// sandbox with a CacheStorage stand-in, so the reuse of a previous revision is what is measured.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { transformWithOxc } from "vite";

const WORKER = new URL("../src/sw.ts", import.meta.url);
const MARKER = "BOT_BUILD_PRECACHE";
const ORIGIN = "https://bot.test";

type Entry = { url: string; sha256: string; markers?: string[] };
type Build = { revision: string; base: string; entries: Entry[] };

/** A Response stand-in: the worker reads ok/type/url and clones the bytes it verifies. */
class FakeResponse {
  readonly ok = true;
  readonly redirected = false;
  readonly type = "basic";
  readonly headers: Headers;
  readonly url: string;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array, url: string) {
    this.bytes = bytes;
    this.url = url;
    this.headers = new Headers({ "content-type": "text/javascript", vary: "Accept-Encoding" });
  }
  clone() { return new FakeResponse(this.bytes, this.url); }
  async arrayBuffer() { return this.bytes.slice().buffer; }
  async text() { return new TextDecoder().decode(this.bytes); }
}

class FakeCache {
  readonly store = new Map<string, FakeResponse>();
  async match(request: string, options?: { ignoreVary?: boolean }) {
    const hit = this.store.get(request);
    if (!hit) return undefined;
    // The gateway marks the bundle Vary: Accept-Encoding; a stored variant is only reachable when
    // the caller ignores it, which is what the worker must do with its own cache.
    if (!options?.ignoreVary && /accept-encoding/i.test(hit.headers.get("vary") ?? "")) return undefined;
    return hit.clone();
  }
  async put(request: string, response: FakeResponse) { this.store.set(request, response.clone()); }
  async keys() { return [...this.store.keys()]; }
}

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes)).digest("hex");

async function boot(build: Build, storage: Map<string, FakeCache>, files: Map<string, Uint8Array>, fetched: string[]) {
  const source = await readFile(WORKER, "utf8");
  const { code } = await transformWithOxc(source, "sw.ts", { lang: "ts" });
  const listeners = new Map<string, (event: any) => void>();
  const caches = {
    async open(name: string) {
      if (!storage.has(name)) storage.set(name, new FakeCache());
      return storage.get(name)!;
    },
    async keys() { return [...storage.keys()]; },
    async delete(name: string) { return storage.delete(name); },
  };
  const context = vm.createContext({
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: any) => void) => listeners.set(type, handler),
      skipWaiting: async () => {},
      clients: { claim: async () => {}, matchAll: async () => [], navigate: async () => {}, openWindow: async () => {} },
    },
    caches,
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      fetched.push(path);
      const bytes = files.get(path);
      if (!bytes) throw new TypeError(`no fixture for ${path}`);
      return new FakeResponse(bytes, request.url);
    },
    crypto: globalThis.crypto,
    Request, URL, Uint8Array, Array, Promise, Error, JSON, Map, Set, Number, String, Math, console, setTimeout, TextDecoder,
  });
  vm.runInContext(code.replace(MARKER, () => JSON.stringify(build)), context);
  const install = listeners.get("install");
  assert.ok(install, "the worker registers an install handler");
  return {
    async install() {
      let done: Promise<unknown> = Promise.resolve();
      install({ waitUntil: (promise: Promise<unknown>) => { done = promise; } });
      await done;
    },
  };
}

const html = (asset: string) => `<script src="${asset}"></script>`;
/** Build B ships another page; the fixture has to serve it before that revision installs. */
const pageB = (files: Map<string, Uint8Array>) => files.set("/index.html", new TextEncoder().encode(html("/assets/b.js")));
const A = new TextEncoder().encode("export const a = 1;\n".repeat(200));
const SHARED = new TextEncoder().encode("export const shared = 2;\n".repeat(300));
const B = new TextEncoder().encode("export const b = 3;\n".repeat(250));

const buildA: Build = {
  revision: "acme1", base: "/",
  entries: [
    { url: "/index.html", sha256: sha(html("/assets/a.js")), markers: ["/assets/a.js"] },
    { url: "/assets/a.js", sha256: sha(A) },
    { url: "/assets/shared.js", sha256: sha(SHARED) },
  ],
};
const buildB: Build = {
  revision: "acme2", base: "/",
  entries: [
    { url: "/index.html", sha256: sha(html("/assets/b.js")), markers: ["/assets/b.js"] },
    { url: "/assets/b.js", sha256: sha(B) },
    { url: "/assets/shared.js", sha256: sha(SHARED) },
  ],
};

function world() {
  const storage = new Map<string, FakeCache>();
  const files = new Map<string, Uint8Array>([
    ["/index.html", new TextEncoder().encode(html("/assets/a.js"))],
    ["/assets/a.js", A],
    ["/assets/shared.js", SHARED],
    ["/assets/b.js", B],
  ]);
  const fetched: string[] = [];
  return { storage, files, fetched };
}

test("a first install downloads every entry and stores the shell", async () => {
  const { storage, files, fetched } = world();
  const worker = await boot(buildA, storage, files, fetched);
  await worker.install();
  assert.deepEqual(fetched.sort(), ["/assets/a.js", "/assets/shared.js", "/index.html"]);
  assert.equal(storage.get("bot-shell-%2F-acme1")?.store.size, 3);
});

test("an update copies the files whose name did not change and downloads only the rest", async () => {
  const { storage, files, fetched } = world();
  await (await boot(buildA, storage, files, fetched)).install();
  fetched.length = 0;
  pageB(files);
  await (await boot(buildB, storage, files, fetched)).install();
  assert.deepEqual(fetched.sort(), ["/assets/b.js", "/index.html"], "the unchanged chunk is not downloaded again");
  const updated = storage.get("bot-shell-%2F-acme2");
  assert.equal(updated?.store.size, 3);
  assert.deepEqual(updated?.store.get(ORIGIN + "/assets/shared.js") && new Uint8Array(await updated.store.get(ORIGIN + "/assets/shared.js")!.arrayBuffer()), SHARED);
});

test("the same name with different bytes is not reused", async () => {
  const { storage, files, fetched } = world();
  await (await boot(buildA, storage, files, fetched)).install();
  // A cache evicted or written by something else: same URL, wrong bytes.
  const previous = storage.get("bot-shell-%2F-acme1")!;
  await previous.put(ORIGIN + "/assets/shared.js", new FakeResponse(new TextEncoder().encode("tampered"), ORIGIN + "/assets/shared.js"));
  pageB(files);
  fetched.length = 0;
  await (await boot(buildB, storage, files, fetched)).install();
  assert.ok(fetched.includes("/assets/shared.js"), "the copy failed verification, so the file is fetched again");
  const updated = storage.get("bot-shell-%2F-acme2")!;
  const stored = new Uint8Array(await updated.store.get(ORIGIN + "/assets/shared.js")!.arrayBuffer());
  assert.deepEqual(stored, SHARED, "the shell ends up with the bytes this build names");
});

test("a missing entry in the previous cache is downloaded, not skipped", async () => {
  const { storage, files, fetched } = world();
  await (await boot(buildA, storage, files, fetched)).install();
  storage.get("bot-shell-%2F-acme1")!.store.delete(ORIGIN + "/assets/shared.js");
  pageB(files);
  fetched.length = 0;
  await (await boot(buildB, storage, files, fetched)).install();
  assert.ok(fetched.includes("/assets/shared.js"));
  assert.equal(storage.get("bot-shell-%2F-acme2")?.store.size, 3, "a partial old cache cannot leave a partial shell");
});

test("a cached variant marked Vary: Accept-Encoding is still reusable", async () => {
  const { storage, files, fetched } = world();
  await (await boot(buildA, storage, files, fetched)).install();
  const previous = storage.get("bot-shell-%2F-acme1")!;
  assert.match(previous.store.get(ORIGIN + "/assets/shared.js")!.headers.get("vary") ?? "", /accept-encoding/i);
  pageB(files);
  fetched.length = 0;
  await (await boot(buildB, storage, files, fetched)).install();
  assert.deepEqual(fetched.sort(), ["/assets/b.js", "/index.html"], "a Vary header must not turn a hit into a miss");
});
