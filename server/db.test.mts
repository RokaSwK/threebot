import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./db.mts";
import { createProjects } from "./projects.mts";
import { createRooms } from "./rooms.mts";
import { createRoutineHistory } from "./routine-history.mts";

test("SQLite database enables WAL mode, migrates JSON files idempotently, and renames to .migrated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "threebot-db-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "projects.json"), JSON.stringify({
      version: 3,
      seq: 2,
      items: {
        a1b2: {
          id: "a1b2", kind: "task", title: "Ship SQLite", status: "open",
          fields: {}, links: [], pinned: false, archived: false,
          createdAt: "2026-11-27T00:00:00.000Z", updatedAt: "2026-11-27T00:00:00.000Z",
          createdBy: { type: "user" }, updatedBy: { type: "user" },
        },
      },
      activity: [{ seq: 1, at: "2026-11-27T00:00:00.000Z", actor: { type: "user" }, itemId: "a1b2", kind: "task", title: "Ship SQLite", action: "created", changed: ["title"] }],
    }));
    writeFileSync(path.join(dir, "rooms.json"), JSON.stringify({
      version: 1,
      rooms: [{
        id: "room-1", name: "Core", description: "", guidance: "", section: null, pinned: false,
        createdAt: "2026-11-27T00:00:00.000Z",
        settings: { mode: "panel", defaultResponder: "lead", lead: "alpha", model: "inherit", mentionPolicy: "anywhere", allowCrossMentions: true, maxWaves: 2, maxReplies: 4, memberTimeoutMin: 5, turnDeadlineMin: 15, notifications: true },
        members: [], formerMembers: [], turns: [],
      }],
    }));
    writeFileSync(path.join(dir, "routine-history.json"), JSON.stringify({
      version: 1,
      observingSince: "2026-11-27T00:00:00.000Z",
      rows: [{ id: "dispatch:t1:2026-11-27T00:00:00.000Z", taskId: "t1", at: "2026-11-27T00:00:00.000Z", status: "dispatched", trigger: "scheduled", threadId: null, runId: null, source: "dispatch" }],
    }));

    const db = createDatabase(path.join(dir, "threebot.db"));
    const mode = db.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(mode.journal_mode.toLowerCase(), "wal");

    db.migrateFromJson(dir);
    assert.equal(existsSync(path.join(dir, "projects.json")), false);
    assert.equal(existsSync(path.join(dir, "projects.json.migrated")), true);
    assert.equal(existsSync(path.join(dir, "rooms.json.migrated")), true);
    assert.equal(existsSync(path.join(dir, "routine-history.json.migrated")), true);

    // Idempotent second run
    db.migrateFromJson(dir);

    const projects = createProjects({ file: path.join(dir, "projects.json"), db });
    const snap = await projects.snapshot();
    assert.equal(snap.version, 3);
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].title, "Ship SQLite");

    const rooms = createRooms({ file: path.join(dir, "rooms.json"), db });
    const roomList = await rooms.list();
    assert.equal(roomList.length, 1);
    assert.equal(roomList[0].name, "Core");

    const history = createRoutineHistory({ file: path.join(dir, "routine-history.json"), db });
    const hist = await history.get("t1");
    assert.equal(hist.rows.length, 1);
    assert.equal(hist.observingSince, "2026-11-27T00:00:00.000Z");

    const audit = db.recordAudit({ botSlug: "alpha", action: "vault.fill", target: "example.com", status: "ok", details: { field: "password" } });
    assert.equal(audit.botSlug, "alpha");
    assert.equal(db.listAudit({ botSlug: "alpha" }).length, 1);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite-backed stores handle concurrent writes cleanly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "threebot-db-conc-"));
  try {
    const db = createDatabase(path.join(dir, "threebot.db"));
    const projects = createProjects({ file: path.join(dir, "projects.json"), db });
    await Promise.all(Array.from({ length: 10 }, (_, i) => projects.save([{ kind: "note", title: `Note ${i}` }], { type: "user" })));
    const snap = await projects.snapshot();
    assert.equal(snap.items.length, 10);
    db.close();
    assert.equal(readFileSync(path.join(dir, "threebot.db")).length > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
