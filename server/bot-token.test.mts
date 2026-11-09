import assert from "node:assert/strict";
import test from "node:test";
import { bearerToken, tokenForBot, tokenMatches } from "./bot-token.mts";

test("per-Bot tokens are deterministic, distinct and never the shared secret", () => {
  const secret = "fixture-secret";
  const alpha = tokenForBot(secret, "alpha");
  assert.equal(alpha, tokenForBot(secret, "alpha"));
  assert.notEqual(alpha, tokenForBot(secret, "beta"));
  assert.notEqual(alpha, secret);
  assert.match(alpha, /^[a-f0-9]{64}$/u);
});

test("bearer parsing and constant-time matching", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer  abc  "), "abc");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abd"), false);
  assert.equal(tokenMatches("abc", "abcd"), false);
  assert.equal(tokenMatches("", "abc"), false);
});
