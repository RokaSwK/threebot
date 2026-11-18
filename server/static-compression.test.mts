import { test } from "node:test";
import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createCompressionCache, encodeBody, isCompressible, pickEncoding } from "./static-compression.mts";

test("negotiation prefers the best coding the client accepts", () => {
  assert.equal(pickEncoding(undefined), "identity", "no header means identity");
  assert.equal(pickEncoding(""), "identity");
  assert.equal(pickEncoding("gzip, deflate, br"), "br");
  assert.equal(pickEncoding("gzip, deflate"), "gzip");
  assert.equal(pickEncoding("br"), "br");
  assert.equal(pickEncoding("identity"), "identity");
});

test("negotiation honours q-values instead of the first name it sees", () => {
  assert.equal(pickEncoding("br;q=0, gzip"), "gzip", "q=0 is a refusal");
  assert.equal(pickEncoding("br;q=0.4, gzip;q=0.9"), "gzip");
  assert.equal(pickEncoding("br;q=0.9, gzip;q=0.4"), "br");
  assert.equal(pickEncoding("gzip;q=0, br;q=0"), "identity");
  assert.equal(pickEncoding("*"), "br", "a wildcard covers the codings it does not name");
  assert.equal(pickEncoding("*;q=0"), "unacceptable");
  assert.equal(pickEncoding("br;q=bogus"), "identity");
});

test("only text above the floor is worth compressing", () => {
  for (const ext of [".html", ".js", ".mjs", ".css", ".svg", ".json", ".webmanifest"]) assert.equal(isCompressible(ext, 4096), true, ext);
  for (const ext of [".png", ".jpg", ".webp", ".woff2", ".mp4", ".ico"]) assert.equal(isCompressible(ext, 4096), false, ext);
  assert.equal(isCompressible(".js", 400), false, "a tiny file costs more than it saves");
});

test("encoded bodies decode to the original bytes", async () => {
  const raw = Buffer.from("export const answer = 42;\n".repeat(400));
  for (const encoding of ["br", "gzip"] as const) {
    const body = await encodeBody(raw, encoding);
    assert.ok(body.length < raw.length, `${encoding} must shrink a repetitive bundle`);
    const decoded = encoding === "br" ? brotliDecompressSync(body) : gunzipSync(body);
    assert.deepEqual(decoded, raw);
  }
});

test("the cache shares one compression and drops the oldest entry", async () => {
  const cache = createCompressionCache(100);
  let loads = 0;
  const load = async () => { loads++; return Buffer.alloc(40, 1); };
  const [a, b] = await Promise.all([cache.get("one", load), cache.get("one", load)]);
  assert.equal(loads, 1, "two requests for the same file share one compression");
  assert.equal(a, b);
  await cache.get("two", async () => Buffer.alloc(40, 2));
  assert.equal(cache.bytes, 80);
  await cache.get("three", async () => Buffer.alloc(40, 3));
  assert.equal(cache.bytes, 80, "the oldest entry makes room");
  let reloaded = 0;
  await cache.get("one", async () => { reloaded++; return Buffer.alloc(40, 1); });
  assert.equal(reloaded, 1, "the evicted entry is compressed again");
  assert.equal((await cache.get("three", load))[0], 3, "the newest entry survives");
});
