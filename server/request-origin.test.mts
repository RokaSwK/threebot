import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedOrigins, sameOriginRequest } from "./request-origin.mts";

const request = (headers) => ({ headers: { host: "bot.swk.tools", ...headers } });

test("the app's own pages are allowed", () => {
  assert.equal(sameOriginRequest(request({ origin: "https://bot.swk.tools" })), true);
});

test("other websites are refused, including lookalikes and opaque origins", () => {
  for (const origin of ["https://example.com", "https://bot.swk.tools.evil.example", "https://evil.example/bot.swk.tools", "null", "file://", ""]) {
    assert.equal(sameOriginRequest(request({ origin })), false, origin);
  }
});

test("a browser request marked cross-site is refused even without an Origin", () => {
  assert.equal(sameOriginRequest(request({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOriginRequest(request({ "sec-fetch-site": "same-origin" })), true);
});

test("non-browser clients send no Origin and still depend on their credential", () => {
  assert.equal(sameOriginRequest(request({})), true);
});

test("loopback only passes in an open dev setup", () => {
  assert.equal(sameOriginRequest(request({ origin: "http://localhost:5173" })), false);
  assert.equal(sameOriginRequest(request({ origin: "http://localhost:5173" }), { allowLoopback: true }), true);
  assert.equal(sameOriginRequest(request({ origin: "http://localhost.evil.example" }), { allowLoopback: true }), false);
});

test("extra origins are explicit", () => {
  const allowed = allowedOrigins({ ALLOWED_ORIGINS: "https://app.example, https://two.example" });
  assert.equal(sameOriginRequest(request({ origin: "https://two.example" }), { allowed }), true);
  assert.equal(sameOriginRequest(request({ origin: "https://three.example" }), { allowed }), false);
  assert.equal(allowedOrigins({}).size, 0);
});
