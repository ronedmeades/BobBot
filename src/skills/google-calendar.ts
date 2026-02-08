import type Anthropic from "@anthropic-ai/sdk";
import { config as appConfig } from "../config.js";

// Google Calendar API integration.
// Can reuse the same Google OAuth2 client as Gmail, or use separate credentials.
// Env vars: GOOGLE_CALENDAR_CLIENT_ID (falls back to GMAIL_CLIENT_ID),
//           GOOGLE_CALENDAR_CLIENT_SECRET (falls back to GMAIL_CLIENT_SECRET),
//           GOOGLE_CALENDAR_REFRESH_TOKEN (required — must include calendar scope)

interface ToolResult {
  success: boolean;
  output: string;
}

interface CalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function getCalendarConfig(): CalendarConfig {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID ?? process.env.GMAIL_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? process.env.GMAIL_CLIENT_SECRET ?? "";
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN ?? "";

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Calendar credentials not configured. Set GOOGLE_CALENDAR_REFRESH_TOKEN in .env " +
      "(and optionally GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET, " +
      "or reuse GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET if they share the same Google Cloud project)."
    );
  }

  return { clientId, clientSecret, refreshToken };
}

// ---------------------------------------------------------------------------
// OAuth2 — same refresh-token flow as Gmail
// ---------------------------------------------------------------------------

async function getAccessToken(config: CalendarConfig): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar OAuth failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const API_BASE = "https://www.googleapis.com/calendar/v3";

async function calGet(path: string, token: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar API error (${response.status}): ${text}`);
  }
  return response.json();
}

async function calPost(path: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar API error (${response.status}): ${text}`);
  }
  return response.json();
}

