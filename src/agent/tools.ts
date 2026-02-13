import type { ToolDefinition } from "../providers/types.js";
import { imageToolDefinitions } from "../skills/image-processing.js";
import { ebayToolDefinitions } from "../skills/ebay-listing.js";
import { batchListerToolDefinitions } from "../skills/batch-lister.js";
import { backupToolDefinitions } from "../skills/backup.js";
import { schedulerToolDefinitions } from "../skills/scheduler.js";
import { gmailToolDefinitions } from "../skills/gmail.js";
import { webMonitorToolDefinitions } from "../skills/web-monitor.js";
import { visionToolDefinitions } from "../skills/vision.js";
import { formFillerToolDefinitions } from "../skills/form-filler.js";
import { taskManagerToolDefinitions } from "../skills/task-manager.js";
import { inventoryToolDefinitions } from "../skills/inventory.js";
import { pdfFormToolDefinitions } from "../skills/pdf-forms.js";
import { calendarToolDefinitions } from "../skills/calendar.js";
import { socialMediaToolDefinitions } from "../skills/social-media.js";
import { translationToolDefinitions } from "../skills/translation.js";
import { weatherToolDefinitions } from "../skills/weather.js";
import { contactsToolDefinitions } from "../skills/contacts.js";
import { remindersToolDefinitions } from "../skills/reminders.js";
import { expensesToolDefinitions } from "../skills/expenses.js";
import { invoiceToolDefinitions } from "../skills/invoices.js";
import { summarizerToolDefinitions } from "../skills/summarizer.js";
import { fileOrganizerToolDefinitions } from "../skills/file-organizer.js";
import { quickCaptureToolDefinitions } from "../skills/quick-capture.js";
import { browserToolDefinitions } from "../skills/browser.js";
import { phoneToolDefinitions } from "../skills/phone.js";
import { marketplaceToolDefinitions } from "../skills/marketplace.js";
import { googleCalendarToolDefinitions } from "../skills/google-calendar.js";
import { envManagerToolDefinitions } from "../skills/env-manager.js";
import { standingRulesToolDefinitions } from "../skills/standing-rules.js";
import { a2aClientToolDefinitions } from "../skills/a2a-client.js";
import { mcpManagerToolDefinitions } from "../skills/mcp-manager.js";
import { analyticsToolDefinitions } from "../skills/analytics.js";
import { homeAssistantToolDefinitions } from "../skills/home-assistant.js";
import { getMcpToolDefinitions } from "../mcp/client.js";
import { config } from "../config.js";
import { loadLocalSkills, getLocalToolDefinitions } from "../skills/local-loader.js";

