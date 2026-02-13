import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface Reminder {
  id: string;
  message: string;
  remind_at: string;
  created_at: string;
  snoozed_until?: string;
  snooze_count: number;
  dismissed: boolean;
  last_notified?: string;
}

interface ReminderStore {
  version: number;
  reminders: Reminder[];
}

const REMINDERS_PATH = resolve("memory/reminders.json");

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function loadReminders(): Promise<Reminder[]> {
  try {
    const raw = await readFile(REMINDERS_PATH, "utf-8");
    const store = JSON.parse(raw) as ReminderStore;
    return store.reminders ?? [];
  } catch {
    return [];
  }
}

async function saveReminders(reminders: Reminder[]): Promise<void> {
  const store: ReminderStore = { version: 1, reminders };
  await mkdir(dirname(REMINDERS_PATH), { recursive: true });
  await writeFile(REMINDERS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Natural language time parsing
// ---------------------------------------------------------------------------

export function parseWhen(when: string): Date | null {
  const now = new Date();

  // ISO date
  const iso = new Date(when);
  if (!isNaN(iso.getTime()) && when.includes("-")) return iso;

  const lower = when.toLowerCase().trim();

  // "in X minutes/hours/days"
  const inMatch = lower.match(/^in\s+(\d+)\s+(minute|min|hour|hr|day|week)s?$/);
  if (inMatch) {
    const amount = parseInt(inMatch[1]!, 10);
    const unit = inMatch[2]!;
    const result = new Date(now);
    if (unit.startsWith("min")) result.setMinutes(result.getMinutes() + amount);
    else if (unit.startsWith("hour") || unit === "hr") result.setHours(result.getHours() + amount);
    else if (unit.startsWith("day")) result.setDate(result.getDate() + amount);
    else if (unit.startsWith("week")) result.setDate(result.getDate() + amount * 7);
    return result;
  }

  // "tomorrow", "tomorrow morning", "tomorrow evening"
  if (lower.startsWith("tomorrow")) {
    const result = new Date(now);
    result.setDate(result.getDate() + 1);
    if (lower.includes("morning")) {
      result.setHours(9, 0, 0, 0);
    } else if (lower.includes("evening") || lower.includes("night")) {
      result.setHours(18, 0, 0, 0);
    } else if (lower.includes("afternoon")) {
      result.setHours(14, 0, 0, 0);
    } else {
      result.setHours(9, 0, 0, 0);
    }
    return result;
  }

  // "today" variants
  if (lower.startsWith("today")) {
    const result = new Date(now);
    if (lower.includes("evening") || lower.includes("night")) {
      result.setHours(18, 0, 0, 0);
    } else if (lower.includes("afternoon")) {
      result.setHours(14, 0, 0, 0);
    }
    return result;
  }

  // "next Monday", "next Tuesday", etc.
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const nextDayMatch = lower.match(/^next\s+(\w+)$/);
  if (nextDayMatch) {
    const dayName = nextDayMatch[1]!;
    const targetDay = dayNames.indexOf(dayName);
    if (targetDay !== -1) {
      const result = new Date(now);
      const currentDay = result.getDay();
      let daysAhead = targetDay - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      result.setDate(result.getDate() + daysAhead);
      result.setHours(9, 0, 0, 0);
      return result;
    }
  }

  // "in half an hour"
  if (lower === "in half an hour" || lower === "in 30 min" || lower === "in 30 minutes") {
    const result = new Date(now);
    result.setMinutes(result.getMinutes() + 30);
    return result;
  }

  // "in an hour"
  if (lower === "in an hour" || lower === "in 1 hour") {
    const result = new Date(now);
    result.setHours(result.getHours() + 1);
    return result;
  }

  return null;
}

export function parseSnoozeDuration(duration: string): number {
  const lower = duration.toLowerCase().trim();

  const match = lower.match(/^(\d+)\s*(minute|min|hour|hr|day)s?$/);
  if (match) {
    const amount = parseInt(match[1]!, 10);
    const unit = match[2]!;
    if (unit.startsWith("min")) return amount * 60 * 1000;
    if (unit.startsWith("hour") || unit === "hr") return amount * 60 * 60 * 1000;
    if (unit.startsWith("day")) return amount * 24 * 60 * 60 * 1000;
  }

  // Default: 1 hour
  return 60 * 60 * 1000;
}

export function formatReminder(r: Reminder): string {
  const date = new Date(r.snoozed_until ?? r.remind_at);
  const now = new Date();
  const diff = date.getTime() - now.getTime();

  let timeLabel: string;
  if (diff < 0) {
    timeLabel = "OVERDUE";
  } else if (diff < 60 * 60 * 1000) {
    timeLabel = `in ${Math.round(diff / 60000)} min`;
  } else if (diff < 24 * 60 * 60 * 1000) {
    timeLabel = `in ${Math.round(diff / 3600000)} hours`;
  } else {
    timeLabel = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  const snoozeNote = r.snooze_count > 0 ? ` (snoozed ${r.snooze_count}x)` : "";
  const status = r.dismissed ? " [dismissed]" : "";

  return `[${r.id}] ${r.message} — ${timeLabel}${snoozeNote}${status}`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const remindersToolDefinitions: ToolDefinition[] = [
  {
    name: "set_reminder",
    description:
      "Set a reminder for a specific time. Supports natural language like " +
      "'in 2 hours', 'tomorrow morning', 'next Monday', or ISO dates.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "What to be reminded about" },
        when: {
          type: "string",
          description:
            "When to remind. Natural language ('in 2 hours', 'tomorrow morning', 'next Monday') or ISO date.",
        },
      },
      required: ["message", "when"],
    },
  },
  {
    name: "list_reminders",
    description: "List all active (non-dismissed) reminders.",
    input_schema: {
      type: "object" as const,
      properties: {
        include_dismissed: {
          type: "boolean",
          description: "Include dismissed reminders (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: "snooze_reminder",
    description: "Snooze a reminder for a specified duration (default: 1 hour).",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Reminder ID" },
        duration: {
          type: "string",
          description: "How long to snooze (e.g. '30 minutes', '2 hours', '1 day'). Default: 1 hour.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "dismiss_reminder",
    description: "Dismiss (complete) a reminder.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Reminder ID" },
      },
      required: ["id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleSetReminder(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const message = input.message as string;
  const when = input.when as string;

  const remindAt = parseWhen(when);
  if (!remindAt) {
    return {
      success: false,
      output: `Could not parse time: "${when}". Try "in 2 hours", "tomorrow morning", "next Monday", or an ISO date.`,
    };
  }

  const reminders = await loadReminders();
  const reminder: Reminder = {
    id: randomUUID().slice(0, 8),
    message,
    remind_at: remindAt.toISOString(),
    created_at: new Date().toISOString(),
    snooze_count: 0,
    dismissed: false,
  };

  reminders.push(reminder);
  await saveReminders(reminders);

  return {
    success: true,
    output: `Reminder set: "${message}" — ${formatReminder(reminder)}`,
  };
}

export async function handleListReminders(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const reminders = await loadReminders();
  const includeDismissed = (input.include_dismissed as boolean) ?? false;

  let filtered = reminders;
  if (!includeDismissed) {
    filtered = reminders.filter((r) => !r.dismissed);
  }

  if (filtered.length === 0) {
    return { success: true, output: "No active reminders." };
  }

  const sorted = filtered.sort((a, b) => {
    const aTime = new Date(a.snoozed_until ?? a.remind_at).getTime();
    const bTime = new Date(b.snoozed_until ?? b.remind_at).getTime();
    return aTime - bTime;
  });

  const lines = sorted.map((r) => formatReminder(r));
  return {
    success: true,
    output: `${sorted.length} reminder(s):\n\n${lines.join("\n")}`,
  };
}

export async function handleSnoozeReminder(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const reminders = await loadReminders();
  const reminder = reminders.find((r) => r.id === input.id);
  if (!reminder) {
    return { success: false, output: `Reminder not found: ${input.id}` };
  }

  const duration = (input.duration as string) ?? "1 hour";
  const durationMs = parseSnoozeDuration(duration);
  const snoozeUntil = new Date(Date.now() + durationMs);

  reminder.snoozed_until = snoozeUntil.toISOString();
  reminder.snooze_count++;
  reminder.dismissed = false;

  await saveReminders(reminders);
  return {
    success: true,
    output: `Snoozed: "${reminder.message}" until ${snoozeUntil.toLocaleString()}`,
  };
}

export async function handleDismissReminder(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const reminders = await loadReminders();
  const reminder = reminders.find((r) => r.id === input.id);
  if (!reminder) {
    return { success: false, output: `Reminder not found: ${input.id}` };
  }

  reminder.dismissed = true;
  await saveReminders(reminders);
  return { success: true, output: `Dismissed: "${reminder.message}"` };
}

// ---------------------------------------------------------------------------
// Scheduler integration
// ---------------------------------------------------------------------------

/**
 * Check for due reminders. Called by the hourly scheduler.
 * Returns messages for reminders that are due and haven't been notified recently.
 */
export async function checkReminders(): Promise<string[]> {
  const reminders = await loadReminders();
  const now = new Date();
  const messages: string[] = [];
  let changed = false;

  for (const r of reminders) {
    if (r.dismissed) continue;

    const dueTime = new Date(r.snoozed_until ?? r.remind_at);
    if (dueTime > now) continue;

    // 24h notification cooldown
    if (r.last_notified) {
      const lastNotified = new Date(r.last_notified);
      if (now.getTime() - lastNotified.getTime() < 24 * 60 * 60 * 1000) continue;
    }

    messages.push(`Reminder: ${r.message} (ID: ${r.id})`);
    r.last_notified = now.toISOString();
    changed = true;
  }

  if (changed) {
    await saveReminders(reminders);
  }

  return messages;
}
