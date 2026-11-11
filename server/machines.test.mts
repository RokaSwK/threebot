import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMachines, machineStatus, pairedRoutesFile, safeOrigin, type PeerLink } from "./machines.mts";
import { createEnvironmentRouter } from "./environment-routes.mts";

const LOCAL = { environmentId: "this-mac", label: "Air M5", serverVersion: "0.1.9", platform: { machine: "laptop" }, capabilities: { peerLinks: true } };
const link = (environmentId: string, label: string, status: PeerLink["status"], urls = [`https://${environmentId}.ts.net`]): PeerLink =>
  ({ environmentId, label, urls, status, lastReachedAt: "2026-11-10T08:00:00.000Z", lastError: null });

/** Each machine's unauthenticated descriptor, plus a Threebot health check on the NAS. */
function network(descriptors: Record<string, object>, health: Record<string, string> = {}) {
  const asked: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    asked.push(url);
    const u = new URL(url);
    if (u.pathname === "/.well-known/t3/environment" && descriptors[u.origin]) return Response.json(descriptors[u.origin]);
    if (u.pathname === "/api/health" && health[u.hostname]) return Response.json({ ok: true, version: health[u.hostname] });
    if (u.pathname === "/oauth/token" && init.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
      return body.get("subject_token") === "GOODCODE" ? Response.json({ access_token: "peer-session", token_type: "Bearer", expires_in: 3600 }) : new Response("{}", { status: 401 });
    }
    return new Response("nope", { status: 404 });
  };
  return { asked, fetcher };
}

test("linked machines come from T3 with status, versions and how the gateway reaches them; this machine is first", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "machines-"));
  try {
    const net = network({ "https://nas.ts.net": { environmentId: "nas", serverVersion: "0.1.9-nas", platform: { machine: "server" } } }, { "nas.ts.net": "0.1.6" });
    let links = [link("nas", "truenas", "reachable"), link("m4", "Pro M4", "unreachable"), link("old", "Old box", "expired")];
    let now = Date.parse("2026-11-11T12:00:00.000Z");
    const machines = createMachines({ appDir: root, t3Url: "http://127.0.0.1:3773", version: "0.1.7", fetcher: net.fetcher, now: () => now,
      localDescriptor: async () => LOCAL, listLinks: async () => links, routeFiles: async () => ({}) });
    const first = await machines.list();
    assert.deepEqual(first.machines.map((m) => [m.label, m.status, m.route]), [["Air M5", "online", "local"], ["truenas", "online", "linked"], ["Pro M4", "unreachable", "linked"], ["Old box", "expired", "none"]]);
    assert.equal(first.linksSupported, true);
    const nas = first.machines[1];
    assert.equal(nas.t3Version, "0.1.9-nas");
    assert.equal(nas.threebotVersion, "0.1.6");
    assert.equal(nas.lastSeenAt, "2026-11-11T12:00:00.000Z");
    assert.equal(first.machines[0].threebotVersion, "0.1.7");
    // Only reachable machines are probed, and never with a credential.
    assert.ok(!net.asked.some((url) => url.includes("m4")));
    // A laptop T3 has seen answer, then stop answering, reads as asleep; the last-seen time stays.
    links = [link("m5", "Air M5 (2)", "reachable", ["https://m5.ts.net"])];
    const laptop = network({ "https://m5.ts.net": { environmentId: "m5", serverVersion: "0.1.9", platform: { machine: "laptop" } } });
    const again = createMachines({ appDir: root, t3Url: "x", version: "0.1.7", fetcher: laptop.fetcher, now: () => now, localDescriptor: async () => LOCAL, listLinks: async () => links, routeFiles: async () => ({}) });
    assert.equal((await again.list({ maxAge: 0 })).machines[1].status, "online");
    now += 3600_000;
    links = [link("m5", "Air M5 (2)", "unreachable", ["https://m5.ts.net"])];
    const asleep = (await again.list({ maxAge: 0 })).machines[1];
    assert.equal(asleep.status, "asleep");
    assert.equal(asleep.lastSeenAt, "2026-11-11T12:00:00.000Z");
  } finally { await rm(root, { recursive: true }); }
});

test("an older T3 without links falls back to the hand-written routes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "machines-"));
  try {
    const net = network({ "https://peer.test": { environmentId: "peer", label: "Peer", serverVersion: "0.1.5" } });
    const machines = createMachines({ appDir: root, t3Url: "x", version: "0.1.7", fetcher: net.fetcher,
      localDescriptor: async () => ({ ...LOCAL, capabilities: {} }), listLinks: async () => null, routeFiles: async () => ({ peer: { baseUrl: "https://peer.test" } }) });
    const { machines: list, linksSupported } = await machines.list();
    assert.equal(linksSupported, false);
    assert.deepEqual(list.map((m) => [m.environmentId, m.status, m.route, m.t3Version]), [["this-mac", "online", "local", "0.1.9"], ["peer", "online", "direct", "0.1.5"]]);
  } finally { await rm(root, { recursive: true }); }
});

test("pairing swaps a one-time code for a private direct route the environment router then uses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "machines-"));
  try {
    const net = network({ "https://nas.ts.net": { environmentId: "nas" } });
    const machines = createMachines({ appDir: root, t3Url: "x", version: "0.1.7", fetcher: net.fetcher,
      localDescriptor: async () => LOCAL, listLinks: async () => [link("nas", "truenas", "reachable", ["http://nas.lan:3773", "https://nas.ts.net"])], routeFiles: async () => ({}) });
    await assert.rejects(machines.pair("nas", "BADCODE"), /pairing code didn't work/);
    assert.deepEqual(await machines.pair("nas", "GOODCODE"), { environmentId: "nas", baseUrl: "https://nas.ts.net" });
    // The plain-HTTP LAN address never gets the code.
    assert.ok(!net.asked.some((url) => url.startsWith("http://nas.lan") && url.endsWith("/oauth/token")));
    assert.ok(net.asked.includes("https://nas.ts.net/oauth/token"));
    const routes = JSON.parse(await readFile(pairedRoutesFile(root), "utf8"));
    assert.equal(routes.nas.baseUrl, "https://nas.ts.net");
    assert.equal((await stat(routes.nas.tokenFile)).mode & 0o777, 0o600);
    assert.equal((await stat(pairedRoutesFile(root))).mode & 0o777, 0o600);
    const router = createEnvironmentRouter({ file: [undefined, pairedRoutesFile(root)], fetcher: net.fetcher });
    assert.deepEqual(await router("nas"), { baseUrl: "https://nas.ts.net", token: "peer-session" });
    assert.equal((await machines.list({ maxAge: 0 })).machines[1].route, "direct");
    await machines.unpair("nas");
    await assert.rejects(router("nas"), { status: 403 });
    await assert.rejects(machines.pair("nas", "has space"), /pairing code/);
  } finally { await rm(root, { recursive: true }); }
});

test("status words and credential-safe addresses", () => {
  assert.equal(machineStatus({ status: "unreachable" }, false), "unreachable");
  assert.equal(machineStatus({ status: "unreachable" }, true), "asleep");
  assert.equal(machineStatus({ status: "expired" }, true), "expired");
  assert.equal(safeOrigin("https://nas.ts.net/"), "https://nas.ts.net");
  assert.equal(safeOrigin("http://127.0.0.1:3773"), "http://127.0.0.1:3773");
  for (const unsafe of ["http://nas.lan", "https://u:p@nas", "https://nas?x=1", "nope"]) assert.equal(safeOrigin(unsafe), null);
});
