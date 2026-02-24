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
  // Primary LLM
  "PRIMARY_LLM_PROVIDER",
  "PRIMARY_LLM_API_KEY",
  "PRIMARY_LLM_MODEL",
  // Owner
  "OWNER_NAME",
  "OWNER_TIMEZONE",

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
  "EBAY_RUNAME",

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

  // Secondary LLM (cost mode)
  "SECONDARY_LLM_PROVIDER",
  "SECONDARY_LLM_API_KEY",
  "SECONDARY_LLM_MODEL",
  "SECONDARY_LLM_BASE_URL",
  "DEFAULT_COST_MODE",
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
      "IMPORTANT: Only pre-defined key names are accepted — do NOT invent new key names. " +
      "Call list_env_keys first to see all valid key names. " +
      "For eBay: use EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN, EBAY_ENVIRONMENT. " +
      "Set EBAY_ENVIRONMENT to 'sandbox' or 'production' — same keys, just update the values. " +
      "Changes take effect immediately (no restart needed).",
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
          enum: ["all", "core", "telegram", "dashboard", "ebay", "gmail", "google_calendar", "etsy", "twilio", "backup", "cost_mode"],
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
    // Find all allowed keys with matching service prefix (e.g. EBAY_, GMAIL_)
    const prefix = key.split("_").slice(0, 1)[0]; // e.g. "EBAY" from "EBAY_PROD_CLIENT_ID"
    const serviceKeys = [...ALLOWED_KEYS].filter((k) => k.startsWith(prefix + "_"));
    const hint = serviceKeys.length > 0
      ? `\n\nValid ${prefix} keys: ${serviceKeys.join(", ")}`
      : `\n\nUse list_env_keys to see all valid key names.`;
    return {
      success: false,
      output:
        `"${key}" is not a valid key. Do NOT invent new key names — only pre-defined keys are accepted.${hint}\n\n` +
        "To switch environments (e.g. sandbox→production), update EBAY_ENVIRONMENT — do not create separate keys.",
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

  // Apply immediately to the running process — no restart needed
  process.env[key] = value;

  return {
    success: true,
    output: `${found ? "Updated" : "Added"} ${key} in .env. Active immediately — no restart needed.`,
  };
}

export async function handleListEnvKeys(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const category = (input.category as string) ?? "all";

  const categories: Record<string, { keys: string[]; hint?: string }> = {
    core: { keys: ["PRIMARY_LLM_PROVIDER", "PRIMARY_LLM_API_KEY", "PRIMARY_LLM_MODEL", "OWNER_NAME", "OWNER_TIMEZONE"] },
    telegram: { keys: ["TELEGRAM_BOT_TOKEN", "OWNER_USER_ID"] },
    dashboard: { keys: ["BOB_API_TOKEN", "DASHBOARD_PORT"] },
    backup: { keys: ["BACKUP_PATH", "BACKUP_INTERVAL_DAYS"] },
    ebay: {
      keys: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN", "EBAY_ENVIRONMENT", "EBAY_RUNAME"],
      hint: "Set EBAY_ENVIRONMENT to 'sandbox' or 'production'. Same keys for both — just update the values. EBAY_RUNAME is the redirect URI name for OAuth setup.",
    },
    gmail: {
      keys: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
      hint: "OAuth2 credentials from Google Cloud Console.",
    },
    google_calendar: {
      keys: ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN"],
      hint: "Falls back to Gmail credentials if not set separately.",
    },
    etsy: { keys: ["ETSY_API_KEY", "ETSY_SHARED_SECRET", "ETSY_REFRESH_TOKEN", "ETSY_SHOP_ID"] },
    twilio: { keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OWNER_PHONE_NUMBER"] },
    cost_mode: {
      keys: ["SECONDARY_LLM_PROVIDER", "SECONDARY_LLM_API_KEY", "SECONDARY_LLM_MODEL", "SECONDARY_LLM_BASE_URL", "DEFAULT_COST_MODE"],
      hint: "Secondary model for cost optimization. Gemini Flash (30x cheaper), or Ollama for free local models (SECONDARY_LLM_BASE_URL=http://localhost:11434/v1).",
    },
  };

  const cat = category === "all" ? null : categories[category];
  const keysToCheck = category === "all"
    ? [...ALLOWED_KEYS]
    : cat?.keys ?? [];

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
    for (const [catName, catInfo] of Object.entries(categories)) {
      const catLines = catInfo.keys.map((k) => {
        const isSet = setKeys.has(k);
        return `  ${isSet ? "[SET]" : "[   ]"} ${k}`;
      });
      let section = `${catName.toUpperCase()}:\n${catLines.join("\n")}`;
      if (catInfo.hint) section += `\n  Note: ${catInfo.hint}`;
      results.push(section);
    }
  } else {
    for (const k of keysToCheck) {
      const isSet = setKeys.has(k);
      results.push(`${isSet ? "[SET]" : "[   ]"} ${k}`);
    }
    if (cat?.hint) results.push(`\nNote: ${cat.hint}`);
  }

  return {
    success: true,
    output: results.join("\n\n"),
  };
}
