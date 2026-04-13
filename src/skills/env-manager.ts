import { readFile, writeFile } from "node:fs/promises";
import { ENV_PATH } from "../env.js";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

const ALLOWED_KEYS = new Set([
  "PRIMARY_LLM_PROVIDER",
  "PRIMARY_LLM_API_KEY",
  "PRIMARY_LLM_MODEL",
  "OPENAI_API_KEY",
  "OWNER_NAME",
  "OWNER_TIMEZONE",
  "OWNER_NOTES",
  "TELEGRAM_BOT_TOKEN",
  "OWNER_USER_ID",
  "BOB_API_TOKEN",
  "DASHBOARD_PORT",
  "BACKUP_PATH",
  "BACKUP_INTERVAL_DAYS",
  "WORKER_INTERVAL_MS",
  "WORKER_MAX_STEPS_PER_HOUR",
  "EBAY_CLIENT_ID",
  "EBAY_CLIENT_SECRET",
  "EBAY_REFRESH_TOKEN",
  "EBAY_ENVIRONMENT",
  "EBAY_RUNAME",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REFRESH_TOKEN",
  "ETSY_API_KEY",
  "ETSY_SHARED_SECRET",
  "ETSY_REFRESH_TOKEN",
  "ETSY_SHOP_ID",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "OWNER_PHONE_NUMBER",
  "SECONDARY_LLM_PROVIDER",
  "SECONDARY_LLM_API_KEY",
  "SECONDARY_LLM_MODEL",
  "SECONDARY_LLM_BASE_URL",
  "DEFAULT_COST_MODE",
  "CODING_LLM_API_KEY",
  "CODING_LLM_PROVIDER",
  "CODING_LLM_MODEL",
  "BOB_VOICE",
  "HA_URL",
  "HA_TOKEN",
  "A2A_ENABLED",
  "A2A_DISCOVERY_MODE",
  "A2A_PUBLIC_URL",
  "A2A_AGENT_NAME",
  "A2A_DEFAULT_TRUST",
  "A2A_APPROVAL_TIMEOUT_MIN",
]);

const RESTART_REQUIRED_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "OWNER_USER_ID",
  "A2A_ENABLED",
  "A2A_DISCOVERY_MODE",
  "A2A_PUBLIC_URL",
  "A2A_AGENT_NAME",
  "A2A_DEFAULT_TRUST",
  "A2A_APPROVAL_TIMEOUT_MIN",
]);

export const envManagerToolDefinitions: ToolDefinition[] = [
  {
    name: "set_env_var",
    description:
      "Safely add or update a single environment variable in the .env file. " +
      "IMPORTANT: Only pre-defined key names are accepted - do NOT invent new key names. " +
      "Call list_env_keys first to see all valid key names. " +
      "For eBay: use EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN, EBAY_ENVIRONMENT, EBAY_RUNAME. " +
      "Set EBAY_ENVIRONMENT to 'sandbox' or 'production' - same keys, just update the values. " +
      "Most changes take effect immediately. Startup services like Telegram and A2A still require a restart.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "The environment variable name. Must be a known Bob configuration key.",
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
      "List which environment variables are currently SET (not their values) in the .env file. " +
      "Returns only the key names and whether they have a value - never reveals the actual values. " +
      "Use this to check what's configured and what's missing.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: [
            "all",
            "core",
            "telegram",
            "dashboard",
            "ebay",
            "gmail",
            "google_calendar",
            "etsy",
            "twilio",
            "backup",
            "cost_mode",
            "coding_brain",
            "voice",
            "home_assistant",
            "a2a",
          ],
          description: "Filter by category (default: 'all')",
        },
      },
      required: [],
    },
  },
];

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

function normalizeEnvValue(key: string, rawValue: string): string {
  let value = rawValue.trim();

  // If the model/user passed KEY=value, keep only the RHS.
  const prefixed = value.match(/^([A-Z0-9_]+)\s*=(.*)$/s);
  if (prefixed && prefixed[1] === key) {
    value = prefixed[2] ?? "";
  }

  // Strip one layer of matching quotes from pasted values.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return value.trim();
}

function serializeEnvValue(value: string): string {
  // Quote values so dotenv preserves characters like # in eBay refresh tokens.
  return JSON.stringify(value);
}

export async function setEnvVarValue(key: string, value: string): Promise<{ found: boolean }> {
  const content = await readEnvFile();
  const lines = parseEnvLines(content);
  const serializedValue = serializeEnvValue(value);

  let found = false;
  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    const uncommentedMatch = trimmed.match(new RegExp(`^${key}\\s*=`));
    const commentedMatch = trimmed.match(new RegExp(`^#\\s*${key}\\s*=`));

    if (uncommentedMatch || commentedMatch) {
      found = true;
      return `${key}=${serializedValue}`;
    }

    return line;
  });

  if (!found) {
    updatedLines.push(`${key}=${serializedValue}`);
  }

  const newContent = updatedLines.join("\n").replace(/\n*$/, "\n");
  await writeFile(ENV_PATH, newContent, "utf-8");
  process.env[key] = value;

  return { found };
}

