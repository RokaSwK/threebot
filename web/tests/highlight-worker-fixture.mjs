import { Worker as NodeWorker } from "node:worker_threads";
import { build } from "vite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Only adapt the browser worker transport. The emitted production worker,
// Shiki, grammars and client scheduler all execute without replacement.
export function installWorkers() {
  const original = globalThis.Worker;
  const workers = [];
  const behaviors = [];
  globalThis.Worker = class {
    constructor(url) {
      this.messages = [];
      const behavior = behaviors.shift();
      if (behavior === "unavailable") throw new Error("Workers unavailable");
      this.node = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from "node:worker_threads";
        globalThis.self = globalThis;
        globalThis.postMessage = (data) => parentPort.postMessage(data);
        if (workerData.behavior === "hang") { while (true) {} }
        if (workerData.behavior === "crash") throw new Error("Worker failed to load");
        await import(workerData.url);
        parentPort.on("message", (data) => self.onmessage({ data }));
      `)}`), { workerData: { url: url.href, behavior } });
      this.node.on("message", (data) => this.onmessage?.({ data }));
      this.node.on("error", (error) => this.onerror?.({ error, preventDefault() {} }));
      workers.push(this);
    }
    postMessage(data) { this.messages.push(data); this.node.postMessage(data); }
    terminate() { this.terminated = true; return this.node.terminate(); }
  };
  return {
    workers, behaviors,
    async close() {
      await Promise.all(workers.map((worker) => worker.terminate()));
      if (original === undefined) delete globalThis.Worker;
      else globalThis.Worker = original;
    },
  };
}

export async function loadWorkerHighlighter() {
  const directory = await mkdtemp(join(tmpdir(), "bot-highlight-worker-"));
  const workerModules = new Set();
  const result = await build({
    configFile: false, logLevel: "silent", base: "./",
    worker: { plugins: () => [{
      name: "inspect-highlight-worker",
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) if (chunk.type === "chunk") {
          for (const id of chunk.moduleIds) workerModules.add(id);
        }
      },
    }] },
    build: {
      lib: { entry: new URL("../src/lib/highlightCode.ts", import.meta.url).pathname, formats: ["es"] },
      write: false, rolldownOptions: { output: { entryFileNames: "entry.mjs", chunkFileNames: "[name]-[hash].mjs" } },
    },
  });
  const output = Array.isArray(result) ? result.flatMap((build) => build.output) : result.output;
  for (const item of output) {
    const filename = join(directory, item.fileName);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, item.type === "chunk" ? item.code : item.source);
  }
  const client = await import(pathToFileURL(join(directory, "entry.mjs")).href);
  return { ...client, fresh: (id) => import(pathToFileURL(join(directory, "entry.mjs")).href + `?client=${id}`), output, workerModules: [...workerModules], close: () => rm(directory, { recursive: true }) };
}
