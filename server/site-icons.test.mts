import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createSiteIcons, iconLinks, isPublicAddress, normalizeDomain } from "./site-icons.mts";

const png = await sharp({ create: { width: 180, height: 180, channels: 4, background: "#f00" } }).png().toBuffer();
const reply = (body: BodyInit, type: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": type, ...headers } });
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const withDir = async (run: (dir: string) => Promise<void>) => { const dir = await mkdtemp(path.join(os.tmpdir(), "site-icons-")); try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); } };

test("only real public hostnames are accepted", () => {
  assert.equal(normalizeDomain(" GitHub.com. "), "github.com");
  for (const bad of ["localhost", "127.0.0.1", "http://github.com", "a b.com", "", null, "intranet"]) assert.equal(normalizeDomain(bad), null, String(bad));
});

test("private, loopback and metadata addresses are refused", () => {
  for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.137", "100.87.182.51", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) assert.equal(isPublicAddress(address), true, address);
});

test("the largest declared icon comes first", () => {
  const links = iconLinks('<link rel="icon" href="/small.png" sizes="16x16"><link href="/big.png" rel="apple-touch-icon" sizes="180x180"><link rel="stylesheet" href="/x.css">', "https://example.com/");
  assert.deepEqual(links.map(String), ["https://example.com/big.png", "https://example.com/small.png"]);
});

test("a site's own icon is re-encoded, cached and fetched once", async () => withDir(async (dir) => {
  const seen: string[] = [];
  const fetcher = async (url: URL) => { seen.push(url.pathname); return url.pathname === "/" ? reply('<link rel="icon" href="/i.png">', "text/html") : reply(png, "image/png"); };
  const icons = createSiteIcons({ dir, fetcher, resolve: publicDns });
  const icon = await icons.get("example.com");
  assert.equal(icon!.type, "image/png");
  assert.equal((await sharp(icon!.bytes).metadata()).width, 96);
  await icons.get("example.com");
  assert.deepEqual(seen, ["/", "/i.png"]);
}));

test("a redirect into the local network is not followed", async () => withDir(async (dir) => {
  const seen: string[] = [];
  const resolve = async (host: string) => [{ address: host === "example.com" ? "93.184.216.34" : "192.168.1.1", family: 4 }];
  const fetcher = async (url: URL) => { seen.push(url.hostname); return reply("", "text/plain", 302, { location: "https://router.example.org/" }); };
  assert.equal(await createSiteIcons({ dir, fetcher, resolve }).get("example.com"), null);
  assert.ok(!seen.includes("router.example.org"));
}));

test("a hostname that resolves privately is never contacted", async () => withDir(async (dir) => {
  let called = 0;
  const icon = await createSiteIcons({ dir, fetcher: async () => { called++; return reply(png, "image/png"); }, resolve: async () => [{ address: "10.0.0.5", family: 4 }] }).get("internal.example.com");
  assert.equal(icon, null);
  assert.equal(called, 0);
}));

test("files that aren't images are not served as logos", async () => withDir(async (dir) => {
  const fetcher = async () => reply("<script>alert(1)</script>", "text/html");
  assert.equal(await createSiteIcons({ dir, fetcher, resolve: publicDns }).get("example.com"), null);
}));

test("a site that fails to answer is tried again instead of being remembered as having no logo", async () => withDir(async (dir) => {
  let calls = 0;
  const fetcher = async (url: URL) => { calls++; if (calls <= 2) throw new Error("timed out"); return url.pathname === "/" ? reply("<html></html>", "text/html") : reply(png, "image/png"); };
  const icons = createSiteIcons({ dir, fetcher, resolve: publicDns });
  assert.equal(await icons.get("example.com"), null);
  assert.equal((await icons.get("example.com"))!.type, "image/png");
}));
