import assert from "node:assert/strict";
import { test } from "node:test";
import { seedInstructions } from "./provisioner.mts";
import type { Bot } from "./main-bot.mts";

const bot = (extra: Partial<Bot> = {}) => ({
  slug: "helper",
  workspaceRoot: "/tmp/helper",
  name: "Helper",
  label: "",
  shape: "sphere",
  color: "teal",
  environmentId: "local",
  dataDir: "/tmp/helper",
  instructions: "## What this Bot does\n- Review code.\n",
  ...extra,
}) as Bot;

const recorder = () => {
  const saves: { slug: string; patch: unknown }[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    saves, logs, errors,
    saveBot: async (slug: string, patch: unknown) => { saves.push({ slug, patch }); },
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
  };
};

test("a valid seed is written before the field is cleared", async () => {
  const rec = recorder();
  let written = "";
  const ok = await seedInstructions(bot(), {
    writeInstructions: async (_bot, text) => { written = text; },
    saveBot: rec.saveBot, log: rec.log, error: rec.error,
  });
  assert.equal(ok, true);
  assert.equal(written, "## What this Bot does\n- Review code.\n");
  assert.deepEqual(rec.saves, [{ slug: "helper", patch: { instructions: null } }]);
  assert.match(rec.logs[0] ?? "", /wrote instructions/u);
  assert.deepEqual(rec.errors, []);
});

test("a permanent 400 drops the seed and does not throw", async () => {
  const rec = recorder();
  const ok = await seedInstructions(bot(), {
    writeInstructions: async () => { throw Object.assign(new Error("too long"), { status: 400 }); },
    saveBot: rec.saveBot, log: rec.log, error: rec.error,
  });
  assert.equal(ok, false);
  assert.deepEqual(rec.saves, [{ slug: "helper", patch: { instructions: null } }]);
  assert.match(rec.errors.join(" "), /could not write/u);
  assert.match(rec.errors.join(" "), /dropped an invalid seed|dropped an invalid instruction seed/u);
});

test("a transient write failure keeps the seed for the next tick", async () => {
  const rec = recorder();
  const ok = await seedInstructions(bot(), {
    writeInstructions: async () => { throw new Error("disk busy"); },
    saveBot: rec.saveBot, log: rec.log, error: rec.error,
  });
  assert.equal(ok, false);
  assert.deepEqual(rec.saves, []);
  assert.match(rec.errors.join(" "), /disk busy/u);
  assert.doesNotMatch(rec.errors.join(" "), /dropped/u);
});

test("an adopted Bot clears a seed it can never write and does not throw", async () => {
  const rec = recorder();
  const ok = await seedInstructions(bot({ adopted: true }), {
    writeInstructions: async () => { throw new Error("must not be called"); },
    saveBot: rec.saveBot, log: rec.log, error: rec.error,
  });
  assert.equal(ok, false);
  assert.deepEqual(rec.saves, [{ slug: "helper", patch: { instructions: null } }]);
  assert.deepEqual(rec.errors, []);
});