async function calPatch(path: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar API error (${response.status}): ${text}`);
  }
  return response.json();
}

async function calDelete(path: string, token: string): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar API error (${response.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Google Calendar API types
// ---------------------------------------------------------------------------

interface GoogleCalendar {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
}

interface GoogleCalendarList {
  items?: GoogleCalendar[];
}

interface GoogleEventDateTime {
  dateTime?: string; // RFC 3339 (timed events)
  date?: string;     // YYYY-MM-DD (all-day events)
  timeZone?: string;
}

interface GoogleEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
}

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  attendees?: GoogleEventAttendee[];
  recurrence?: string[];
  recurringEventId?: string;
  reminders?: {
    useDefault?: boolean;
    overrides?: Array<{ method: string; minutes: number }>;
  };
}

interface GoogleEventsList {
  items?: GoogleEvent[];
  summary?: string;
  timeZone?: string;
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatEventTime(dt: GoogleEventDateTime | undefined): string {
  if (!dt) return "(no time)";
  if (dt.dateTime) {
    const d = new Date(dt.dateTime);
    return d.toLocaleString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (dt.date) {
    const d = new Date(dt.date + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }) + " (all day)";
  }
  return "(unknown)";
}

function formatEvent(event: GoogleEvent): string {
  const lines: string[] = [];
  const title = event.summary ?? "(no title)";
  const start = formatEventTime(event.start);
  const end = formatEventTime(event.end);

  lines.push(`${title}`);
  lines.push(`  When: ${start}`);
  if (event.end && (event.end.dateTime || event.end.date)) {
    lines.push(`  Until: ${end}`);
  }
  if (event.location) lines.push(`  Where: ${event.location}`);
  if (event.description) {
    const desc = event.description.length > 200
      ? event.description.slice(0, 200) + "..."
      : event.description;
    lines.push(`  Notes: ${desc}`);
  }
  if (event.attendees && event.attendees.length > 0) {
    const attendeeList = event.attendees
      .filter((a) => !a.self)
      .map((a) => `${a.displayName ?? a.email} (${a.responseStatus ?? "unknown"})`)
      .join(", ");
    if (attendeeList) lines.push(`  Attendees: ${attendeeList}`);
  }
  if (event.recurrence) {
    lines.push(`  Recurrence: ${event.recurrence.join("; ")}`);
  }
  if (event.id) lines.push(`  ID: ${event.id}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const googleCalendarToolDefinitions: Anthropic.Tool[] = [
  {
    name: "list_google_calendars",
    description:
      "List all Google calendars in the user's account. Shows calendar names, IDs, and which is the primary calendar.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_google_events",
    description:
      "List upcoming events from a Google Calendar. Supports date range filtering and text search. " +
      "By default shows events from the primary calendar for the next 7 days.",
    input_schema: {
      type: "object" as const,
      properties: {
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: 'primary'). Use list_google_calendars to find IDs.",
        },
        time_min: {
          type: "string",
          description: "Start of date range, ISO 8601 (default: now). E.g. '2026-02-10T00:00:00Z'",
        },
        time_max: {
          type: "string",
          description: "End of date range, ISO 8601 (default: 7 days from now). E.g. '2026-02-17T23:59:59Z'",
        },
        query: {
          type: "string",
          description: "Free text search across event title, description, location, attendees",
        },
        max_results: {
          type: "number",
          description: "Maximum events to return (default: 20, max: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_google_event",
    description:
      "Get full details of a single Google Calendar event by ID. Returns attendees, description, recurrence, reminders, and link.",
    input_schema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The event ID (from list_google_events)",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: 'primary')",
        },
      },
      required: ["event_id"],
    },
  },
  {
    name: "create_google_event",
    description:
      "Create a new event in Google Calendar. Supports timed events, all-day events, " +
      "attendees, location, description, recurrence, and reminders.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Event title",
        },
        description: {
          type: "string",
          description: "Event description or notes",
        },
        location: {
          type: "string",
          description: "Event location",
        },
        start: {
          type: "string",
          description: "Start date/time. ISO 8601 datetime for timed events (e.g. '2026-02-15T10:00:00'), or YYYY-MM-DD for all-day events (e.g. '2026-02-15')",
        },
        end: {
          type: "string",
          description: "End date/time. Same format as start. For all-day events, use the day AFTER the last day (e.g. '2026-02-16' for a single-day event on the 15th). If omitted for timed events, defaults to 1 hour after start.",
        },
        time_zone: {
          type: "string",
          description: "IANA time zone (e.g. 'America/New_York', 'Europe/London'). Defaults to the calendar's time zone.",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Array of attendee email addresses to invite",
        },
        recurrence: {
          type: "string",
          description: "RFC 5545 RRULE for recurring events (e.g. 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR' or 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15')",
        },
        reminder_minutes: {
          type: "number",
          description: "Pop-up reminder N minutes before event (e.g. 15, 30, 60). Omit to use calendar default.",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: 'primary')",
        },
      },
      required: ["summary", "start"],
    },
  },
  {
    name: "update_google_event",
    description:
      "Update an existing Google Calendar event. Only provided fields are changed — " +
      "omitted fields keep their current values.",
    input_schema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The event ID to update",
        },
        summary: {
          type: "string",
          description: "New event title",
        },
        description: {
          type: "string",
          description: "New description",
        },
        location: {
          type: "string",
          description: "New location",
        },
        start: {
          type: "string",
          description: "New start date/time (ISO 8601 datetime or YYYY-MM-DD)",
        },
        end: {
          type: "string",
          description: "New end date/time",
        },
        time_zone: {
          type: "string",
          description: "IANA time zone",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Replace attendee list with these email addresses",
        },
        reminder_minutes: {
          type: "number",
          description: "Update pop-up reminder (minutes before event)",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: 'primary')",
        },
      },
      required: ["event_id"],
    },
  },
  {
    name: "delete_google_event",
    description: "Delete an event from Google Calendar by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The event ID to delete",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: 'primary')",
        },
      },
      required: ["event_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export async function handleListGoogleCalendars(): Promise<ToolResult> {
  try {
    const config = getCalendarConfig();
    const token = await getAccessToken(config);

    const data = (await calGet("/users/me/calendarList", token)) as GoogleCalendarList;

    if (!data.items || data.items.length === 0) {
      return { success: true, output: "No calendars found in the account." };
    }

    const lines = data.items.map((cal) => {
      const primary = cal.primary ? " (PRIMARY)" : "";
      const tz = cal.timeZone ? ` [${cal.timeZone}]` : "";
      const desc = cal.description ? `\n  ${cal.description}` : "";
      return `${cal.summary}${primary}${tz}\n  ID: ${cal.id}${desc}`;
    });

    return {
      success: true,
      output: `Google Calendars (${data.items.length}):\n\n${lines.join("\n\n")}`,
    };
  } catch (err) {
    return handleCalendarError(err, "list calendars");
  }
}

