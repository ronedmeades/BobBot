/**
 * SQLite-Primary Data Access Layer
 *
 * Phase 3: expenses, contacts, calendar events.
 * Each entity: read from SQLite (primary), dual-write to SQLite + JSON (backup).
 * If SQLite unavailable, falls back to JSON-only mode.
 *
 * JSON file paths are duplicated here (not imported from skills) to avoid circular imports.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { getDb, isDbAvailable } from "./database.js";
import type { ExpenseRow, ContactRow, CalendarEventRow } from "./queries.js";

// ─── Shared interfaces (imported by skill modules) ──────────────────

export interface Expense {
  id: string;
  amount: number;
  currency: string;
  category: string;
  description: string;
  date: string;
  vendor?: string;
  receipt_path?: string;
  tags?: string[];
  created_at: string;
}

export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  relationship?: string;
  address?: string;
  notes?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  date: string;
  end_date?: string;
  location?: string;
  category?: string;
  recurring?: {
    pattern: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  };
  reminder_days: number;
  completed?: boolean;
  last_reminded?: string;
  created_at: string;
}

// ─── JSON file paths ────────────────────────────────────────────────

const EXPENSES_PATH = resolve("memory/expenses.json");
const CONTACTS_PATH = resolve("memory/contacts.json");
const CALENDAR_PATH = resolve("memory/calendar.json");

// ─── JSON helpers (private) ─────────────────────────────────────────

async function loadExpensesJson(): Promise<Expense[]> {
  try {
    const raw = await readFile(EXPENSES_PATH, "utf-8");
    const store = JSON.parse(raw) as { version: number; expenses: Expense[] };
    return store.expenses ?? [];
  } catch {
    return [];
  }
}

async function saveExpensesJson(expenses: Expense[]): Promise<void> {
  await mkdir(dirname(EXPENSES_PATH), { recursive: true });
  await writeFile(EXPENSES_PATH, JSON.stringify({ version: 1, expenses }, null, 2), "utf-8");
}

async function loadContactsJson(): Promise<Contact[]> {
  try {
    const raw = await readFile(CONTACTS_PATH, "utf-8");
    const store = JSON.parse(raw) as { version: number; contacts: Contact[] };
    return store.contacts ?? [];
  } catch {
    return [];
  }
}

async function saveContactsJson(contacts: Contact[]): Promise<void> {
  await mkdir(dirname(CONTACTS_PATH), { recursive: true });
  await writeFile(CONTACTS_PATH, JSON.stringify({ version: 1, contacts }, null, 2), "utf-8");
}

async function loadCalendarJson(): Promise<CalendarEvent[]> {
  try {
    const raw = await readFile(CALENDAR_PATH, "utf-8");
    const store = JSON.parse(raw) as { version: number; events: CalendarEvent[] };
    return store.events ?? [];
  } catch {
    return [];
  }
}

async function saveCalendarJson(events: CalendarEvent[]): Promise<void> {
  await mkdir(dirname(CALENDAR_PATH), { recursive: true });
  await writeFile(CALENDAR_PATH, JSON.stringify({ version: 1, events }, null, 2), "utf-8");
}

// ─── Row ↔ Interface converters ─────────────────────────────────────

function expenseFromRow(row: ExpenseRow): Expense {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    category: row.category,
    description: row.description,
    date: row.date,
    vendor: row.vendor ?? undefined,
    receipt_path: row.receipt_path ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    created_at: row.created_at,
  };
}

function contactFromRow(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    company: row.company ?? undefined,
    role: row.role ?? undefined,
    relationship: row.relationship ?? undefined,
    address: row.address ?? undefined,
    notes: row.notes ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function calendarEventFromRow(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    date: row.date,
    end_date: row.end_date ?? undefined,
    location: row.location ?? undefined,
    category: row.category ?? undefined,
    recurring: row.recurring_pattern
      ? { pattern: row.recurring_pattern as "daily" | "weekly" | "monthly" | "quarterly" | "yearly" }
      : undefined,
    reminder_days: row.reminder_days,
    completed: row.completed === 1 ? true : undefined,
    last_reminded: row.last_reminded ?? undefined,
    created_at: row.created_at,
  };
}

// ─── EXPENSE STORE ──────────────────────────────────────────────────

export async function storeInsertExpense(expense: Expense): Promise<void> {
  // SQLite
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      db.prepare(`
        INSERT INTO expenses (id, amount, currency, category, description, date, vendor, receipt_path, tags, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        expense.id, expense.amount, expense.currency, expense.category,
        expense.description, expense.date, expense.vendor ?? null,
        expense.receipt_path ?? null,
        expense.tags ? JSON.stringify(expense.tags) : null,
        expense.created_at,
      );
    } catch { /* SQLite write failed — JSON backup still written */ }
  }

  // JSON backup
  const all = await loadExpensesJson();
  all.push(expense);
  await saveExpensesJson(all);
}

