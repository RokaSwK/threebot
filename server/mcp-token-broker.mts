// In-process MCP token broker: issues short-lived, revocable per-bot / per-run tokens
// so static master secrets do not have to live in Bot workspace configs.
import { randomBytes } from "node:crypto";

export type BrokeredToken = {
  token: string;
  botSlug: string;
  runId: string | null;
  issuedAt: number;
  expiresAt: number;
};

export function createMcpTokenBroker({
  defaultTtlMs = 4 * 60 * 60 * 1000,
  now = () => Date.now(),
}: {
  defaultTtlMs?: number;
  now?: () => number;
} = {}) {
  const active = new Map<string, BrokeredToken>();

  function prune(at = now()) {
    for (const [tok, entry] of active) {
      if (entry.expiresAt <= at) active.delete(tok);
    }
  }

  function issue(botSlug: string, { ttlMs = defaultTtlMs, runId = null }: { ttlMs?: number; runId?: string | null } = {}): BrokeredToken {
    const at = now();
    prune(at);
    const token = `tb_mcp_${randomBytes(24).toString("hex")}`;
    const entry: BrokeredToken = {
      token,
      botSlug,
      runId,
      issuedAt: at,
      expiresAt: at + Math.max(1_000, ttlMs),
    };
    active.set(token, entry);
    return entry;
  }

  function verify(raw: string): BrokeredToken | null {
    if (!raw || !raw.startsWith("tb_mcp_")) return null;
    const entry = active.get(raw);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      active.delete(raw);
      return null;
    }
    return entry;
  }

  function revoke(token: string): boolean {
    return active.delete(token);
  }

  function revokeBot(botSlug: string): number {
    let removed = 0;
    for (const [tok, entry] of active) {
      if (entry.botSlug === botSlug) {
        active.delete(tok);
        removed++;
      }
    }
    return removed;
  }

  function activeForBot(botSlug: string): BrokeredToken[] {
    const at = now();
    prune(at);
    return [...active.values()].filter((entry) => entry.botSlug === botSlug);
  }

  return { issue, verify, revoke, revokeBot, activeForBot, prune };
}

export type McpTokenBroker = ReturnType<typeof createMcpTokenBroker>;
