import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "vite";
import { installWorkers, loadWorkerHighlighter } from "./highlight-worker-fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "bot-highlight-code-"));
after(() => rm(directory, { recursive: true }));
const source = new URL("../src/lib/highlightCode.tokenize.ts", import.meta.url).pathname;
const workers = installWorkers();
const actual = await loadWorkerHighlighter();
after(async () => { await workers.close(); await actual.close(); });
async function loadHighlighter(name, plugins = []) {
  const result = await build({
    configFile: false, logLevel: "silent", plugins, ssr: { noExternal: true },
    build: { ssr: source, write: false, rollupOptions: { output: { entryFileNames: "entry.mjs", chunkFileNames: "[name]-[hash].mjs" } } },
  });
  for (const output of result.output) {
    const filename = join(directory, name, output.fileName);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, output.type === "chunk" ? output.code : output.source);
  }
  const module = await import(pathToFileURL(join(directory, name, "entry.mjs")).href);
  return { highlightCode: module.tokenizeCode };
}
const { highlightCode } = actual;

const examples = [
  ["bash", 'echo "hello"', "echo"],
  ["js", 'const answer = "雪";', "const"],
  ["javascript", "const value = 42;", "const"],
  ["JS", "const upper = true;", "const"],
  ["ts", "const count: number = 42;", "const"],
  ["typescript", "const ready: boolean = true;", "const"],
  ["tsx", 'const view = <div title="hi">雪</div>;', "const"],
  ["jsx", 'const view = <div title="hi">雪</div>;', "const"],
  ["json", '{"answer": 42}', '"answer"'],
  ["python", "def hello():\n    return 42", "def"],
  ["py", "def short():\n    return 42", "def"],
  ["shell", 'echo "hello"', "echo"],
  ["sh", 'echo "hello"', "echo"],
  ["shellscript", 'echo "hello"', "echo"],
  ["html", '<div class="hello">雪</div>', "div"],
  ["css", ".hello { color: red; }", "color"],
  ["sql", "SELECT answer FROM examples;", "SELECT"],
  ["yaml", "answer: true", "answer"],
  ["yml", "answer: true", "answer"],
];
for (const [language, source, keyword] of examples) test(`real Shiki ${language} produces themed syntax and exact source`, async () => {
  const tokens = await highlightCode(source, language);
  assert.ok(tokens, `expected ${language} to tokenize`);
  assert.equal(tokens.map((token) => token.text).join(""), source);
  const token = tokens.find((token) => token.text === keyword);
  assert.ok(token, `expected a distinct ${keyword} token`);
  assert.match(token.light, /^#[0-9a-f]{6,8}$/i);
  assert.match(token.dark, /^#[0-9a-f]{6,8}$/i);
  assert.notEqual(token.light, token.dark);
  assert.ok(tokens.some((other) => other.light && other.light !== token.light), "syntax has more than a uniform foreground");
});

test("token offsets preserve tabs, Unicode, HTML, whitespace, CRLF and terminal blank lines", async () => {
  const source = '\tconst λ = "<script>globalThis.executed = true</script> 雪 🪁";  \r\n\t\r\n\n';
  const tokens = await highlightCode(source, "js");
  assert.ok(tokens);
  assert.equal(tokens.map((token) => token.text).join(""), source);
  assert.deepEqual(tokens.find((token) => token.text === "const"), { text: "const", light: "#D73A49", dark: "#F97583" });
  assert.equal(globalThis.executed, undefined);
});

test("unclosed streaming syntax stays readable with exact text", async () => {
  const tokens = await highlightCode('const label = `雪\n  ${answer', "js");
  assert.ok(tokens);
  assert.equal(tokens.map((token) => token.text).join(""), 'const label = `雪\n  ${answer');
  assert.equal(tokens.find((token) => token.text === "const")?.light, "#D73A49");
});

// Only failure boundaries are replaced; the syntax tests use the real engine.
function brokenCore(body) {
  return {
    name: "failed-shiki-boundary", enforce: "pre",
    resolveId: (id) => id === "shiki/core" ? "\0broken-core" : undefined,
    load: (id) => id === "\0broken-core" ? body : undefined,
  };
}

test("unsupported/empty/oversized code skips imports, and failed imports stay plain", async () => {
  globalThis.coreImports = 0;
  const { highlightCode } = await loadHighlighter("bounded", [brokenCore('globalThis.coreImports++; throw new Error("import unavailable");')]);
  for (const [text, tag] of [["const answer = 42;", "unknown"], ["const answer = 42;", ""], ["x", "__proto__"], ["x", "constructor"], ["", "js"], ["x".repeat(20_001), "js"], ["x".repeat(2_001), "js"], ["x\n".repeat(500), "js"]]) {
    assert.equal(await highlightCode(text, tag), null);
  }
  assert.equal(globalThis.coreImports, 0);
  assert.equal(await highlightCode("const answer = 42;", "js"), null);
  assert.equal(globalThis.coreImports, 1);
  delete globalThis.coreImports;
});

test("initialization rejection falls back and later calls can retry", async () => {
  const { highlightCode } = await loadHighlighter("init-failure", [brokenCore(`
    let calls = 0;
    export function createHighlighterCore() {
      if (++calls === 1) return Promise.reject(new Error("engine unavailable"));
      return { loadLanguage: async () => {}, codeToTokensWithThemes: (text) => [[{ content: text, offset: 0, variants: { light: { color: "#123456" }, dark: { color: "#abcdef" } } }]] };
    }`)]);
  assert.equal(await highlightCode("const answer = 42;", "js"), null);
  assert.deepEqual(await highlightCode("const retry = 42;", "js"), [{ text: "const retry = 42;", light: "#123456", dark: "#abcdef" }]);
});

test("grammar load and tokenization failures stay plain and allow another attempt", async () => {
  const { highlightCode } = await loadHighlighter("token-failure", [brokenCore(`
    let loads = 0, calls = 0;
    export function createHighlighterCore() { return {
      loadLanguage: async () => { if (++loads === 1) throw new Error("grammar unavailable"); },
      codeToTokensWithThemes: (text) => { if (++calls === 1) throw new Error("tokenization failed"); return [[{ content: text, offset: 0, variants: { light: { color: "#123456" }, dark: { color: "#abcdef" } } }]]; }
    }; }`)]);
  assert.equal(await highlightCode("first", "js"), null);
  assert.equal(await highlightCode("second", "js"), null);
  assert.deepEqual(await highlightCode("third", "js"), [{ text: "third", light: "#123456", dark: "#abcdef" }]);
});

test("inconsistent token text falls back instead of changing the source", async () => {
  const { highlightCode } = await loadHighlighter("bad-token", [brokenCore(`
    export function createHighlighterCore() { return {
      loadLanguage: async () => {},
      codeToTokensWithThemes: () => [[{ content: "wrong", offset: 0, variants: {} }]]
    }; }`)]);
  assert.equal(await highlightCode("const unchanged = 42;", "js"), null);
});

test("browser bundle keeps the engine, themes and supported grammars outside the eager entry", async () => {
  const output = actual.output;
  const chunks = output.filter((item) => item.type === "chunk");
  const entry = chunks.find((chunk) => chunk.isEntry);
  assert.ok(entry);
  const eager = new Set();
  function visit(chunk) {
    if (eager.has(chunk)) return;
    eager.add(chunk);
    for (const filename of chunk.imports) {
      const dependency = chunks.find((item) => item.fileName === filename);
      if (dependency) visit(dependency);
    }
  }
  visit(entry);
  assert.equal([...eager].flatMap((chunk) => chunk.moduleIds).filter((id) => id.includes("node_modules/")).length, 0, "no library modules enter the eager import graph");
  const bundled = actual.workerModules;
  assert.ok(bundled.some((id) => id.includes("@shikijs/engine-javascript/")));
  assert.equal(bundled.some((id) => id.includes("@shikijs/engine-oniguruma/")), false);
  assert.deepEqual(bundled.filter((id) => /@shikijs\/langs\/dist\/[^/]+\.mjs$/.test(id)).map((id) => id.split("/").at(-1)).sort(), ["css.mjs", "html.mjs", "javascript.mjs", "json.mjs", "jsx.mjs", "python.mjs", "shellscript.mjs", "sql.mjs", "tsx.mjs", "typescript.mjs", "yaml.mjs"]);
  assert.deepEqual(bundled.filter((id) => /@shikijs\/themes\/dist\/[^/]+\.mjs$/.test(id)).map((id) => id.split("/").at(-1)).sort(), ["github-dark.mjs", "github-light.mjs"]);
});

test("cold concurrent workers completely color every supported short language", async () => {
  const clients = await Promise.all(Array.from({ length: Number(process.env.HIGHLIGHT_TEST_CONCURRENCY ?? 8) }, (_, id) => actual.fresh(`cold-${id}`)));
  await Promise.all(clients.map(async (client) => {
    const results = await Promise.all(examples.map(([tag, text]) => client.highlightCode(text, tag)));
    for (let i = 0; i < examples.length; i++) {
      const [tag, text, keyword] = examples[i], result = results[i];
      assert.ok(result, `${tag} completed`);
      assert.equal(result.map((token) => token.text).join(""), text);
      const token = result.find((token) => token.text === keyword);
      assert.ok(token, `${tag}: distinct ${keyword}`);
      assert.match(token.light, /^#[0-9a-f]{6,8}$/i);
      assert.match(token.dark, /^#[0-9a-f]{6,8}$/i);
      assert.notEqual(token.light, token.dark);
      assert.ok(result.some((other) => other.light && other.light !== token.light), `${tag}: complete syntax, not deadline-truncated foreground`);
    }
  }));
});

test("unsupported or bounded input and pre-aborted work never start a worker", async () => {
  const client = await actual.fresh("bounded-client"), before = workers.workers.length;
  const aborted = new AbortController(); aborted.abort();
  for (const [text, tag] of [["const x = 42;", "unknown"], ["x", "constructor"], ["", "js"], ["x".repeat(20_001), "js"], ["x".repeat(2_001), "js"], ["x\n".repeat(500), "js"]]) {
    assert.equal(await client.highlightCode(text, tag), null);
  }
  assert.equal(await client.highlightCode("const x = 42;", "js", aborted.signal), null);
  assert.equal(workers.workers.length, before);
  const tokens = await client.highlightCode("const x = 42;", "js");
  assert.deepEqual(tokens.find((token) => token.text === "const"), { text: "const", light: "#D73A49", dark: "#F97583" });
});

test("streaming aborts discard active results and remove stale queued work without restarting the worker", async () => {
  const client = await actual.fresh("streaming"), before = workers.workers.length;
  const first = new AbortController();
  const old = client.highlightCode('echo "old"', "bash", first.signal);
  first.abort();
  const stale = [];
  for (let i = 0; i < 100; i++) {
    const controller = new AbortController();
    stale.push(client.highlightCode(`const stale = ${i};`, "js", controller.signal));
    controller.abort();
  }
  const current = await client.highlightCode('echo "current"', "bash");
  assert.equal(await old, null); assert.deepEqual(await Promise.all(stale), Array(100).fill(null));
  assert.equal(current.map((token) => token.text).join(""), 'echo "current"');
  assert.deepEqual(current.find((token) => token.text === "echo"), { text: "echo", light: "#005CC5", dark: "#79B8FF" });
  assert.equal(workers.workers.length, before + 1);
  assert.deepEqual(workers.workers.at(-1).messages.map((message) => message.source), ['echo "old"', 'echo "current"']);
});

test("worker creation and startup failures stay plain; a later request retries successfully", async () => {
  const client = await actual.fresh("failed-worker");
  workers.behaviors.push("unavailable");
  assert.equal(await client.highlightCode("const x = 42;", "js"), null);
  workers.behaviors.push("crash");
  assert.equal(await client.highlightCode("const x = 42;", "js"), null);
  const tokens = await client.highlightCode("const retry = 42;", "js");
  assert.deepEqual(tokens.find((token) => token.text === "const"), { text: "const", light: "#D73A49", dark: "#F97583" });
});

test("a stuck worker does not block the main event loop, is terminated, and queued code recovers", async () => {
  const client = await actual.fresh("hung-worker");
  workers.behaviors.push("hang");
  const hanging = client.highlightCode("const hang = 42;", "js");
  const hungWorker = workers.workers.at(-1);
  // Queue is bounded even when the running worker cannot receive more messages.
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const waiting = controllers.map((controller) => client.highlightCode("const queued = 42;", "js", controller.signal));
  assert.equal(await client.highlightCode("const overflow = 42;", "js"), null);
  controllers.forEach((controller) => controller.abort());
  assert.deepEqual(await Promise.all(waiting), Array(32).fill(null));
  let heartbeat = false;
  await new Promise((resolve) => setTimeout(() => { heartbeat = true; resolve(); }, 25));
  assert.equal(heartbeat, true); assert.equal(hungWorker.terminated, undefined);
  const recovered = client.highlightCode("const recovered = 42;", "js");
  assert.equal(await hanging, null);
  assert.equal(hungWorker.terminated, true);
  const tokens = await recovered;
  assert.deepEqual(tokens.find((token) => token.text === "const"), { text: "const", light: "#D73A49", dark: "#F97583" });
  // Late errors/messages from a terminated worker cannot kill the replacement.
  hungWorker.onmessage({ data: { id: -1, tokens: null } });
  hungWorker.onerror({ preventDefault() {} });
  assert.equal((await client.highlightCode('echo "healthy"', "bash")).find((token) => token.text === "echo").light, "#005CC5");
});

test("a malformed worker response falls back without changing source and leaves subsequent calls usable", async () => {
  const client = await actual.fresh("malformed-worker");
  const pending = client.highlightCode("const unchanged = 42;", "js");
  const worker = workers.workers.at(-1), request = worker.messages[0];
  worker.onmessage({ data: { id: request.id, tokens: [{ text: "changed", light: "url(evil)" }] } });
  assert.equal(await pending, null);
  // Wait for its real reply before reusing this deliberately corrupted transport.
  await new Promise((resolve) => { const receive = worker.onmessage; worker.onmessage = (event) => { receive(event); resolve(); }; });
  const tokens = await client.highlightCode("const next = 42;", "js");
  assert.equal(tokens.map((token) => token.text).join(""), "const next = 42;");
  assert.deepEqual(tokens.find((token) => token.text === "const"), { text: "const", light: "#D73A49", dark: "#F97583" });
});

test("the line-length boundary is fully colored, while excessive token elements fall back safely", async () => {
  const source = "const answer = 42;".padEnd(2_000, " ");
  const tokens = await highlightCode(source, "js");
  assert.equal(tokens.map((token) => token.text).join(""), source);
  assert.deepEqual(tokens.find((token) => token.text === "const"), { text: "const", light: "#D73A49", dark: "#F97583" });
  const dense = ('"a";'.repeat(350) + "\n").repeat(10);
  assert.equal(await highlightCode(dense, "js"), null);
  const next = await highlightCode("const after = true;\r\n\t\r\n", "js");
  assert.equal(next.map((token) => token.text).join(""), "const after = true;\r\n\t\r\n");
  assert.deepEqual(next.find((token) => token.text === "const"), { text: "const", light: "#D73A49", dark: "#F97583" });
});