export async function storeGetExpenses(opts?: {
  from?: string;
  to?: string;
  category?: string;
  limit?: number;
}): Promise<Expense[]> {
  const limit = opts?.limit ?? 1000;

  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (opts?.from) { conditions.push("date >= ?"); params.push(opts.from); }
      if (opts?.to) { conditions.push("date <= ?"); params.push(opts.to); }
      if (opts?.category) { conditions.push("category = ?"); params.push(opts.category); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db.prepare(
        `SELECT * FROM expenses ${where} ORDER BY date DESC LIMIT ?`
      ).all(...params, limit) as ExpenseRow[];

      return rows.map(expenseFromRow);
    } catch { /* fall through to JSON */ }
  }

  // JSON fallback
  let expenses = await loadExpensesJson();
  if (opts?.from) expenses = expenses.filter((e) => e.date >= opts.from!);
  if (opts?.to) expenses = expenses.filter((e) => e.date <= opts.to!);
  if (opts?.category) expenses = expenses.filter((e) => e.category === opts.category);
  expenses.sort((a, b) => b.date.localeCompare(a.date));
  return expenses.slice(0, limit);
}

export async function storeDeleteExpense(id: string): Promise<Expense | null> {
  // Read current to return the deleted item
  let removed: Expense | null = null;

  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow | undefined;
      if (row) removed = expenseFromRow(row);
      db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
    } catch { /* fall through */ }
  }

  // JSON backup
  const all = await loadExpensesJson();
  const idx = all.findIndex((e) => e.id === id);
  if (idx !== -1) {
    if (!removed) removed = all[idx]!;
    all.splice(idx, 1);
    await saveExpensesJson(all);
  }

  return removed;
}

export interface ExpenseSummary {
  total: number;
  count: number;
  byCategory: Record<string, number>;
  byVendor: Record<string, number>;
  currency: string;
}

export async function storeGetExpenseSummary(
  from: string,
  to: string
): Promise<ExpenseSummary> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;

      // Category breakdown via SQL
      const catRows = db.prepare(`
        SELECT category, SUM(amount) as total, COUNT(*) as count
        FROM expenses WHERE date >= ? AND date < ?
        GROUP BY category ORDER BY total DESC
      `).all(from, to) as Array<{ category: string; total: number; count: number }>;

      // Vendor breakdown via SQL
      const vendorRows = db.prepare(`
        SELECT vendor, SUM(amount) as total
        FROM expenses WHERE date >= ? AND date < ? AND vendor IS NOT NULL
        GROUP BY vendor ORDER BY total DESC LIMIT 5
      `).all(from, to) as Array<{ vendor: string; total: number }>;

      // Currency from first expense in range
      const first = db.prepare(
        "SELECT currency FROM expenses WHERE date >= ? AND date < ? LIMIT 1"
      ).get(from, to) as { currency: string } | undefined;

      const byCategory: Record<string, number> = {};
      let total = 0;
      let count = 0;
      for (const row of catRows) {
        byCategory[row.category] = row.total;
        total += row.total;
        count += row.count;
      }

      const byVendor: Record<string, number> = {};
      for (const row of vendorRows) {
        byVendor[row.vendor] = row.total;
      }

      return { total, count, byCategory, byVendor, currency: first?.currency ?? "USD" };
    } catch { /* fall through */ }
  }

  // JSON fallback
  const expenses = await loadExpensesJson();
  const filtered = expenses.filter((e) => e.date >= from && e.date < to);

  const byCategory: Record<string, number> = {};
  const byVendor: Record<string, number> = {};
  let total = 0;

  for (const e of filtered) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount;
    if (e.vendor) byVendor[e.vendor] = (byVendor[e.vendor] ?? 0) + e.amount;
    total += e.amount;
  }

  return {
    total,
    count: filtered.length,
    byCategory,
    byVendor,
    currency: filtered[0]?.currency ?? "USD",
  };
}

