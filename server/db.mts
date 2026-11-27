// Built-in SQLite (WAL) storage for Projects board, Rooms, Routine History, and Action Audit Log.
// Uses Node 22.18+'s built-in `node:sqlite` (zero native dependencies).
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AuditEntry = {
  id: number;
  at: string;
  botSlug: string | null;
  action: string;
  target: string | null;
  status: "ok" | "error" | "denied";
  runId: string | null;
  threadId: string | null;
  details: Record<string, unknown> | null;
};

export type AuditInput = {
  at?: string;
  botSlug?: string | null;
  action: string;
  target?: string | null;
  status?: "ok" | "error" | "denied";
  runId?: string | null;
  threadId?: string | null;
  details?: Record<string, unknown> | null;
};

export function createDatabase(dbPath: string) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS kv_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      area TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_items_archived_updated ON projects_items (archived, updated_at);

    CREATE TABLE IF NOT EXISTS projects_activity (
      seq INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      item_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_activity_item ON projects_activity (item_id);

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routine_history (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      at TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_history_task_at ON routine_history (task_id, at DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      bot_slug TEXT,
      action TEXT NOT NULL,
      target TEXT,
      status TEXT NOT NULL,
      run_id TEXT,
      thread_id TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_bot_at ON audit_log (bot_slug, at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);
  `);

  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  function getMeta(key: string): string | null {
    const row = db.prepare("SELECT value FROM kv_meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  function setMeta(key: string, value: string) {
    db.prepare("INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  function recordAudit(input: AuditInput): AuditEntry {
    const at = input.at ?? new Date().toISOString();
    const botSlug = input.botSlug ?? null;
    const target = input.target ?? null;
    const status = input.status ?? "ok";
    const runId = input.runId ?? null;
    const threadId = input.threadId ?? null;
    const details = input.details ?? null;
    const result = db.prepare(
      "INSERT INTO audit_log (at, bot_slug, action, target, status, run_id, thread_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(at, botSlug, input.action, target, status, runId, threadId, details ? JSON.stringify(details) : null);
    return {
      id: Number(result.lastInsertRowid),
      at,
      botSlug,
      action: input.action,
      target,
      status,
      runId,
      threadId,
      details,
    };
  }

  function listAudit({ botSlug, limit = 100, beforeId }: { botSlug?: string; limit?: number; beforeId?: number } = {}): AuditEntry[] {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (botSlug) {
      clauses.push("bot_slug = ?");
      params.push(botSlug);
    }
    if (typeof beforeId === "number" && Number.isFinite(beforeId)) {
      clauses.push("id < ?");
      params.push(beforeId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(capped);
    const rows = db.prepare(`SELECT id, at, bot_slug, action, target, status, run_id, thread_id, details FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(...params) as Array<{
      id: number; at: string; bot_slug: string | null; action: string; target: string | null;
      status: "ok" | "error" | "denied"; run_id: string | null; thread_id: string | null; details: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      botSlug: row.bot_slug,
      action: row.action,
      target: row.target,
      status: row.status,
      runId: row.run_id,
      threadId: row.thread_id,
      details: row.details ? JSON.parse(row.details) as Record<string, unknown> : null,
    }));
  }

  function migrateFromJson(appDir: string) {
    // 1. Projects
    const projectsFile = path.join(appDir, "projects.json");
    if (existsSync(projectsFile) && !getMeta("migrated:projects")) {
      const raw = JSON.parse(readFileSync(projectsFile, "utf8")) as {
        version?: number;
        seq?: number;
        items?: Record<string, { id: string; kind: string; title: string; status?: string; area?: string; archived?: boolean; pinned?: boolean; updatedAt?: string }>;
        activity?: Array<{ seq: number; at: string; itemId: string }>;
      };
      transaction(() => {
        setMeta("projects:version", String(Number(raw.version) || 1));
        setMeta("projects:seq", String(Number(raw.seq) || 0));
        const insertItem = db.prepare(
          "INSERT OR REPLACE INTO projects_items (id, kind, title, status, area, archived, pinned, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const item of Object.values(raw.items ?? {})) {
          if (!item || typeof item.id !== "string") continue;
          insertItem.run(item.id, item.kind ?? "task", item.title ?? "", item.status ?? null, item.area ?? null, item.archived ? 1 : 0, item.pinned ? 1 : 0, item.updatedAt ?? "", JSON.stringify(item));
        }
        const insertAct = db.prepare("INSERT OR REPLACE INTO projects_activity (seq, at, item_id, data) VALUES (?, ?, ?, ?)");
        for (const entry of raw.activity ?? []) {
          if (!entry || typeof entry.seq !== "number") continue;
          insertAct.run(entry.seq, entry.at ?? "", entry.itemId ?? "", JSON.stringify(entry));
        }
        setMeta("migrated:projects", new Date().toISOString());
      });
      renameSync(projectsFile, `${projectsFile}.migrated`);
    }

    // 2. Rooms
    const roomsFile = path.join(appDir, "rooms.json");
    if (existsSync(roomsFile) && !getMeta("migrated:rooms")) {
      const raw = JSON.parse(readFileSync(roomsFile, "utf8")) as {
        rooms?: Array<{ id: string; name?: string; pinned?: boolean }>;
      };
      transaction(() => {
        const insertRoom = db.prepare("INSERT OR REPLACE INTO rooms (id, name, pinned, data) VALUES (?, ?, ?, ?)");
        for (const room of raw.rooms ?? []) {
          if (!room || typeof room.id !== "string") continue;
          insertRoom.run(room.id, room.name ?? "", room.pinned ? 1 : 0, JSON.stringify(room));
        }
        setMeta("migrated:rooms", new Date().toISOString());
      });
      renameSync(roomsFile, `${roomsFile}.migrated`);
    }

    // 3. Routine history
    const historyFile = path.join(appDir, "routine-history.json");
    if (existsSync(historyFile) && !getMeta("migrated:routine-history")) {
      const raw = JSON.parse(readFileSync(historyFile, "utf8")) as {
        observingSince?: string;
        rows?: Array<{ id: string; taskId: string; at: string; status: string; trigger: string; threadId?: string | null; runId?: string | null; source: string }>;
      };
      transaction(() => {
        if (raw.observingSince) setMeta("routine_history:observing_since", raw.observingSince);
        const insertRow = db.prepare(
          "INSERT OR REPLACE INTO routine_history (id, task_id, at, status, trigger_type, thread_id, run_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const row of raw.rows ?? []) {
          if (!row || typeof row.id !== "string") continue;
          insertRow.run(row.id, row.taskId, row.at, row.status, row.trigger, row.threadId ?? null, row.runId ?? null, row.source);
        }
        setMeta("migrated:routine-history", new Date().toISOString());
      });
      renameSync(historyFile, `${historyFile}.migrated`);
    }
  }

  return {
    raw: db,
    transaction,
    getMeta,
    setMeta,
    recordAudit,
    listAudit,
    migrateFromJson,
    close: () => db.close(),
  };
}

export type ThreebotDb = ReturnType<typeof createDatabase>;