export async function handleSetEnvVar(input: Record<string, unknown>): Promise<ToolResult> {
  const key = (input.key as string)?.trim().toUpperCase();
  const value = normalizeEnvValue(key, String(input.value ?? ""));

  if (!key || input.value === undefined) {
    return { success: false, output: "Both key and value are required." };
  }

  if (!ALLOWED_KEYS.has(key)) {
    const prefix = key.split("_")[0] ?? key;
    const serviceKeys = [...ALLOWED_KEYS].filter((candidate) => candidate.startsWith(prefix + "_"));
    const hint = serviceKeys.length > 0
      ? `\n\nValid ${prefix} keys: ${serviceKeys.join(", ")}`
      : "\n\nUse list_env_keys to see all valid key names.";

    return {
      success: false,
      output:
        `"${key}" is not a valid key. Do NOT invent new key names - only pre-defined keys are accepted.${hint}\n\n` +
        "To switch environments (for example sandbox to production), update EBAY_ENVIRONMENT instead of creating separate keys.",
    };
  }

  if (!value) {
    return { success: false, output: `Value for ${key} cannot be empty.` };
  }

  if (key === "EBAY_REFRESH_TOKEN" && /[?&]code=/.test(value)) {
    return {
      success: false,
      output:
        "That looks like an eBay OAuth redirect URL or authorization code, not a refresh token. " +
        "Use ebay_exchange_code with the redirect URL/code instead of set_env_var.",
    };
  }

  const { found } = await setEnvVarValue(key, value);
  const restartNote = RESTART_REQUIRED_KEYS.has(key)
    ? " Restart Bob for startup-only services to pick up the new value."
    : " Active immediately - no restart needed.";

  return {
    success: true,
    output: `${found ? "Updated" : "Added"} ${key} in .env.${restartNote}`,
  };
}

export async function handleListEnvKeys(input: Record<string, unknown>): Promise<ToolResult> {
  const category = (input.category as string) ?? "all";

  const categories: Record<string, { keys: string[]; hint?: string }> = {
    core: {
      keys: ["PRIMARY_LLM_PROVIDER", "PRIMARY_LLM_API_KEY", "PRIMARY_LLM_MODEL", "OPENAI_API_KEY", "OWNER_NAME", "OWNER_TIMEZONE", "OWNER_NOTES"],
    },
    telegram: { keys: ["TELEGRAM_BOT_TOKEN", "OWNER_USER_ID"] },
    dashboard: { keys: ["BOB_API_TOKEN", "DASHBOARD_PORT"] },
    backup: { keys: ["BACKUP_PATH", "BACKUP_INTERVAL_DAYS", "WORKER_INTERVAL_MS", "WORKER_MAX_STEPS_PER_HOUR"] },
    ebay: {
      keys: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN", "EBAY_ENVIRONMENT", "EBAY_RUNAME"],
      hint: "Set EBAY_ENVIRONMENT to 'sandbox' or 'production'. Same keys for both - just update the values. EBAY_RUNAME is the redirect URI name for OAuth setup.",
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
      hint: "Secondary model for cost optimization. Gemini Flash is cheap, or Ollama works via SECONDARY_LLM_BASE_URL=http://localhost:11434/v1.",
    },
    coding_brain: {
      keys: ["CODING_LLM_API_KEY", "CODING_LLM_PROVIDER", "CODING_LLM_MODEL"],
      hint: "Dedicated model for code tasks. Defaults to Claude Opus 4.6 if you provide an Anthropic key.",
    },
    voice: {
      keys: ["OPENAI_API_KEY", "BOB_VOICE"],
      hint: "OPENAI_API_KEY enables Whisper transcription if your primary LLM is not OpenAI. BOB_VOICE changes the TTS voice.",
    },
    home_assistant: {
      keys: ["HA_URL", "HA_TOKEN"],
      hint: "Home Assistant tools become usable immediately after setting these, but a restart is still sensible for startup integrations.",
    },
    a2a: {
      keys: ["A2A_ENABLED", "A2A_DISCOVERY_MODE", "A2A_PUBLIC_URL", "A2A_AGENT_NAME", "A2A_DEFAULT_TRUST", "A2A_APPROVAL_TIMEOUT_MIN"],
      hint: "A2A server settings are stored immediately, but enabling or reconfiguring the A2A server requires a restart.",
    },
  };

  const selectedCategory = category === "all" ? null : categories[category];
  const keysToCheck = category === "all" ? [...ALLOWED_KEYS] : selectedCategory?.keys ?? [];

  if (keysToCheck.length === 0) {
    return { success: false, output: `Unknown category: "${category}". Use: ${Object.keys(categories).join(", ")}` };
  }

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
    for (const [catName, catInfo] of Object.entries(categories)) {
      const catLines = catInfo.keys.map((key) => `  ${setKeys.has(key) ? "[SET]" : "[   ]"} ${key}`);
      let section = `${catName.toUpperCase()}:\n${catLines.join("\n")}`;
      if (catInfo.hint) section += `\n  Note: ${catInfo.hint}`;
      results.push(section);
    }
  } else {
    for (const key of keysToCheck) {
      results.push(`${setKeys.has(key) ? "[SET]" : "[   ]"} ${key}`);
    }
    if (selectedCategory?.hint) {
      results.push(`\nNote: ${selectedCategory.hint}`);
    }
  }

  return {
    success: true,
    output: results.join("\n\n"),
  };
}
