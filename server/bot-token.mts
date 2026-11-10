// Per-Bot bearers for the "bot" MCP server. The long-lived BOT_MCP_TOKEN is the secret; each Bot
// gets an HMAC of its slug, so a leaked token cannot be reused for another Bot's memory.
import { createHmac, timingSafeEqual } from "node:crypto";

export function tokenForBot(secret: string, slug: string): string {
  return createHmac("sha256", secret).update(`threebot-bot:${slug}`).digest("hex");
}

/** The raw bearer from an Authorization header, or null. */
export function bearerToken(header: unknown): string | null {
  const match = /^Bearer\s+(.+)$/iu.exec(String(header ?? "").trim());
  return match?.[1]?.trim() || null;
}

/** Constant-time comparison; a different length is simply not a match. */
export function tokenMatches(value: string | null | undefined, expected: string | null | undefined): boolean {
  if (!value || !expected) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
