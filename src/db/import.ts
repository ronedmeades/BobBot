/**
 * One-time JSON → SQLite Data Import
 *
 * Reads existing conversation history from memory/user-*.json files
 * and imports them into the SQLite conversations table.
 * Only runs once — tracks completion via metadata table.
 */

import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { getDb, isDbAvailable } from "./database.js";
import { getMetadata, setMetadata } from "./queries.js";

const MEMORY_DIR = resolve("memory");

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

/**
 * Import existing conversation history from JSON files into SQLite.
 * Skips if already imported (checks metadata flag).
 */
export async function importExistingData(): Promise<void> {
  if (!isDbAvailable()) return;

  const imported = getMetadata("history_imported");
  if (imported === "true") return;

  const db = getDb()!;
  let totalImported = 0;

  try {
    const files = await readdir(MEMORY_DIR);
    const historyFiles = files.filter(
      (f) => f.startsWith("user-") && f.endsWith(".json") && !f.startsWith("user-task-")
    );

    if (historyFiles.length === 0) {
      setMetadata("history_imported", "true");
      return;
    }

    const insertStmt = db.prepare(
      "INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)"
    );

    const importAll = db.transaction(() => {
      for (const file of historyFiles) {
        try {
          const userId = file.replace("user-", "").replace(".json", "");
          const raw = readFileSync(resolve(MEMORY_DIR, file), "utf-8");
          const entries = JSON.parse(raw) as ConversationEntry[];

          for (const entry of entries) {
            insertStmt.run(
              userId,
              entry.role,
              entry.content,
              entry.timestamp ?? new Date().toISOString()
            );
            totalImported++;
          }
        } catch {
          // Skip malformed files
        }
      }
    });

    importAll();
    setMetadata("history_imported", "true");

    if (totalImported > 0) {
      console.log(`[db] Imported ${totalImported} conversation entries from JSON`);
    }
  } catch {
    // Memory directory might not exist yet — that's fine
  }
}
