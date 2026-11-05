import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAccessStore, createRemoteAccess, hashPassword, parseTailscaleStatus, pickServePort, serveOwner, startQuickTunnel, tailnetUrl, verifyPassword } from "./remote-access.mjs";

const running = { BackendState: "Running", Self: { DNSName: "box.tail1.ts.net.", UserID: 7, CapMap: { https: null } }, User: { 7: { LoginName: "Me@Example.com" } } };

test("Tailscale's status becomes the few facts the setup needs", () => {
  assert.deepEqual(parseTailscaleStatus(running), { state: "Running", running: true, needsLogin: false, authUrl: null, dnsName: "box.tail1.ts.net", https: true, login: "Me@Example.com" });
  const out = parseTailscaleStatus({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/x", Self: {} });
  assert.equal(out.needsLogin, true);
  assert.equal(out.authUrl, "https://login.tailscale.com/a/x");
  assert.equal(parseTailscaleStatus({ BackendState: "Running", Self: { CapMap: {} }, CertDomains: [] }).https, false);
});

test("Serve gets a free HTTPS port, and an existing route to this listener is reused", () => {
  const serve = { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } }, Web: { "box:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8770" } } }, "box:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } } } };
  assert.deepEqual(pickServePort(serve, "http://127.0.0.1:3781"), { port: 8444, ours: false });
  assert.deepEqual(pickServePort({}, "http://127.0.0.1:3781"), { port: 443, ours: false });
  const mine = { ...serve, Web: { ...serve.Web, "box:8444": { Handlers: { "/": { Proxy: "http://127.0.0.1:3781" } } } } };
  assert.deepEqual(pickServePort(mine, "http://127.0.0.1:3781"), { port: 8444, ours: true });
  assert.equal(serveOwner(mine, 8443), "http://127.0.0.1:3773");
  assert.equal(tailnetUrl("box.ts.net", 443), "https://box.ts.net");
  assert.equal(tailnetUrl("box.ts.net", 8444), "https://box.ts.net:8444");
});

test("passwords are stored as scrypt hashes and checked against them", async () => {
  const stored = await hashPassword("correct horse");
  assert.equal(JSON.stringify(stored).includes("correct horse"), false);
  assert.equal(await verifyPassword("correct horse", stored), true);
  assert.equal(await verifyPassword("correct hors", stored), false);
  assert.equal(await verifyPassword(undefined, stored), false);
});

function setup({ tsStatus = { installed: true, ...parseTailscaleStatus(running) }, serveConfig = {}, envPassword = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "tb-access-"));
  const calls = [];
  const exposure = { tailnetPort: 0, tailnetUsers: new Set() };
  const tailscale = {
    status: async () => tsStatus,
    serveConfig: async () => serveConfig,
    serve: async (port, url) => { calls.push(["serve", port, url]); serveConfig = { Web: { [`box:${port}`]: { Handlers: { "/": { Proxy: url } } } } }; },
    unserve: async (port) => { calls.push(["unserve", port]); serveConfig = {}; },
  };
  let stopped = 0;
  const access = createRemoteAccess({
    store: createAccessStore(path.join(dir, "access.json")), home: dir, localPort: 3780, urlFile: path.join(dir, "tunnel-url"), exposure, envPassword,
    openTailnet: async (port, users) => { calls.push(["open", port, users]); exposure.tailnetPort = port; },
    closeTailnet: async () => { calls.push(["close"]); exposure.tailnetPort = 0; },
    tailscale, tunnelBin: () => "/bin/cloudflared", installTunnelBin: async () => "/bin/cloudflared",
    startTunnel: async ({ localUrl, onExit }) => { calls.push(["tunnel", localUrl]); return { url: "https://abc-def.trycloudflare.com", stop: () => { stopped++; onExit(0); } }; },
    log: {},
  });
  return { dir, calls, access, stopped: () => stopped };
}