export async function handleListGoogleEvents(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const config = getCalendarConfig();
    const token = await getAccessToken(config);

    const calendarId = encodeURIComponent((input.calendar_id as string) ?? "primary");
    const maxResults = Math.min((input.max_results as number) ?? 20, 100);

    const now = new Date();
    const timeMin = (input.time_min as string) ?? now.toISOString();
    const defaultMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const timeMax = (input.time_max as string) ?? defaultMax.toISOString();

    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime",
    });

    if (input.query) {
      params.set("q", input.query as string);
    }

    const data = (await calGet(
      `/calendars/${calendarId}/events?${params}`,
      token,
    )) as GoogleEventsList;

    const events = data.items ?? [];

    if (events.length === 0) {
      const queryNote = input.query ? ` matching "${input.query}"` : "";
      return { success: true, output: `No events found${queryNote} in the specified time range.` };
    }

    const formatted = events.map(formatEvent);

    return {
      success: true,
      output: `Google Calendar Events (${events.length}):\n\n${formatted.join("\n\n")}`,
    };
  } catch (err) {
    return handleCalendarError(err, "list events");
  }
}

export async function handleGetGoogleEvent(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const config = getCalendarConfig();
    const token = await getAccessToken(config);

    const calendarId = encodeURIComponent((input.calendar_id as string) ?? "primary");
    const eventId = input.event_id as string;

    if (!eventId) {
      return { success: false, output: "event_id is required." };
    }

    const event = (await calGet(
      `/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
      token,
    )) as GoogleEvent;

    const lines: string[] = [];
    lines.push(`Title: ${event.summary ?? "(no title)"}`);
    lines.push(`When: ${formatEventTime(event.start)}`);
    if (event.end) lines.push(`Until: ${formatEventTime(event.end)}`);
    if (event.location) lines.push(`Location: ${event.location}`);
    if (event.description) lines.push(`Description:\n${event.description}`);
    if (event.status) lines.push(`Status: ${event.status}`);
    if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);
    if (event.attendees && event.attendees.length > 0) {
      const atts = event.attendees.map((a) =>
        `  - ${a.displayName ?? a.email} <${a.email}> (${a.responseStatus ?? "unknown"})${a.self ? " (you)" : ""}`,
      );
      lines.push(`Attendees:\n${atts.join("\n")}`);
    }
    if (event.recurrence) {
      lines.push(`Recurrence: ${event.recurrence.join("; ")}`);
    }
    if (event.reminders) {
      if (event.reminders.useDefault) {
        lines.push("Reminders: calendar default");
      } else if (event.reminders.overrides) {
        const rems = event.reminders.overrides.map((r) => `${r.minutes}min (${r.method})`);
        lines.push(`Reminders: ${rems.join(", ")}`);
      }
    }
    lines.push(`ID: ${event.id}`);
    if (event.created) lines.push(`Created: ${new Date(event.created).toLocaleString()}`);
    if (event.updated) lines.push(`Updated: ${new Date(event.updated).toLocaleString()}`);

    return { success: true, output: lines.join("\n") };
  } catch (err) {
    return handleCalendarError(err, "get event");
  }
}

export async function handleCreateGoogleEvent(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const config = getCalendarConfig();
    const token = await getAccessToken(config);

    const calendarId = encodeURIComponent((input.calendar_id as string) ?? "primary");
    const summary = input.summary as string;
    const startStr = input.start as string;

    if (!summary || !startStr) {
      return { success: false, output: "summary and start are required." };
    }

    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(startStr);
    const timeZone = (input.time_zone as string) || appConfig.owner.timezone;

    // Build start/end
    const startObj: GoogleEventDateTime = {};
    const endObj: GoogleEventDateTime = {};

    if (isAllDay) {
      startObj.date = startStr;
      if (input.end) {
        endObj.date = input.end as string;
      } else {
        // Single all-day event: end = next day
        const d = new Date(startStr + "T00:00:00");
        d.setDate(d.getDate() + 1);
        endObj.date = d.toISOString().split("T")[0];
      }
    } else {
      startObj.dateTime = startStr;
      startObj.timeZone = timeZone;

      if (input.end) {
        endObj.dateTime = input.end as string;
        endObj.timeZone = timeZone;
      } else {
        // Default: 1 hour after start
        const d = new Date(startStr);
        d.setHours(d.getHours() + 1);
        endObj.dateTime = d.toISOString();
        endObj.timeZone = timeZone;
      }
    }

    const eventBody: Record<string, unknown> = {
      summary,
      start: startObj,
      end: endObj,
    };

    if (input.description) eventBody.description = input.description as string;
    if (input.location) eventBody.location = input.location as string;

    if (input.attendees) {
      const emails = input.attendees as string[];
      eventBody.attendees = emails.map((email) => ({ email }));
    }

    if (input.recurrence) {
      eventBody.recurrence = [input.recurrence as string];
    }

    if (input.reminder_minutes !== undefined) {
      eventBody.reminders = {
        useDefault: false,
        overrides: [{ method: "popup", minutes: input.reminder_minutes as number }],
      };
    }

    const created = (await calPost(
      `/calendars/${calendarId}/events`,
      token,
      eventBody,
    )) as GoogleEvent;

    const lines: string[] = [];
    lines.push(`Event created: "${created.summary}"`);
    lines.push(`When: ${formatEventTime(created.start)}`);
    if (created.location) lines.push(`Where: ${created.location}`);
    if (created.htmlLink) lines.push(`Link: ${created.htmlLink}`);
    lines.push(`ID: ${created.id}`);

    return { success: true, output: lines.join("\n") };
  } catch (err) {
    return handleCalendarError(err, "create event");
  }
}

export async function handleUpdateGoogleEvent(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const config = getCalendarConfig();
    const token = await getAccessToken(config);

    const calendarId = encodeURIComponent((input.calendar_id as string) ?? "primary");
    const eventId = input.event_id as string;

    if (!eventId) {
      return { success: false, output: "event_id is required." };
    }

    const patch: Record<string, unknown> = {};
    const updates: string[] = [];

    if (input.summary !== undefined) {
      patch.summary = input.summary as string;
      updates.push("title");
    }
    if (input.description !== undefined) {
      patch.description = input.description as string;
      updates.push("description");
    }
    if (input.location !== undefined) {
      patch.location = input.location as string;
      updates.push("location");
    }

    const timeZone = (input.time_zone as string) || appConfig.owner.timezone;

    if (input.start !== undefined) {
      const startStr = input.start as string;
      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(startStr);
      if (isAllDay) {
        patch.start = { date: startStr };
      } else {
        patch.start = { dateTime: startStr, timeZone } as GoogleEventDateTime;
      }
      updates.push("start");
    }
    if (input.end !== undefined) {
      const endStr = input.end as string;
      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(endStr);
      if (isAllDay) {
        patch.end = { date: endStr };
      } else {
        patch.end = { dateTime: endStr, timeZone } as GoogleEventDateTime;
      }
      updates.push("end");
    }

    if (input.attendees !== undefined) {
      const emails = input.attendees as string[];
      patch.attendees = emails.map((email) => ({ email }));
      updates.push("attendees");
    }

    if (input.reminder_minutes !== undefined) {
      patch.reminders = {
        useDefault: false,
        overrides: [{ method: "popup", minutes: input.reminder_minutes as number }],
      };
      updates.push("reminder");
    }

    if (updates.length === 0) {
      return { success: true, output: "No changes provided." };
    }

    const updated = (await calPatch(
      `/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
      token,
      patch,
    )) as GoogleEvent;

    return {
      success: true,
      output: `Updated event "${updated.summary}" — changed: ${updates.join(", ")}`,
    };
  } catch (err) {
    return handleCalendarError(err, "update event");
  }
}

