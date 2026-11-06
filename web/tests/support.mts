// Shared typing for the web tests: they build the app with Vite and drive it through happy-dom.
import assert from "node:assert/strict";
import type { Window as HappyWindow } from "happy-dom";
import { build, type InlineConfig } from "vite";

/** One finished Vite build: the tests never pass several outputs or `watch`. */
export type BuildOutput = Extract<Awaited<ReturnType<typeof build>>, { output: unknown }>;

/** Run a single, non-watching Vite build and return its bundle. */
export async function buildOnce(config: InlineConfig): Promise<BuildOutput> {
  const result = await build(config);
  assert.ok(!Array.isArray(result) && "output" in result, "Vite returned one finished build");
  return result;
}

/**
 * happy-dom's window, typed as the DOM one. happy-dom implements the DOM, but declares it as its own
 * parallel class tree, which TypeScript won't accept where DOM types are expected (and the app's code
 * the tests drive expects DOM types). `happyDOM` stays reachable for closing the window.
 */
export type TestWindow = Window & typeof globalThis & { happyDOM: HappyWindow["happyDOM"] };
export const domWindow = (window: HappyWindow): TestWindow => window as unknown as TestWindow;

/** The entry chunk of an SSR test bundle: the module the test imports. */
export function entryChunk(bundle: BuildOutput) {
  const entry = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
  assert.ok(entry?.type === "chunk", "the bundle has an entry chunk");
  return entry;
}
