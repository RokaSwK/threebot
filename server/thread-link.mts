import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

/** One machine from `t3 environment list --json`, as far as this file reads it (the CLI's own JSON). */
export type ThreadLink = { environmentId?: unknown; status?: unknown; urls?: unknown };
export type ThreadTarget = { environmentId: string; threadId: string };
/** Runs the T3 CLI; only `stdout` is read. */
export type ExecCli = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

export function linkedThreadUrl(links: unknown, { environmentId, threadId }: ThreadTarget): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId) || threadId.length > 1024 || !/^(?:[a-zA-Z0-9:_-]|%[a-fA-F0-9]{2}){1,1024}$/.test(threadId)) throw Object.assign(new Error("Invalid thread reference"), { status: 400 });
  const link = Array.isArray(links) ? (links as (ThreadLink | null | undefined)[]).find((entry) => entry?.environmentId === environmentId) : null;
  if (!link || link.status === "expired") throw Object.assign(new Error("This machine is no longer linked in T3 Code."), { status: 404 });
  for (const base of Array.isArray(link.urls) ? link.urls : []) {
    try {
      const url = new URL(base);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (url.username || url.password) continue;
      url.pathname = `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
      url.search = ""; url.hash = "";
      return url.href;
    } catch { /* A malformed stored address is not a redirect destination. */ }
  }
  throw Object.assign(new Error("This linked machine has no usable T3 Code address."), { status: 502 });
}

/** Use T3's supported CLI for public connection metadata; credentials never leave T3. */
export function createThreadLinkResolver({ cli = process.env.T3_CLI, home = process.env.HOME, exec = run }: { cli?: string; home?: string; exec?: ExecCli } = {}): (target: ThreadTarget) => Promise<string> {
  let cached: unknown[] | null = null;
  let expiresAt = 0;
  let pending: Promise<unknown[]> | null = null;
  const list = async (): Promise<unknown[]> => {
    if (cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      let command: string | undefined = cli;
      if (!command && home) {
        const candidate = path.join(home, ".local/bin/t3");
        if (await access(candidate, constants.X_OK).then(() => true, () => false)) command = candidate;
      }
      const { stdout } = await exec(command ?? "t3", ["environment", "list", "--json"], { timeout: 15000, maxBuffer: 1024 * 1024 });
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error("T3 did not return its linked machines.");
      cached = parsed; expiresAt = Date.now() + 60000;
      return parsed;
    })();
    try { return await pending; } finally { pending = null; }
  };
  return async (target: ThreadTarget) => linkedThreadUrl(await list(), target);
}