test("Tailscale turns on in one call: listener for the signed-in user, then Serve on a free port", async () => {
  const { calls, access } = setup();
  const { url } = await access.tailscaleOn();
  assert.equal(url, "https://box.tail1.ts.net");
  assert.deepEqual(calls, [["open", 3781, ["me@example.com"]], ["serve", 443, "http://127.0.0.1:3781"]]);
  const status = await access.status();
  assert.equal(status.tailscale.enabled, true);
  assert.equal(status.tailscale.serving, true);
  await access.tailscaleOff();
  assert.deepEqual(calls.slice(2), [["unserve", 443], ["close"]]);
});

test("Tailscale explains what's missing instead of half setting up", async () => {
  for (const [tsStatus, code] of [[{ installed: false }, "not-installed"], [{ installed: true, running: false, needsLogin: true }, "needs-login"], [{ installed: true, running: true, https: false, login: "a@b" }, "https-off"]]) {
    const { calls, access } = setup({ tsStatus });
    await assert.rejects(access.tailscaleOn(), (error) => error.code === code);
    assert.deepEqual(calls, []);
  }
});

test("a public Cloudflare link needs a password, and its address is left for `threebot tunnel status`", async () => {
  const { dir, calls, access, stopped } = setup();
  await assert.rejects(access.tunnelOn(), (error) => error.code === "needs-password");
  await assert.rejects(access.setPassword("short"), /at least 8/);
  await access.setPassword("long enough");
  assert.equal(await access.verify("long enough"), true);
  assert.equal((await access.tunnelOn()).url, "https://abc-def.trycloudflare.com");
  assert.deepEqual(calls, [["tunnel", "http://127.0.0.1:3780"]]);
  assert.equal(readFileSync(path.join(dir, "tunnel-url"), "utf8").trim(), "https://abc-def.trycloudflare.com");
  await assert.rejects(access.setPassword(null), /Turn off the Cloudflare link/);
  await access.tunnelOff();
  assert.equal(stopped(), 1);
  assert.equal((await access.status()).tunnel.error, null, "turning it off isn't reported as a failure");
  assert.equal(existsSync(path.join(dir, "tunnel-url")), false);
});

test("what was on comes back when the gateway starts", async () => {
  const first = setup();
  await first.access.setPassword("long enough");
  await first.access.tailscaleOn();
  await first.access.tunnelOn();
  const again = createRemoteAccess({
    store: createAccessStore(path.join(first.dir, "access.json")), home: first.dir, localPort: 3780, exposure: { tailnetPort: 0, tailnetUsers: new Set() },
    openTailnet: async (port, users) => { again.opened = [port, users]; }, closeTailnet: async () => {},
    tailscale: { status: async () => ({ installed: true }), serveConfig: async () => ({}) },
    tunnelBin: () => "/bin/cloudflared", startTunnel: async () => ({ url: "https://new.trycloudflare.com", stop() {} }), log: {},
  });
  await again.boot();
  assert.deepEqual(again.opened, [3781, ["me@example.com"]]);
  assert.equal((await again.status()).tunnel.url, "https://new.trycloudflare.com");
});

test("the env password wins and can't be changed from the app", async () => {
  const { access } = setup({ envPassword: "from-env" });
  assert.equal((await access.status()).password.fromEnv, true);
  await assert.rejects(access.setPassword("something else"), /BOT_PASSWORD/);
});

test("the quick tunnel's link is read from cloudflared's output", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit("exit", null);
  let exited = null;
  const started = startQuickTunnel({ bin: "cloudflared", localUrl: "http://127.0.0.1:3780", spawnImpl: (bin, args) => { assert.deepEqual(args, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", "http://127.0.0.1:3780"]); return child; }, onExit: (code) => { exited = code; } });
  child.stderr.emit("data", "INF Requesting new quick Tunnel on trycloudflare.com...\n");
  child.stderr.emit("data", "INF |  https://brave-otter-12.trycloudflare.com  |\n");
  let early = false;
  started.then(() => { early = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(early, false, "the link isn't handed out before a connection is registered");
  child.stderr.emit("data", "INF Registered tunnel connection connIndex=0 protocol=http2\n");
  const tunnel = await started;
  assert.equal(tunnel.url, "https://brave-otter-12.trycloudflare.com");
  tunnel.stop();
  assert.equal(exited, null);
});
