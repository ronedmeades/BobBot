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
          description: "Key-value pairs of user preferences to set or update",
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
  const localTools = getLocalToolDefinitions();
  toolDefinitions = [...builtinTools, ...localTools];
  if (localTools.length > 0) {
    console.log(`Total tools available: ${toolDefinitions.length} (${builtinTools.length} built-in + ${localTools.length} local)`);
  }
}