// ─── CONTACT STORE ──────────────────────────────────────────────────

export async function storeInsertContact(contact: Contact): Promise<void> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      db.prepare(`
        INSERT INTO contacts (id, name, email, phone, company, role, relationship, address, notes, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        contact.id, contact.name, contact.email ?? null, contact.phone ?? null,
        contact.company ?? null, contact.role ?? null, contact.relationship ?? null,
        contact.address ?? null, contact.notes ?? null,
        contact.tags ? JSON.stringify(contact.tags) : null,
        contact.created_at, contact.updated_at,
      );
    } catch { /* JSON backup still written */ }
  }

  const all = await loadContactsJson();
  all.push(contact);
  await saveContactsJson(all);
}

export async function storeGetContactById(id: string): Promise<Contact | null> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow | undefined;
      if (row) return contactFromRow(row);
    } catch { /* fall through */ }
  }

  const all = await loadContactsJson();
  return all.find((c) => c.id === id) ?? null;
}

export async function storeGetAllContacts(): Promise<Contact[]> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const rows = db.prepare("SELECT * FROM contacts ORDER BY name ASC").all() as ContactRow[];
      return rows.map(contactFromRow);
    } catch { /* fall through */ }
  }

  return loadContactsJson();
}

export async function storeGetContacts(opts?: {
  tag?: string;
  relationship?: string;
  limit?: number;
}): Promise<Contact[]> {
  const limit = opts?.limit ?? 1000;

  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (opts?.tag) {
        conditions.push("tags LIKE ?");
        params.push(`%"${opts.tag}"%`);
      }
      if (opts?.relationship) {
        conditions.push("LOWER(relationship) = LOWER(?)");
        params.push(opts.relationship);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db.prepare(
        `SELECT * FROM contacts ${where} ORDER BY name ASC LIMIT ?`
      ).all(...params, limit) as ContactRow[];

      return rows.map(contactFromRow);
    } catch { /* fall through */ }
  }

  // JSON fallback
  let contacts = await loadContactsJson();
  if (opts?.tag) {
    contacts = contacts.filter(
      (c) => c.tags && c.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase())
    );
  }
  if (opts?.relationship) {
    contacts = contacts.filter(
      (c) => c.relationship?.toLowerCase() === opts.relationship!.toLowerCase()
    );
  }
  contacts.sort((a, b) => a.name.localeCompare(b.name));
  return contacts.slice(0, limit);
}

export async function storeUpdateContact(
  id: string,
  fields: Partial<Omit<Contact, "id" | "created_at">>
): Promise<Contact | null> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
      if (fields.email !== undefined) { sets.push("email = ?"); params.push(fields.email ?? null); }
      if (fields.phone !== undefined) { sets.push("phone = ?"); params.push(fields.phone ?? null); }
      if (fields.company !== undefined) { sets.push("company = ?"); params.push(fields.company ?? null); }
      if (fields.role !== undefined) { sets.push("role = ?"); params.push(fields.role ?? null); }
      if (fields.relationship !== undefined) { sets.push("relationship = ?"); params.push(fields.relationship ?? null); }
      if (fields.address !== undefined) { sets.push("address = ?"); params.push(fields.address ?? null); }
      if (fields.notes !== undefined) { sets.push("notes = ?"); params.push(fields.notes ?? null); }
      if (fields.tags !== undefined) { sets.push("tags = ?"); params.push(fields.tags ? JSON.stringify(fields.tags) : null); }
      if (fields.updated_at !== undefined) { sets.push("updated_at = ?"); params.push(fields.updated_at); }

      if (sets.length > 0) {
        params.push(id);
        db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      }
    } catch { /* fall through to JSON */ }
  }

  // JSON: load, update, save
  const all = await loadContactsJson();
  const contact = all.find((c) => c.id === id);
  if (!contact) return null;

  Object.assign(contact, fields);
  await saveContactsJson(all);
  return contact;
}

export async function storeDeleteContact(id: string): Promise<Contact | null> {
  let removed: Contact | null = null;

  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow | undefined;
      if (row) removed = contactFromRow(row);
      db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
    } catch { /* fall through */ }
  }

  const all = await loadContactsJson();
  const idx = all.findIndex((c) => c.id === id);
  if (idx !== -1) {
    if (!removed) removed = all[idx]!;
    all.splice(idx, 1);
    await saveContactsJson(all);
  }

  return removed;
}

export async function storeReplaceAllContacts(contacts: Contact[]): Promise<void> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      db.transaction(() => {
        db.prepare("DELETE FROM contacts").run();
        const stmt = db.prepare(`
          INSERT INTO contacts (id, name, email, phone, company, role, relationship, address, notes, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
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
    } catch { /* JSON still written */ }
  }

  await saveContactsJson(contacts);
}

