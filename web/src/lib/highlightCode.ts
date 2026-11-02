import { boundedCode, codeLanguage, readTokens, type CodeToken, type HighlightRequest } from "./highlightCode.shared";
export type { CodeToken } from "./highlightCode.shared";

type Job = { request: HighlightRequest; cancelled: boolean; settle: (tokens: CodeToken[] | null) => void };
const queue: Job[] = [];
let worker: Worker | undefined;
let active: { job: Job; timer: ReturnType<typeof setTimeout> } | undefined;
let nextId = 0;

function finish(tokens: CodeToken[] | null) {
  if (!active) return;
  const { job, timer } = active;
  clearTimeout(timer);
  active = undefined;
  job.settle(job.cancelled ? null : tokens);
  drain();
}

function failed() {
  worker?.terminate();
  worker = undefined;
  finish(null);
}

function drain() {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  // This watchdog covers loading and complete tokenization, and can interrupt
  // synchronous regex work. It never accepts Shiki's silent partial coloring.
  active = { job, timer: setTimeout(failed, 5_000) };
  try {
    if (!worker) {
      worker = new Worker(new URL("./highlightCode.worker.ts", import.meta.url), { type: "module" });
      const owner = worker;
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (worker !== owner) return;
        const reply = event.data;
        if (!active || !reply || typeof reply !== "object" || !("id" in reply) || reply.id !== active.job.request.id || !("tokens" in reply)) {
          failed();
          return;
        }
        finish(readTokens(reply.tokens, active.job.request.source));
      };
      worker.onerror = (event) => { event.preventDefault(); if (worker === owner) failed(); };
      worker.onmessageerror = () => { if (worker === owner) failed(); };
    }
    worker.postMessage(job.request);
  } catch {
    failed();
  }
}

/** Plain source renders first; no grammar or regex engine runs on the UI thread. */
export function highlightCode(source: string, tag: string, signal?: AbortSignal): Promise<CodeToken[] | null> {
  const language = codeLanguage(tag);
  if (!language || !boundedCode(source) || signal?.aborted || queue.length >= 32) return Promise.resolve(null);
  return new Promise((resolve) => {
    const job: Job = {
      request: { id: ++nextId, source, language }, cancelled: false,
      settle(tokens) { signal?.removeEventListener("abort", cancel); resolve(tokens); },
    };
    function cancel() {
      job.cancelled = true;
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
      job.settle(null);
      // An active scan may finish and warm the worker; its result is discarded.
      // Queued replacements are removed immediately, so streaming cannot build
      // an unbounded backlog or repeatedly restart cold grammar compilation.
    }
    signal?.addEventListener("abort", cancel, { once: true });
    queue.push(job);
    drain();
  });
}
