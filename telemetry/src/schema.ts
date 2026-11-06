// The one ping shape the collector accepts (schema 1). It rebuilds the ping from known fields only, so
// anything else a client sends is dropped, and refuses values outside the documented forms.

export const SCHEMA = 1;
export const MAX_BODY_BYTES = 16 * 1024;
const BUCKETS = ["0", "1", "2-5", "6-10", "11+"] as const;
export type Bucket = (typeof BUCKETS)[number];
export type ModelUsage = { turns: number; inputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number };
export type Ping = {
  schema: typeof SCHEMA;
  installId: string;
  threebot: string;
  t3code: string | null;
  node: string;
  os: string;
  arch: string;
  bots: Bucket;
  routines: Bucket | null;
  features: { projects: boolean; autoUpdate: boolean; freshSessionRoutines: boolean };
  tokens: Record<string, ModelUsage> | null;
};
export type Result = { ok: true; ping: Ping } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^(?:\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,48})?|other)$/;
const OS = new Set(["linux", "darwin", "win32", "freebsd", "openbsd", "android", "other"]);
const ARCH = new Set(["x64", "arm64", "arm", "ia32", "riscv64", "ppc64", "s390x", "loong64", "other"]);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/;
const MAX_MODELS = 31; // 30 named models plus "other"
// A day of tokens past this is a broken client, not usage.
const MAX_TOKENS = 1e13;
const MAX_TURNS = 1e7;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

export function validatePing(body: unknown): Result {
  const fail = (error: string): Result => ({ ok: false, error });
  if (!record(body)) return fail("body must be an object");
  if (body.schema !== SCHEMA) return fail("unknown schema");
  if (typeof body.installId !== "string" || !UUID.test(body.installId)) return fail("installId must be a random UUID");
  for (const key of ["threebot", "node"] as const) if (typeof body[key] !== "string" || !VERSION.test(body[key])) return fail(`${key} must be a version`);
  if (body.t3code !== null && (typeof body.t3code !== "string" || !VERSION.test(body.t3code))) return fail("t3code must be a version or null");
  if (typeof body.os !== "string" || !OS.has(body.os)) return fail("unknown os");
  if (typeof body.arch !== "string" || !ARCH.has(body.arch)) return fail("unknown arch");
  if (!BUCKETS.includes(body.bots as Bucket)) return fail("bots must be a bucket");
  if (body.routines !== null && !BUCKETS.includes(body.routines as Bucket)) return fail("routines must be a bucket or null");
  const f = body.features;
  if (!record(f) || typeof f.projects !== "boolean" || typeof f.autoUpdate !== "boolean" || typeof f.freshSessionRoutines !== "boolean") return fail("features must be three switches");
  let tokens: Ping["tokens"] = null;
  if (body.tokens !== undefined) {
    if (!record(body.tokens)) return fail("tokens must be an object");
    const entries = Object.entries(body.tokens);
    if (entries.length > MAX_MODELS) return fail("too many models");
    tokens = {};
    for (const [model, usage] of entries) {
      if (!MODEL.test(model)) return fail("bad model id");
      if (!record(usage) || !count(usage.turns, MAX_TURNS)) return fail(`bad usage for ${model}`);
      for (const key of ["inputTokens", "cachedInputTokens", "cacheCreationTokens", "outputTokens"] as const) if (!count(usage[key], MAX_TOKENS)) return fail(`bad ${key} for ${model}`);
      tokens[model] = { turns: usage.turns as number, inputTokens: usage.inputTokens as number, cachedInputTokens: usage.cachedInputTokens as number, cacheCreationTokens: usage.cacheCreationTokens as number, outputTokens: usage.outputTokens as number };
    }
  }
  return { ok: true, ping: {
    schema: SCHEMA, installId: body.installId, threebot: body.threebot as string, t3code: body.t3code as string | null, node: body.node as string,
    os: body.os, arch: body.arch, bots: body.bots as Bucket, routines: body.routines as Bucket | null,
    features: { projects: f.projects, autoUpdate: f.autoUpdate, freshSessionRoutines: f.freshSessionRoutines }, tokens,
  } };
}
