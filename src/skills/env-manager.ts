import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Allowlist of known Bob env vars — only these can be set
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set([
  // Core
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_MODEL",
  "OWNER_NAME",
  "OWNER_TIMEZONE",
  "ANTHROPIC_API_KEY",

  // Telegram
  "TELEGRAM_BOT_TOKEN",
  "OWNER_USER_ID",

  // Dashboard
  "BOB_API_TOKEN",
  "DASHBOARD_PORT",

  // Backup
  "BACKUP_PATH",
  "BACKUP_INTERVAL_DAYS",

  // eBay
  "EBAY_CLIENT_ID",
  "EBAY_CLIENT_SECRET",
  "EBAY_REFRESH_TOKEN",
  "EBAY_ENVIRONMENT",

  // Gmail
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",

  // Google Calendar
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REFRESH_TOKEN",

  // Etsy
  "ETSY_API_KEY",
  "ETSY_SHARED_SECRET",
  "ETSY_REFRESH_TOKEN",
  "ETSY_SHOP_ID",

  // Twilio
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "OWNER_PHONE_NUMBER",
]);

const ENV_PATH = resolve(".env");

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const envManagerToolDefinitions: ToolDefinition[] = [
  {
    name: "set_env_var",
    description:
      "Safely add or update a single environment variable in the .env file. " +
      "Only known Bob configuration keys are allowed (e.g. GMAIL_CLIENT_ID, EBAY_CLIENT_SECRET, " +
      "TELEGRAM_BOT_TOKEN, etc.). This NEVER reads or returns other values from .env — it only " +
      "updates the specified key. Use this when a user provides an API key, token, or credential " +
      "and wants Bob to save it. Note: Bob must be restarted for new env vars to take effect.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description:
            "The environment variable name (e.g. 'GMAIL_CLIENT_ID', 'EBAY_REFRESH_TOKEN'). " +
            "Must be a known Bob configuration key.",
        },
        value: {
          type: "string",
          description: "The value to set",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "list_env_keys",
    description:
      "List which environment variables are currently SET (not their values!) in the .env file. " +
      "Returns only the key names and whether they have a value — never reveals the actual values. " +
      "Use this to check what's configured and what's missing.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: ["all", "core", "telegram", "dashboard", "ebay", "gmail", "google_calendar", "etsy", "twilio", "backup"],
          description: "Filter by category (default: 'all')",
        },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readEnvFile(): Promise<string> {
  try {
    return await readFile(ENV_PATH, "utf-8");
  } catch {
    return "";
  }
}

function parseEnvLines(content: string): string[] {
  return content.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleSetEnvVar(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const key = (input.key as string)?.trim().toUpperCase();
  const value = (input.value as string)?.trim();

  if (!key || value === undefined) {
    return { success: false, output: "Both key and value are required." };
  }

  if (!ALLOWED_KEYS.has(key)) {
    const suggestions = [...ALLOWED_KEYS]
      .filter((k) => k.includes(key) || key.includes(k.split("_").pop() ?? ""))
      .slice(0, 5);
    const hint = suggestions.length > 0
      ? `\n\nDid you mean: ${suggestions.join(", ")}?`
      : `\n\nAllowed keys include: ${[...ALLOWED_KEYS].slice(0, 10).join(", ")}, ...`;
    return {
      success: false,
      output: `"${key}" is not a recognized Bob configuration key. Only known keys can be set for security.${hint}`,
    };
  }

  if (!value) {
    return { success: false, output: `Value for ${key} cannot be empty.` };
  }

  const content = await readEnvFile();
  const lines = parseEnvLines(content);

  // Find existing line for this key (commented or uncommented)
  let found = false;
  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();

    // Match: KEY=value or # KEY=value
    const uncommentedMatch = trimmed.match(new RegExp(`^${key}\\s*=`));
    const commentedMatch = trimmed.match(new RegExp(`^#\\s*${key}\\s*=`));

    if (uncommentedMatch || commentedMatch) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    // Append to end
    updatedLines.push(`${key}=${value}`);
  }

  // Ensure file ends with newline
  const newContent = updatedLines.join("\n").replace(/\n*$/, "\n");
  await writeFile(ENV_PATH, newContent, "utf-8");

  return {
    success: true,
    output:
      `${found ? "Updated" : "Added"} ${key} in .env.\n\n` +
      "Note: Restart Bob for this change to take effect.",
  };
}

export async function handleListEnvKeys(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const category = (input.category as string) ?? "all";

  const categories: Record<string, string[]> = {
    core: ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "OWNER_NAME", "OWNER_TIMEZONE", "ANTHROPIC_API_KEY"],
    telegram: ["TELEGRAM_BOT_TOKEN", "OWNER_USER_ID"],
    dashboard: ["BOB_API_TOKEN", "DASHBOARD_PORT"],
    backup: ["BACKUP_PATH", "BACKUP_INTERVAL_DAYS"],
    ebay: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN", "EBAY_ENVIRONMENT"],
    gmail: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
    google_calendar: ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN"],
    etsy: ["ETSY_API_KEY", "ETSY_SHARED_SECRET", "ETSY_REFRESH_TOKEN", "ETSY_SHOP_ID"],
    twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OWNER_PHONE_NUMBER"],
  };

  const keysToCheck = category === "all"
    ? [...ALLOWED_KEYS]
    : categories[category] ?? [];

  if (keysToCheck.length === 0) {
    return { success: false, output: `Unknown category: "${category}". Use: ${Object.keys(categories).join(", ")}` };
  }

  // Read .env and find which keys are set (without revealing values)
  const content = await readEnvFile();
  const lines = parseEnvLines(content);

  const setKeys = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (val) setKeys.add(key);
  }

  const results: string[] = [];

  if (category === "all") {
    // Group by category
    for (const [catName, catKeys] of Object.entries(categories)) {
      const catLines = catKeys.map((k) => {
        const isSet = setKeys.has(k);
        return `  ${isSet ? "[SET]" : "[   ]"} ${k}`;
      });
      results.push(`${catName.toUpperCase()}:\n${catLines.join("\n")}`);
    }
  } else {
    for (const k of keysToCheck) {
      const isSet = setKeys.has(k);
      results.push(`${isSet ? "[SET]" : "[   ]"} ${k}`);
    }
  }

  return {
    success: true,
    output: results.join("\n\n"),
  };
}