// ─── CALENDAR EVENT STORE ───────────────────────────────────────────

export async function storeInsertCalendarEvent(event: CalendarEvent): Promise<void> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      db.prepare(`
        INSERT INTO calendar_events (id, title, description, date, end_date, location, category, recurring_pattern, reminder_days, completed, last_reminded, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id, event.title, event.description ?? null,
        event.date, event.end_date ?? null, event.location ?? null,
        event.category ?? null, event.recurring?.pattern ?? null,
        event.reminder_days, event.completed ? 1 : 0,
        event.last_reminded ?? null, event.created_at,
      );
    } catch { /* JSON backup still written */ }
  }

  const all = await loadCalendarJson();
  all.push(event);
  await saveCalendarJson(all);
}

export async function storeGetCalendarEventById(id: string): Promise<CalendarEvent | null> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const row = db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) as CalendarEventRow | undefined;
      if (row) return calendarEventFromRow(row);
    } catch { /* fall through */ }
  }

  const all = await loadCalendarJson();
  return all.find((e) => e.id === id) ?? null;
}

export async function storeGetCalendarEvents(opts?: {
  from?: string;
  to?: string;
  category?: string;
  includeCompleted?: boolean;
}): Promise<CalendarEvent[]> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (opts?.from) { conditions.push("date >= ?"); params.push(opts.from); }
      if (opts?.to) { conditions.push("date <= ?"); params.push(opts.to); }
      if (opts?.category) { conditions.push("category = ?"); params.push(opts.category); }
      if (!opts?.includeCompleted) { conditions.push("completed = 0"); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db.prepare(
        `SELECT * FROM calendar_events ${where} ORDER BY date ASC`
      ).all(...params) as CalendarEventRow[];

      return rows.map(calendarEventFromRow);
    } catch { /* fall through */ }
  }

  // JSON fallback
  let events = await loadCalendarJson();
  if (opts?.from) events = events.filter((e) => e.date >= opts.from!);
  if (opts?.to) events = events.filter((e) => e.date <= opts.to!);
  if (opts?.category) events = events.filter((e) => e.category === opts.category);
  if (!opts?.includeCompleted) events = events.filter((e) => !e.completed);
  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

export async function storeGetAllCalendarEvents(): Promise<CalendarEvent[]> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const rows = db.prepare("SELECT * FROM calendar_events ORDER BY date ASC").all() as CalendarEventRow[];
      return rows.map(calendarEventFromRow);
    } catch { /* fall through */ }
  }

  return loadCalendarJson();
}

export async function storeUpdateCalendarEvent(
  id: string,
  fields: Partial<Omit<CalendarEvent, "id" | "created_at">>
): Promise<CalendarEvent | null> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title); }
      if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description ?? null); }
      if (fields.date !== undefined) { sets.push("date = ?"); params.push(fields.date); }
      if (fields.end_date !== undefined) { sets.push("end_date = ?"); params.push(fields.end_date ?? null); }
      if (fields.location !== undefined) { sets.push("location = ?"); params.push(fields.location ?? null); }
      if (fields.category !== undefined) { sets.push("category = ?"); params.push(fields.category ?? null); }
      if (fields.recurring !== undefined) {
        sets.push("recurring_pattern = ?");
        params.push(fields.recurring?.pattern ?? null);
      }
      if (fields.reminder_days !== undefined) { sets.push("reminder_days = ?"); params.push(fields.reminder_days); }
      if (fields.completed !== undefined) { sets.push("completed = ?"); params.push(fields.completed ? 1 : 0); }
      if (fields.last_reminded !== undefined) { sets.push("last_reminded = ?"); params.push(fields.last_reminded ?? null); }
      // Handle explicit null for last_reminded (reset)
      if ("last_reminded" in fields && fields.last_reminded === undefined) {
        sets.push("last_reminded = NULL");
      }

      if (sets.length > 0) {
        params.push(id);
        db.prepare(`UPDATE calendar_events SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      }
    } catch { /* fall through to JSON */ }
  }

  // JSON: load, update, save
  const all = await loadCalendarJson();
  const event = all.find((e) => e.id === id);
  if (!event) return null;

  // Apply fields to the JSON copy
  if (fields.title !== undefined) event.title = fields.title;
  if (fields.description !== undefined) event.description = fields.description;
  if (fields.date !== undefined) event.date = fields.date;
  if (fields.end_date !== undefined) event.end_date = fields.end_date;
  if (fields.location !== undefined) event.location = fields.location;
  if (fields.category !== undefined) event.category = fields.category;
  if (fields.recurring !== undefined) event.recurring = fields.recurring;
  if (fields.reminder_days !== undefined) event.reminder_days = fields.reminder_days;
  if (fields.completed !== undefined) event.completed = fields.completed;
  if ("last_reminded" in fields) event.last_reminded = fields.last_reminded;

  await saveCalendarJson(all);
  return event;
}

