import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpTokenBroker } from "./mcp-token-broker.mts";

test("MCP token broker issues short-lived tokens, verifies, expires, and revokes", () => {
  let clock = 1_000_000;
  const broker = createMcpTokenBroker({ defaultTtlMs: 60_000, now: () => clock });

  const t1 = broker.issue("alpha", { runId: "run-1" });
  assert.ok(t1.token.startsWith("tb_mcp_"));
  assert.equal(broker.verify(t1.token)?.botSlug, "alpha");
  assert.equal(broker.verify(t1.token)?.runId, "run-1");

  // Revoke single token
  assert.equal(broker.revoke(t1.token), true);
  assert.equal(broker.verify(t1.token), null);

  // Expiration
  const t2 = broker.issue("beta", { ttlMs: 5_000 });
  assert.equal(broker.verify(t2.token)?.botSlug, "beta");
  clock += 5_001;
  assert.equal(broker.verify(t2.token), null);

  // Revoke all for a bot
  const a1 = broker.issue("gamma");
  const a2 = broker.issue("gamma");
  const b1 = broker.issue("delta");
  assert.equal(broker.revokeBot("gamma"), 2);
  assert.equal(broker.verify(a1.token), null);
  assert.equal(broker.verify(a2.token), null);
  assert.equal(broker.verify(b1.token)?.botSlug, "delta");
});
