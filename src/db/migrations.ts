/**
 * SQLite Schema Migrations
 *
 * Versioned migrations using PRAGMA user_version.
 * Each migration runs in a transaction. Once applied, it's never re-run.
 */

import type BetterSqlite3 from "better-sqlite3";

interface Migration {
  version: number;
  description: string;
  up: (db: BetterSqlite3.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema: conversations, tool_calls, events, metadata",
    up: (db) => {
      db.exec(`
        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          source TEXT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_conv_user_time ON conversations(user_id, timestamp);

        CREATE TABLE tool_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER REFERENCES conversations(id),
          tool_name TEXT NOT NULL,
          input_json TEXT,
          output_text TEXT,
          success INTEGER NOT NULL DEFAULT 1,
          duration_ms INTEGER,
          user_id TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_tool_name ON tool_calls(tool_name);
        CREATE INDEX idx_tool_time ON tool_calls(timestamp);
        CREATE INDEX idx_tool_user ON tool_calls(user_id);

        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_event_type ON events(type);
        CREATE INDEX idx_event_time ON events(timestamp);

        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
    },
  },
];

/**
 * Run all pending migrations against the database.
 */
export function runMigrations(db: BetterSqlite3.Database): void {
  const currentVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;

  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  for (const migration of pending) {
    console.log(`[db] Running migration v${migration.version}: ${migration.description}`);
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }

  console.log(`[db] Schema at version ${pending[pending.length - 1].version}`);
}
