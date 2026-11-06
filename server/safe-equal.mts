import { timingSafeEqual } from "node:crypto";

// timingSafeEqual throws unless both sides have the same byte length, and a string's length counts
// characters, so "é" and "e" look equal in length. Compare bytes, so any mismatch is just false.
export function safeEqual(given: unknown, expected: unknown): boolean {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
