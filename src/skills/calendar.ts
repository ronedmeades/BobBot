import type { ToolDefinition } from "../providers/types.js";
import type { CalendarEvent } from "../db/stores.js";
import {
  storeInsertCalendarEvent,
  storeGetCalendarEventById,
  storeGetCalendarEvents,
  storeGetAllCalendarEvents,
  storeUpdateCalendarEvent,
  storeDeleteCalendarEvent,
  storeGetRemindableEvents,
} from "../db/stores.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function formatEventDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function daysUntil(isoDate: string): number {
  const now = new Date();
  const target = new Date(isoDate);
  return Math.ceil((target.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

function daysUntilLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""} ago`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function advanceRecurringDate(isoDate: string, pattern: string): string {
  const d = new Date(isoDate);
  switch (pattern) {
    case "daily":
      d.setDate(d.getDate() + 1);
      break;
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3);
      break;
    case "yearly":
      d.setFullYear(d.getFullYear() + 1);
      break;
  }
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const calendarToolDefinitions: ToolDefinition[] = [
  {
    name: "add_event",
    description:
      "Add an event to the calendar. Supports deadlines, meetings, appointments, and recurring events. " +
      "Bob will send Telegram reminders before the event date (default: 3 days before).",
    input_schema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Event title (e.g. 'Quarterly taxes due')",
        },
        description: {
          type: "string",
          description: "Optional details about the event",
        },
        date: {
          type: "string",
          description: "ISO 8601 date or datetime (e.g. '2026-04-15' or '2026-04-15T10:00:00')",
        },
        end_date: {
          type: "string",
          description: "Optional end date/time for multi-day events or meetings with duration",
        },
        location: {
          type: "string",
          description: "Optional location",
        },
        category: {
          type: "string",
          enum: ["deadline", "meeting", "filing", "appointment", "other"],
          description: "Event category (default: 'other')",
        },
        recurring: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              enum: ["daily", "weekly", "monthly", "quarterly", "yearly"],
              description: "How often the event recurs",
            },
          },
          required: ["pattern"],
          description: "Set this for recurring events (e.g. quarterly tax deadlines)",
        },
        reminder_days: {
          type: "number",
          description: "How many days before the event to send a reminder (default: 3)",
        },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "list_events",
    description:
      "List calendar events. By default shows upcoming events in the next 30 days. " +
      "Can filter by category, date range, or show all including completed.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter by category (e.g. 'deadline', 'meeting')",
        },
        from: {
          type: "string",
          description: "Start of date range (ISO 8601). Default: today",
        },
        to: {
          type: "string",
          description: "End of date range (ISO 8601). Default: 30 days from now",
        },
        include_completed: {
          type: "boolean",
          description: "Include completed events (default: false)",
        },
        include_past: {
          type: "boolean",
          description: "Include past events (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: "update_event",
    description: "Update an existing calendar event by ID. Only provided fields are changed.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Event ID to update" },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        date: { type: "string", description: "New date (ISO 8601)" },
        end_date: { type: "string", description: "New end date" },
        location: { type: "string", description: "New location" },
        category: { type: "string", description: "New category" },
        recurring: {
          type: "object",
          properties: {
            pattern: { type: "string" },
          },
          description: "New recurrence pattern",
        },
        reminder_days: { type: "number", description: "New reminder window in days" },
      },
      required: ["id"],
    },
  },
  {
    name: "remove_event",
    description: "Permanently delete a calendar event by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Event ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "complete_event",
    description:
      "Mark a deadline or filing as done. The event is kept in the calendar for records " +
      "but won't trigger future reminders. For recurring events, advances to the next occurrence.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Event ID to mark as completed" },
      },
      required: ["id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleAddEvent(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const title = input.title as string;
  const dateStr = input.date as string;

  if (!title || !dateStr) {
    return { success: false, output: "Title and date are required." };
  }

  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) {
    return { success: false, output: `Invalid date: "${dateStr}". Use ISO 8601 format (e.g. 2026-04-15).` };
  }

  const event: CalendarEvent = {
    id: generateId(),
    title,
    date: parsed.toISOString(),
    reminder_days: (input.reminder_days as number) ?? 3,
    created_at: new Date().toISOString(),
  };

  if (input.description) event.description = input.description as string;
  if (input.end_date) {
    const endParsed = new Date(input.end_date as string);
    if (!isNaN(endParsed.getTime())) event.end_date = endParsed.toISOString();
  }
  if (input.location) event.location = input.location as string;
  if (input.category) event.category = input.category as string;
  if (input.recurring) {
    event.recurring = input.recurring as { pattern: "daily" | "weekly" | "monthly" | "quarterly" | "yearly" };
  }

  await storeInsertCalendarEvent(event);

  const recurStr = event.recurring ? ` (recurring: ${event.recurring.pattern})` : "";
  const days = daysUntil(event.date);

  return {
    success: true,
    output:
      `Event added: "${title}"${recurStr}\n` +
      `Date: ${formatEventDate(event.date)} (${daysUntilLabel(days)})\n` +
      `ID: ${event.id}\n` +
      `Reminder: ${event.reminder_days} days before`,
  };
}

export async function handleListEvents(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const now = new Date();
  const category = input.category as string | undefined;
  const includeCompleted = (input.include_completed as boolean) ?? false;
  const includePast = (input.include_past as boolean) ?? false;

  const fromStr = input.from
    ? new Date(input.from as string).toISOString()
    : (includePast ? undefined : now.toISOString());
  const toStr = input.to
    ? new Date(input.to as string).toISOString()
    : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const filtered = await storeGetCalendarEvents({
    from: fromStr,
    to: toStr,
    category,
    includeCompleted,
  });

  if (filtered.length === 0) {
    const allEvents = await storeGetAllCalendarEvents();
    const total = allEvents.length;
    return {
      success: true,
      output: total > 0
        ? `No upcoming events in the next 30 days. (${total} total events in calendar, use include_past or include_completed to see more.)`
        : "Calendar is empty. Use add_event to create events.",
    };
  }

  const lines = filtered.map((e) => {
    const days = daysUntil(e.date);
    const catStr = e.category ? ` [${e.category}]` : "";
    const recurStr = e.recurring ? ` (${e.recurring.pattern})` : "";
    const completedStr = e.completed ? " DONE" : "";
    const locStr = e.location ? `\n  Location: ${e.location}` : "";
    const descStr = e.description ? `\n  ${e.description}` : "";

    return (
      `${formatEventDate(e.date)} — ${e.title}${catStr}${recurStr}${completedStr}\n` +
      `  ${daysUntilLabel(days)} | ID: ${e.id}${locStr}${descStr}`
    );
  });

  return {
    success: true,
    output: `Calendar (${filtered.length} event${filtered.length !== 1 ? "s" : ""}):\n\n${lines.join("\n\n")}`,
  };
}

export async function handleUpdateEvent(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) return { success: false, output: "Event ID is required." };

  const event = await storeGetCalendarEventById(id);
  if (!event) return { success: false, output: `No event found with ID "${id}".` };

  const fields: Partial<CalendarEvent> = {};
  const updates: string[] = [];

  if (input.title !== undefined) {
    fields.title = input.title as string;
    updates.push("title");
  }
  if (input.description !== undefined) {
    fields.description = input.description as string;
    updates.push("description");
  }
  if (input.date !== undefined) {
    const parsed = new Date(input.date as string);
    if (!isNaN(parsed.getTime())) {
      fields.date = parsed.toISOString();
      fields.last_reminded = undefined; // Reset reminder on date change
      updates.push("date");
    }
  }
  if (input.end_date !== undefined) {
    const parsed = new Date(input.end_date as string);
    if (!isNaN(parsed.getTime())) {
      fields.end_date = parsed.toISOString();
      updates.push("end_date");
    }
  }
  if (input.location !== undefined) {
    fields.location = input.location as string;
    updates.push("location");
  }
  if (input.category !== undefined) {
    fields.category = input.category as string;
    updates.push("category");
  }
  if (input.recurring !== undefined) {
    fields.recurring = input.recurring as { pattern: "daily" | "weekly" | "monthly" | "quarterly" | "yearly" } | undefined;
    updates.push("recurring");
  }
  if (input.reminder_days !== undefined) {
    fields.reminder_days = input.reminder_days as number;
    updates.push("reminder_days");
  }

  if (updates.length === 0) {
    return { success: true, output: "No changes provided." };
  }

  const updated = await storeUpdateCalendarEvent(id, fields);
  const title = updated ? updated.title : event.title;
  return {
    success: true,
    output: `Updated event "${title}" — changed: ${updates.join(", ")}`,
  };
}

export async function handleRemoveEvent(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) return { success: false, output: "Event ID is required." };

  const removed = await storeDeleteCalendarEvent(id);
  if (!removed) return { success: false, output: `No event found with ID "${id}".` };

  return {
    success: true,
    output: `Removed event "${removed.title}" (${formatEventDate(removed.date)}).`,
  };
}

export async function handleCompleteEvent(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) return { success: false, output: "Event ID is required." };

  const event = await storeGetCalendarEventById(id);
  if (!event) return { success: false, output: `No event found with ID "${id}".` };

  if (event.recurring) {
    // Advance to next occurrence
    const oldDate = event.date;
    const newDate = advanceRecurringDate(event.date, event.recurring.pattern);
    await storeUpdateCalendarEvent(id, {
      date: newDate,
      last_reminded: undefined,
      completed: false,
    });

    return {
      success: true,
      output:
        `Completed "${event.title}" for ${formatEventDate(oldDate)}.\n` +
        `Next occurrence: ${formatEventDate(newDate)} (${event.recurring.pattern})`,
    };
  }

  // Non-recurring: mark completed
  await storeUpdateCalendarEvent(id, { completed: true });

  return {
    success: true,
    output: `Marked "${event.title}" as completed.`,
  };
}

// ---------------------------------------------------------------------------
// Reminder checker — called by the hourly scheduler
// ---------------------------------------------------------------------------

/**
 * Check calendar events and return reminder messages for events
 * within their reminder window. The hourly scheduler calls this
 * and sends the results via Telegram.
 */
export async function checkCalendarReminders(): Promise<string[]> {
  const now = new Date();
  const events = await storeGetRemindableEvents(now);
  const reminders: string[] = [];

  for (const event of events) {
    const eventDate = new Date(event.date);
    const days = (eventDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);

    // Build reminder message
    const daysStr = days <= 0 ? "TODAY" : days < 1 ? "TOMORROW" : `in ${Math.ceil(days)} days`;
    const catStr = event.category ? ` [${event.category}]` : "";
    const locStr = event.location ? `\nLocation: ${event.location}` : "";
    const descStr = event.description ? `\n${event.description}` : "";

    reminders.push(
      `${event.title}${catStr}\n` +
      `Date: ${formatEventDate(event.date)} (${daysStr})` +
      locStr +
      descStr
    );

    // Mark as reminded
    await storeUpdateCalendarEvent(event.id, { last_reminded: now.toISOString() });
  }

  return reminders;
}
