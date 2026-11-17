import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const freePort = async () => {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address() as net.AddressInfo;
  await new Promise((resolve) => socket.close(resolve));
  return port;
};

// The real gateway over a throwaway build: what matters here is the bytes and headers on the wire.
async function startGateway() {
  const root = await mkdtemp(path.join(tmpdir(), "static-"));
  await mkdir(path.join(root, "bots"), { recursive: true });
  await mkdir(path.join(root, "dist/assets"), { recursive: true });
  await mkdir(path.join(root, "dist/media"), { recursive: true });
  const bundle = Buffer.from("export const answer = 42;\n".repeat(6000));
  const tiny = Buffer.from("export const small = 1;\n");
  const png = Buffer.alloc(4096, 7);
  const mp4 = Buffer.alloc(4096, 9);
  await writeFile(path.join(root, "dist/index.html"), "<!doctype html><title>app</title>" + "x".repeat(2048));
  await writeFile(path.join(root, "dist/assets/big.js"), bundle);
  await writeFile(path.join(root, "dist/assets/tiny.js"), tiny);
  await writeFile(path.join(root, "dist/assets/logo.png"), png);
  await writeFile(path.join(root, "dist/media/clip.mp4"), mp4);
  const port = await freePort(), tailnet = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./gateway.mts", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: root, CODEX_HOME: path.join(root, "codex"), HOST: "127.0.0.1", PORT: String(port),
      BOTS_ROOT: path.join(root, "bots"), STATIC_DIR: path.join(root, "dist"), T3_URL: "http://127.0.0.1:1", T3_TOKEN: "fixture-only",
      BOT_MCP_TOKEN: "fixture-only", BOT_PASSWORD: "", VAULT_FILE: path.join(root, "vault.enc"), VAULT_KEY_FILE: path.join(root, "vault-key"),
      CF_ACCESS_TEAM_DOMAIN: "fixture.invalid", CF_ACCESS_AUD: "fixture", CF_ACCESS_EMAILS: "me@example.com",
      TAILNET_PORT: String(tailnet), TAILNET_USERS: "me@example.com",
    }, stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fixture gateway did not start")), 8000);
    let seen = "";
    child.stdout.on("data", (data) => { seen += data; if (seen.includes("bot gateway on") && seen.includes("tailnet listener")) { clearTimeout(timeout); resolve(); } });
    child.once("exit", (code) => reject(new Error(`gateway exited ${code}`)));
  });
  return {
    port, bundle, tiny, png, mp4,
    stop: async () => { child.removeAllListeners("exit"); child.kill(); await once(child, "exit").catch(() => {}); await rm(root, { recursive: true, force: true }); },
  };
}

const request = (port: number, urlPath: string, headers: Record<string, string> = {}, method = "GET") =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });

describe("static responses are compressed for clients that ask", () => {
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  before(async () => { gateway = await startGateway(); });
  after(() => gateway.stop());

  test("brotli wins when the client accepts it, and the body still decodes byte for byte", async () => {
    const res = await request(gateway.port, "/assets/big.js", { "accept-encoding": "gzip, deflate, br" });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-encoding"], "br");
    assert.equal(res.headers["vary"], "Accept-Encoding");
    assert.equal(Number(res.headers["content-length"]), res.body.length);
    assert.ok(res.body.length < gateway.bundle.length / 10, "the bundle must shrink hard");
    assert.deepEqual(brotliDecompressSync(res.body), gateway.bundle);
  });

  test("a gzip-only client gets gzip", async () => {
    const res = await request(gateway.port, "/assets/big.js", { "accept-encoding": "gzip" });
    assert.equal(res.headers["content-encoding"], "gzip");
    assert.deepEqual(gunzipSync(res.body), gateway.bundle);
  });

  test("no header means identity with a known length", async () => {
    const res = await request(gateway.port, "/assets/big.js");
    assert.equal(res.headers["content-encoding"], undefined);
    assert.equal(Number(res.headers["content-length"]), gateway.bundle.length);
    assert.deepEqual(res.body, gateway.bundle);
  });

  test("q=0 is a refusal, not an acceptance", async () => {
    const res = await request(gateway.port, "/assets/big.js", { "accept-encoding": "br;q=0, gzip" });
    assert.equal(res.headers["content-encoding"], "gzip");
  });

  test("images and tiny files are left alone", async () => {
    const png = await request(gateway.port, "/assets/logo.png", { "accept-encoding": "br, gzip" });
    assert.equal(png.headers["content-encoding"], undefined, "a PNG is already compressed");
    assert.equal(Number(png.headers["content-length"]), gateway.png.length);
    assert.equal(png.headers["vary"], undefined, "nothing varies for a type that never compresses");
    const tiny = await request(gateway.port, "/assets/tiny.js", { "accept-encoding": "br, gzip" });
    assert.equal(tiny.headers["content-encoding"], undefined, "below the floor the overhead wins");
  });

  test("range requests stay uncompressed and byte-exact", async () => {
    const res = await request(gateway.port, "/media/clip.mp4", { "accept-encoding": "br, gzip", range: "bytes=100-199" });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-encoding"], undefined);
    assert.equal(res.body.length, 100);
    assert.deepEqual(res.body, gateway.mp4.subarray(100, 200));
  });

  test("HEAD reports the encoded length without a body", async () => {
    const get = await request(gateway.port, "/assets/big.js", { "accept-encoding": "br" });
    const head = await request(gateway.port, "/assets/big.js", { "accept-encoding": "br" }, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-encoding"], "br");
    assert.equal(head.headers["content-length"], get.headers["content-length"]);
    assert.equal(head.body.length, 0);
  });

  test("the shell is compressed too, and a second request reuses the encoded bytes", async () => {
    const first = await request(gateway.port, "/", { "accept-encoding": "br" });
    const second = await request(gateway.port, "/", { "accept-encoding": "br" });
    assert.equal(first.headers["content-encoding"], "br");
    assert.match(brotliDecompressSync(first.body).toString("utf8"), /<title>app<\/title>/);
    assert.deepEqual(second.body, first.body);
  });
});
