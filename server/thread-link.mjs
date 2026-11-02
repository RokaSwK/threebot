import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

export function linkedThreadUrl(links, { environmentId, threadId }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId) || threadId.length > 1024 || !/^(?:[a-zA-Z0-9:_-]|%[a-fA-F0-9]{2}){1,1024}$/.test(threadId)) throw Object.assign(new Error("Invalid thread reference"), { status: 400 });
  const link = Array.isArray(links) ? links.find((entry) => entry?.environmentId === environmentId) : null;
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
export function createThreadLinkResolver({ cli = process.env.T3_CLI, home = process.env.HOME, exec = run } = {}) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  const list = async () => {
    if (cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      let command = cli;
      if (!command && home) {
        const candidate = path.join(home, ".local/bin/t3");
        if (await access(candidate, constants.X_OK).then(() => true, () => false)) command = candidate;
      }
      const { stdout } = await exec(command ?? "t3", ["environment", "list", "--json"], { timeout: 15000, maxBuffer: 1024 * 1024 });
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error("T3 did not return its linked machines.");
      cached = parsed; expiresAt = Date.now() + 60000;
      return parsed;
    })();
    try { return await pending; } finally { pending = null; }
  };
  return async (target) => linkedThreadUrl(await list(), target);
}
