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
  {
    version: 2,
    description: "Task audit trail: tasks + task_steps tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          chat_id INTEGER NOT NULL DEFAULT 0,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          priority TEXT NOT NULL DEFAULT 'normal',
          findings TEXT,
          next_action TEXT,
          steps_completed INTEGER NOT NULL DEFAULT 0,
          max_steps INTEGER NOT NULL DEFAULT 10,
          result TEXT,
          error TEXT,
          tools_used TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          paused_at TEXT,
          completed_at TEXT,
          created_by TEXT NOT NULL DEFAULT 'user',
          tags TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          notify_via TEXT,
          escalate_after_min INTEGER
        );
        CREATE INDEX idx_task_user ON tasks(user_id);
        CREATE INDEX idx_task_status ON tasks(status);
        CREATE INDEX idx_task_created ON tasks(created_at);

        CREATE TABLE task_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          step_number INTEGER NOT NULL,
          prompt TEXT,
          response TEXT,
          tools_used TEXT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          duration_ms INTEGER
        );
        CREATE INDEX idx_step_task ON task_steps(task_id);
        CREATE INDEX idx_step_time ON task_steps(timestamp);
      `);
    },
  },
  {
    version: 3,
    description: "Structured data: expenses, contacts, calendar_events tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE expenses (
          id TEXT PRIMARY KEY,
          amount REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'USD',
          category TEXT NOT NULL DEFAULT 'other',
          description TEXT NOT NULL,
          date TEXT NOT NULL,
          vendor TEXT,
          receipt_path TEXT,
          tags TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_expense_date ON expenses(date);
        CREATE INDEX idx_expense_category ON expenses(category);
        CREATE INDEX idx_expense_vendor ON expenses(vendor);

        CREATE TABLE contacts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          phone TEXT,
          company TEXT,
          role TEXT,
          relationship TEXT,
          address TEXT,
          notes TEXT,
          tags TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_contact_name ON contacts(name);
        CREATE INDEX idx_contact_email ON contacts(email);
        CREATE INDEX idx_contact_company ON contacts(company);
        CREATE INDEX idx_contact_relationship ON contacts(relationship);

        CREATE TABLE calendar_events (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          date TEXT NOT NULL,
          end_date TEXT,
          location TEXT,
          category TEXT,
          recurring_pattern TEXT,
          reminder_days INTEGER NOT NULL DEFAULT 3,
          completed INTEGER NOT NULL DEFAULT 0,
          last_reminded TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_cal_date ON calendar_events(date);
        CREATE INDEX idx_cal_completed ON calendar_events(completed);
        CREATE INDEX idx_cal_category ON calendar_events(category);
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
