/**
 * One-time JSON → SQLite Data Import
 *
 * Reads existing data from memory/*.json files and imports into SQLite tables.
 * Only runs once per entity — tracks completion via metadata table.
 */

import { resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { getDb, isDbAvailable } from "./database.js";
import { getMetadata, setMetadata } from "./queries.js";
import type { Expense, Contact, CalendarEvent } from "./stores.js";

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

// ─── Phase 3: Expenses, Contacts, Calendar ──────────────────────────

/**
 * Import existing structured data (expenses, contacts, calendar) from JSON into SQLite.
 * Each entity has its own metadata flag — only imports once.
 */
export async function importPhase3Data(): Promise<void> {
  if (!isDbAvailable()) return;

  await importExpenses();
  await importContacts();
  await importCalendarEvents();
}

async function importExpenses(): Promise<void> {
  if (getMetadata("expenses_imported") === "true") return;

  const db = getDb()!;
  try {
    const raw = await readFile(resolve(MEMORY_DIR, "expenses.json"), "utf-8");
    const store = JSON.parse(raw) as { expenses?: Expense[] };
    const expenses = store.expenses ?? [];

    if (expenses.length === 0) {
      setMetadata("expenses_imported", "true");
      return;
    }

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO expenses (id, amount, currency, category, description, date, vendor, receipt_path, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const e of expenses) {
        stmt.run(
          e.id, e.amount, e.currency ?? "USD", e.category ?? "other",
          e.description, e.date, e.vendor ?? null, e.receipt_path ?? null,
          e.tags ? JSON.stringify(e.tags) : null, e.created_at,
        );
      }
    })();

    setMetadata("expenses_imported", "true");
    console.log(`[db] Imported ${expenses.length} expenses from JSON`);
  } catch {
    // File doesn't exist or malformed — that's fine
    setMetadata("expenses_imported", "true");
  }
}

async function importContacts(): Promise<void> {
  if (getMetadata("contacts_imported") === "true") return;

  const db = getDb()!;
  try {
    const raw = await readFile(resolve(MEMORY_DIR, "contacts.json"), "utf-8");
    const store = JSON.parse(raw) as { contacts?: Contact[] };
    const contacts = store.contacts ?? [];

    if (contacts.length === 0) {
      setMetadata("contacts_imported", "true");
      return;
    }

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO contacts (id, name, email, phone, company, role, relationship, address, notes, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const c of contacts) {
        stmt.run(
          c.id, c.name, c.email ?? null, c.phone ?? null,
          c.company ?? null, c.role ?? null, c.relationship ?? null,
          c.address ?? null, c.notes ?? null,
          c.tags ? JSON.stringify(c.tags) : null,
          c.created_at, c.updated_at,
        );
      }
    })();

    setMetadata("contacts_imported", "true");
    console.log(`[db] Imported ${contacts.length} contacts from JSON`);
  } catch {
    setMetadata("contacts_imported", "true");
  }
}

async function importCalendarEvents(): Promise<void> {
  if (getMetadata("calendar_imported") === "true") return;

  const db = getDb()!;
  try {
    const raw = await readFile(resolve(MEMORY_DIR, "calendar.json"), "utf-8");
    const store = JSON.parse(raw) as { events?: CalendarEvent[] };
    const events = store.events ?? [];

    if (events.length === 0) {
      setMetadata("calendar_imported", "true");
      return;
    }

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO calendar_events (id, title, description, date, end_date, location, category, recurring_pattern, reminder_days, completed, last_reminded, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const e of events) {
        stmt.run(
          e.id, e.title, e.description ?? null,
          e.date, e.end_date ?? null, e.location ?? null,
          e.category ?? null, e.recurring?.pattern ?? null,
          e.reminder_days ?? 3, e.completed ? 1 : 0,
          e.last_reminded ?? null, e.created_at,
        );
      }
    })();

    setMetadata("calendar_imported", "true");
    console.log(`[db] Imported ${events.length} calendar events from JSON`);
  } catch {
    setMetadata("calendar_imported", "true");
  }
}
