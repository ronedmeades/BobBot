/**
 * SQLite Database Manager
 *
 * Singleton manager for Bob's SQLite database. Lazy-loads better-sqlite3
 * so the system degrades gracefully if the native module isn't available.
 *
 * Database lives at memory/bob.db (gitignored with all memory/).
 * Uses WAL mode for concurrent read performance.
 * Schema versioned via PRAGMA user_version.
 */

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "./migrations.js";

const DB_PATH = resolve("memory/bob.db");

let db: BetterSqlite3.Database | null = null;
let available = false;

/**
 * Initialize the SQLite database.
 * Lazy-imports better-sqlite3, opens memory/bob.db, enables WAL, runs migrations.
 * Silently sets available=false if better-sqlite3 isn't installed.
 */
export async function initDb(): Promise<void> {
  try {
    await mkdir(resolve("memory"), { recursive: true });

    // Lazy-load better-sqlite3 (same pattern as sharp/playwright)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await (Function('return import("better-sqlite3")')() as Promise<any>);
    const Database = mod.default ?? mod;

    db = new Database(DB_PATH) as BetterSqlite3.Database;
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");

    runMigrations(db);
    available = true;
    console.log("[db] SQLite initialized: memory/bob.db");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[db] SQLite not available (${msg}) — using JSON-only mode`);
    db = null;
    available = false;
  }
}

/**
 * Get the initialized database instance.
 * Returns null if SQLite isn't available.
 */
export function getDb(): BetterSqlite3.Database | null {
  return db;
}

/**
 * Check if SQLite is available and initialized.
 */
export function isDbAvailable(): boolean {
  return available && db !== null;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // Best-effort cleanup
    }
    db = null;
    available = false;
  }
}
