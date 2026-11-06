import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAccessVerifier } from "./access.mts";

const team = "example.cloudflareaccess.com";
const aud = "test-aud";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const fetchImpl = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
const now = () => 1_800_000_000_000;
const t = Math.floor(now() / 1000);

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function token(claims, { kid = "k1", alg = "RS256", key = privateKey } = {}) {
  const head = b64({ alg, kid, typ: "JWT" });
  const body = b64({ aud: [aud], iss: `https://${team}`, email: "me@example.com", exp: t + 600, iat: t, nbf: t, ...claims });
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const verifier = createAccessVerifier({ teamDomain: team, aud, emails: ["Me@example.com"], fetchImpl, now });

test("accepts a valid token for an allowed email", async () => {
  assert.equal(await verifier(token({})), "me@example.com");
});

test("rejects other emails, audiences, issuers and expired tokens", async () => {
  assert.equal(await verifier(token({ email: "someone@else.com" })), null);
  assert.equal(await verifier(token({ aud: ["other-aud"] })), null);
  assert.equal(await verifier(token({ iss: "https://evil.cloudflareaccess.com" })), null);
  assert.equal(await verifier(token({ exp: t - 3600 })), null);
});

test("rejects forged signatures, unknown keys and alg none", async () => {
  assert.equal(await verifier(token({}, { key: other.privateKey })), null);
  assert.equal(await verifier(token({}, { kid: "nope" })), null);
  const [h, b] = token({}).split(".");
  assert.equal(await verifier(`${b64({ alg: "none", kid: "k1" })}.${b}.`), null);
  assert.equal(await verifier(`${h}.${b}.`), null);
  assert.equal(await verifier("garbage"), null);
});

test("is disabled without configuration", () => {
  assert.equal(createAccessVerifier({ teamDomain: "", aud, emails: ["a@b.c"] }), null);
});