// Built-in tool definitions
const builtinTools: ToolDefinition[] = [
  {
    name: "fetch_url",
    description:
      "Fetch the contents of a URL. Use this to read API documentation, download JSON from endpoints, or explore web pages. Returns the response body as text.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE"],
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Optional headers as key-value pairs",
          additionalProperties: { type: "string" },
        },
        body: {
          type: "string",
          description: "Optional request body (for POST/PUT)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a local file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a local file. Creates directories if needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a given path.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory path to list (default: current working directory)",
        },
      },
      required: [],
    },
  },
  {
    name: "run_command",
    description:
      "Execute a shell command and return its output. Use for tasks like running scripts, installing packages, or system operations.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "save_note",
    description:
      "Save a named note to persistent memory. Use this to remember important information, task results, user preferences, or anything worth recalling later. Notes persist across restarts.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Short name for the note (used as filename, no spaces — use hyphens)",
        },
        content: {
          type: "string",
          description: "The markdown content to save",
        },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "load_note",
    description:
      "Load a previously saved note from memory by name. Returns the note content or null if it doesn't exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The name of the note to load (without .md extension)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_notes",
    description:
      "List all saved notes in memory. Returns filenames of all notes. Use this to see what you've previously saved.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "update_user_profile",
    description:
      "Update the current user's profile — their name, preferences, or notes about them. Use this when you learn something new about the user (their name, what they're working on, how they like to communicate).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The user's preferred name",
        },
        preferences: {
          type: "object",
          description:
            "Key-value pairs of user preferences to set or update. Known keys: 'notify_default' — comma-separated default notification channels for background tasks (e.g. 'telegram', 'telegram,sms'). Set to '' to clear.",
          additionalProperties: { type: "string" },
        },
        notes: {
          type: "string",
          description: "Free-form notes about the user (replaces existing notes)",
        },
      },
      required: [],
    },
  },
  {
    name: "set_personality",
    description:
      "Change Bob's personality preset. Available presets: default (personable, concise, occasional wit), tars (witty, sarcastic, TARS from Interstellar), professional (no jokes, pure efficiency), minimal (bare facts, terse). Takes effect from the next message onward.",
    input_schema: {
      type: "object" as const,
      properties: {
        preset: {
          type: "string",
          enum: ["default", "tars", "professional", "minimal"],
          description: "The personality preset to use",
        },
      },
      required: ["preset"],
    },
  },
  {
    name: "install_skill",
    description:
      "Hot-install a new skill that you've written to local/skills/. Use this after creating a skill file with write_file. The new tools become available immediately — no restart needed. If the skill fails to load, you'll get the error message so you can fix the file and try again.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: {
          type: "string",
          description: "Name of the skill file (without the .ts extension). E.g. 'weather' for local/skills/weather.ts",
        },
      },
      required: ["skill_name"],
    },
  },
  // Image processing skills
  ...imageToolDefinitions,
  // eBay listing skills
  ...ebayToolDefinitions,
  // Batch workflow skills
  ...batchListerToolDefinitions,
  // Backup & restore skills
  ...backupToolDefinitions,
  // Scheduled tasks skills
  ...schedulerToolDefinitions,
  // Gmail skills
  ...gmailToolDefinitions,
  // Web monitoring skills
  ...webMonitorToolDefinitions,
  // Vision/image analysis skills
  ...visionToolDefinitions,
  // Form filling & personal data vault
  ...formFillerToolDefinitions,
  // Background task management
  ...taskManagerToolDefinitions,
  // Inventory, image display & data reading
  ...inventoryToolDefinitions,
  // PDF form parsing & filling
  ...pdfFormToolDefinitions,
  // Calendar & events
  ...calendarToolDefinitions,
  // Social media post generation
  ...socialMediaToolDefinitions,
  // Translation & language detection
  ...translationToolDefinitions,
  // Weather skills
  ...weatherToolDefinitions,
  // Contacts / address book
  ...contactsToolDefinitions,
  // Reminders with snooze
  ...remindersToolDefinitions,
  // Expense tracking
  ...expensesToolDefinitions,
  // Invoice generation
  ...invoiceToolDefinitions,
  // Document summarizer
  ...summarizerToolDefinitions,
  // File organizer
  ...fileOrganizerToolDefinitions,
  // Quick capture / clipboard
  ...quickCaptureToolDefinitions,
  // Browser automation (Playwright)
  ...browserToolDefinitions,
  // Phone calls & SMS (Twilio)
  ...phoneToolDefinitions,
  // Marketplace engine (eBay, Etsy, Poshmark, local adapters)
  ...marketplaceToolDefinitions,
  // Google Calendar
  ...googleCalendarToolDefinitions,
  // Environment variable management
  ...envManagerToolDefinitions,
  // Standing rules (marketplace monitoring)
  ...standingRulesToolDefinitions,
  // MCP management tools (always available so Bob can self-configure)
  ...mcpManagerToolDefinitions,
  // Analytics & history (search conversations, tool stats, event log)
  ...analyticsToolDefinitions,
  // Home Assistant smart home control (only when HA_TOKEN is set)
  ...(config.homeAssistant.token ? homeAssistantToolDefinitions : []),
  // A2A client tools (only when A2A is enabled)
  ...(config.a2a.enabled ? a2aClientToolDefinitions : []),
];

/**
 * All tool definitions including local skills.
 * Must call initTools() before using this.
 */
export let toolDefinitions: ToolDefinition[] = [...builtinTools];

/**
 * Initialize tools — loads local skills from local/skills/.
 * Call once at startup before the first agent loop.
 */
export async function initTools(): Promise<void> {
  await loadLocalSkills();
  refreshTools();
}

/**
 * Rebuild the toolDefinitions array from builtins + local skills.
 * Called at startup and after hot-installing a new skill.
 */
export function refreshTools(): void {
  const localTools = getLocalToolDefinitions();
  const mcpTools = getMcpToolDefinitions();
  toolDefinitions = [...builtinTools, ...localTools, ...mcpTools];
  const extras = localTools.length + mcpTools.length;
  if (extras > 0) {
    console.log(`Total tools: ${toolDefinitions.length} (${builtinTools.length} built-in + ${localTools.length} local + ${mcpTools.length} MCP)`);
  }
}