export async function storeDeleteCalendarEvent(id: string): Promise<CalendarEvent | null> {
  let removed: CalendarEvent | null = null;

  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const row = db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) as CalendarEventRow | undefined;
      if (row) removed = calendarEventFromRow(row);
      db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
    } catch { /* fall through */ }
  }

  const all = await loadCalendarJson();
  const idx = all.findIndex((e) => e.id === id);
  if (idx !== -1) {
    if (!removed) removed = all[idx]!;
    all.splice(idx, 1);
    await saveCalendarJson(all);
  }

  return removed;
}

export async function storeGetRemindableEvents(now: Date): Promise<CalendarEvent[]> {
  if (isDbAvailable()) {
    try {
      const db = getDb()!;
      const nowIso = now.toISOString();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const yesterday = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

      // Get uncompleted events in the reminder window that haven't been reminded in 24h
      const rows = db.prepare(`
        SELECT * FROM calendar_events
        WHERE completed = 0
          AND date >= ?
          AND julianday(date) - julianday(?) <= reminder_days
          AND (last_reminded IS NULL OR last_reminded <= ?)
        ORDER BY date ASC
      `).all(yesterday, nowIso, oneDayAgo) as CalendarEventRow[];

      return rows.map(calendarEventFromRow);
    } catch { /* fall through */ }
  }

  // JSON fallback
  const all = await loadCalendarJson();
  return all.filter((event) => {
    if (event.completed) return false;
    const eventDate = new Date(event.date);
    const days = (eventDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    if (days < -1) return false;
    if (days > event.reminder_days) return false;
    if (event.last_reminded) {
      const hoursSince = (now.getTime() - new Date(event.last_reminded).getTime()) / (60 * 60 * 1000);
      if (hoursSince < 24) return false;
    }
    return true;
  });
}