export async function handleDeleteGoogleEvent(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const config = getCalendarConfig();
    const token = await getAccessToken(config);

    const calendarId = encodeURIComponent((input.calendar_id as string) ?? "primary");
    const eventId = input.event_id as string;

    if (!eventId) {
      return { success: false, output: "event_id is required." };
    }

    await calDelete(
      `/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
      token,
    );

    return { success: true, output: `Event ${eventId} deleted from Google Calendar.` };
  } catch (err) {
    return handleCalendarError(err, "delete event");
  }
}

// ---------------------------------------------------------------------------
// Shared error handler
// ---------------------------------------------------------------------------

function handleCalendarError(err: unknown, action: string): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("403") || msg.includes("insufficient") || msg.includes("accessNotConfigured")) {
    return {
      success: false,
      output:
        `Google Calendar API access denied. Your OAuth token may need the "https://www.googleapis.com/auth/calendar" scope.\n\n` +
        `To fix:\n` +
        `1. Enable the Google Calendar API in your Google Cloud Console\n` +
        `2. Re-run the OAuth consent flow with the calendar scope\n` +
        `3. Set the new refresh token as GOOGLE_CALENDAR_REFRESH_TOKEN in .env\n\n` +
        `Error: ${msg}`,
    };
  }
  return { success: false, output: `Failed to ${action}: ${msg}` };
}
