/**
 * Category-based tool loading optimizer.
 *
 * Instead of sending all ~145 tool definitions on every LLM call,
 * this module selects only relevant tools based on the user message.
 * A `load_tools` meta-tool lets the LLM request additional categories mid-conversation.
 *
 * The executor (tool-executor.ts) is fully decoupled — it dispatches by name
 * and can handle any tool call regardless of what definitions were sent to the LLM.
 */

import type { ToolDefinition } from "../providers/types.js";
import { getLocalToolDefinitions } from "../skills/local-loader.js";
import { getMcpToolDefinitions } from "../mcp/client.js";
import { LOAD_KNOWLEDGE_DEF, LIST_KNOWLEDGE_DEF } from "./plugin-loader.js";

// ─── Types ─────────────────────────────────────────────────────────

interface ToolCategory {
  name: string;
  description: string;
  keywords: string[];
  toolNames: string[];
}

// ─── Core tools (always loaded) ────────────────────────────────────

export const CORE_TOOL_NAMES = new Set([
  "fetch_url",
  "read_file",
  "write_file",
  "list_directory",
  "run_command",
  "save_note",
  "load_note",
  "list_notes",
  "update_user_profile",
  "install_skill",
  "get_weather",
  "get_forecast",
  "set_personality",
  "set_cost_mode",
  "load_knowledge",
  "list_knowledge",
]);

// ─── Category registry ─────────────────────────────────────────────

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    name: "image",
    description: "Resize, crop, convert, watermark, analyze images",
    keywords: ["image", "photo", "picture", "resize", "crop", "thumbnail", "watermark", "poster"],
    toolNames: [
      "batch_resize_images", "convert_image_format", "generate_thumbnails",
      "add_watermark", "auto_crop", "analyze_image", "analyze_poster_for_listing",
      "show_image",
    ],
  },
  {
    name: "commerce",
    description: "eBay listings, batch workflows, marketplace orders, shipping, standing rules",
    keywords: [
      "ebay", "listing", "marketplace", "order", "ship", "seller",
      "etsy", "poshmark", "depop", "unshipped", "fulfillment",
      "batch list", "standing rule", "sku", "oauth", "token", "connect", "authorize", "auth",
    ],
    toolNames: [
      // eBay (10)
      "create_ebay_listing", "upload_ebay_image", "search_ebay_category",
      "generate_listing_content", "get_ebay_listing_status", "get_seller_listings",
      "update_ebay_listing", "bulk_update_prices", "ebay_get_auth_url", "ebay_exchange_code",
      // Batch (4)
      "batch_list_posters", "batch_list_status", "review_batch_samples", "approve_batch",
      // Marketplace (10)
      "marketplace_list_platforms", "marketplace_test_connection",
      "marketplace_get_orders", "marketplace_get_order", "marketplace_ship_order",
      "marketplace_get_messages", "marketplace_send_message",
      "marketplace_order_summary", "marketplace_get_unshipped", "marketplace_bulk_ship",
      // Standing rules (4)
      "create_standing_rule", "list_standing_rules", "update_standing_rule", "remove_standing_rule",
      // Env tools (token saving)
      "set_env_var", "list_env_keys",
      // Image tools (listing photos)
      "batch_resize_images", "convert_image_format", "generate_thumbnails",
      "add_watermark", "auto_crop", "analyze_image", "analyze_poster_for_listing", "show_image",
      // Vision (poster analysis)
      "analyze_image", "analyze_poster_for_listing",
      // Inventory (product catalog)
      "read_csv", "read_spreadsheet", "index_inventory", "search_inventory", "get_inventory_stats",
      // Browser (OAuth sign-in)
      "browse_url", "click_element", "type_into", "extract_content", "take_screenshot", "close_browser",
    ],
  },
  {
    name: "email",
    description: "Gmail: check, read, send, search emails; Google Contacts import",
    keywords: ["email", "gmail", "inbox", "mail", "google contact"],
    toolNames: [
      "check_email", "read_email", "send_email", "search_email",
      "get_email_summary", "import_google_contacts", "list_google_contacts",
    ],
  },
  {
    name: "phone",
    description: "Phone calls and SMS via Twilio",
    keywords: ["call me", "call you", "phone", "sms", "text me", "ring", "twilio"],
    toolNames: ["call_owner", "send_sms", "get_call_status"],
  },
  {
    name: "calendar",
    description: "Local and Google Calendar events, meetings, deadlines",
    keywords: ["calendar", "event", "meeting", "appointment", "schedule", "deadline", "google calendar"],
    toolNames: [
      "add_event", "list_events", "update_event", "remove_event", "complete_event",
      "list_google_calendars", "list_google_events", "get_google_event",
      "create_google_event", "update_google_event", "delete_google_event",
    ],
  },
  {
    name: "contacts",
    description: "Address book: add, search, update, delete contacts",
    keywords: ["contact", "address book"],
    toolNames: [
      "add_contact", "search_contacts", "get_contact",
      "update_contact", "delete_contact", "list_contacts",
    ],
  },
  {
    name: "reminders",
    description: "Quick reminders with natural language time + snooze",
    keywords: ["remind", "reminder", "snooze"],
    toolNames: ["set_reminder", "list_reminders", "snooze_reminder", "dismiss_reminder"],
  },
  {
    name: "finance",
    description: "Expense tracking and PDF invoice generation",
    keywords: ["expense", "invoice", "spending", "budget", "receipt"],
    toolNames: [
      "add_expense", "list_expenses", "get_expense_summary", "delete_expense", "export_expenses",
      "create_invoice", "list_invoices", "get_invoice",
    ],
  },
  {
    name: "browser",
    description: "Playwright browser automation (navigate, click, type, screenshot) + stealth browsing with anti-bot detection",
    keywords: [
      "browse", "browser", "website", "web page", "screenshot", "playwright", "scrape",
      "stealth", "incapsula", "imperva", "cloudflare", "bot detection", "fingerprint",
      "intercept", "xhr", "api response", "albertsons",
    ],
    toolNames: [
      "browse_url", "click_element", "type_into",
      "extract_content", "take_screenshot", "close_browser",
      "stealth_browse", "intercept_network", "get_intercepted_data",
      "stealth_scroll", "stealth_close",
    ],
  },
  {
    name: "data",
    description: "Inventory, CSV/spreadsheets, PDF forms, personal data vault",
    keywords: [
      "inventory", "csv", "spreadsheet", "excel", "pdf", "form",
      "vault", "personal data",
    ],
    toolNames: [
      "read_csv", "read_spreadsheet", "index_inventory", "search_inventory", "get_inventory_stats",
      "parse_pdf_form", "fill_pdf_form",
      "save_personal_data", "load_personal_data", "list_personal_data",
      "delete_personal_data", "fill_form_fields", "suggest_form_mapping",
    ],
  },
  {
    name: "productivity",
    description: "Quick capture, summarize docs/URLs, file organizer, social posts, translate",
    keywords: [
      "capture", "summarize", "summary", "organize", "duplicate",
      "social media", "social post", "hashtag", "translate", "language",
    ],
    toolNames: [
      "capture", "list_captures", "search_captures", "delete_capture",
      "summarize_document", "summarize_url",
      "scan_folder", "organize_files", "find_duplicates",
      "generate_social_post", "suggest_social_hashtags",
      "translate_text", "detect_language",
    ],
  },
  {
    name: "monitoring",
    description: "URL change detection, keyword tracking (HN/Reddit)",
    keywords: ["watch", "monitor", "track", "alert", "hacker news", "reddit"],
    toolNames: [
      "watch_url", "watch_keywords", "list_watches", "remove_watch", "check_watches_now",
    ],
  },
  {
    name: "system",
    description: "Backup/restore, scheduler, environment variables",
    keywords: ["backup", "restore", "schedule", "cron", "env", "environment variable"],
    toolNames: [
      "backup_bob", "restore_bob", "list_backups",
      "add_scheduled_task", "remove_scheduled_task", "list_scheduled_tasks", "run_scheduled_task",
      "set_env_var", "list_env_keys",
    ],
  },
  {
    name: "tasks",
    description: "Background task management (create, list, cancel, pause)",
    keywords: ["background task", "task status", "cancel task", "pause task"],
    toolNames: [
      "create_background_task", "list_background_tasks", "get_task_details",
      "cancel_background_task", "update_task_priority", "pause_resume_task",
    ],
  },
  {
    name: "a2a",
    description: "Agent-to-agent communication (discover, send, trust management)",
    keywords: ["a2a", "peer", "discover agent", "agent-to-agent"],
    toolNames: [
      "discover_agent", "send_to_agent", "list_peers", "get_peer_details",
      "set_peer_trust", "remove_peer", "a2a_audit_log", "approve_a2a_request",
    ],
  },
  {
    name: "home",
    description: "Smart home control via Home Assistant: lights, switches, climate, scenes, automations",
    keywords: [
      "home assistant", "smart home", "light", "lights", "switch", "climate",
      "thermostat", "scene", "automation", "device", "sensor",
      "door", "window", "motion", "temperature", "humidity",
      "turn on", "turn off",
    ],
    toolNames: [
      "ha_get_state", "ha_get_all_states", "ha_call_service", "ha_toggle", "ha_set_state",
      "ha_list_scenes", "ha_activate_scene", "ha_list_automations", "ha_toggle_automation",
      "ha_get_history", "ha_get_services", "ha_system_info",
      "ha_watch_device", "ha_list_watches", "ha_remove_watch",
    ],
  },
  {
    name: "analytics",
    description: "Search conversation history, tool usage stats, persistent event log",
    keywords: [
      "history", "search history", "stats", "analytics", "when did",
      "how often", "event log", "tool usage", "most used",
      "task audit", "task history", "background task",
    ],
    toolNames: ["search_history", "get_tool_stats", "get_event_log", "search_tasks", "get_task_audit"],
  },
];

// Build a set of valid category names for quick lookup
const VALID_CATEGORY_NAMES = new Set(TOOL_CATEGORIES.map((c) => c.name));

// Build a reverse map: tool name → category name (for exact tool name matching)
const TOOL_TO_CATEGORY = new Map<string, string>();
for (const cat of TOOL_CATEGORIES) {
  for (const toolName of cat.toolNames) {
    TOOL_TO_CATEGORY.set(toolName, cat.name);
  }
}

// ─── load_tools meta-tool ──────────────────────────────────────────

const categoryList = TOOL_CATEGORIES.map((c) => c.name).join(", ");
const categoryDescriptions = TOOL_CATEGORIES.map(
  (c) => `${c.name} (${c.description})`
).join("; ");

export const LOAD_TOOLS_DEF: ToolDefinition = {
  name: "load_tools",
  description:
    `Load additional tool categories when you need tools not currently available. Categories: ${categoryDescriptions}`,
  input_schema: {
    type: "object" as const,
    properties: {
      categories: {
        type: "array",
        items: { type: "string" },
        description: `Category names to load. Valid: ${categoryList}`,
      },
    },
    required: ["categories"],
  },
};

// ─── Public API ────────────────────────────────────────────────────

/**
 * Select tools relevant to a user message.
 * Returns core tools + keyword-matched categories + local skills + load_tools.
 */
export function selectToolsForMessage(
  message: string,
  allDefs: ToolDefinition[]
): ToolDefinition[] {
  const lower = message.toLowerCase();
  const matchedToolNames = new Set<string>();

  // Always include core tools
  for (const name of CORE_TOOL_NAMES) {
    matchedToolNames.add(name);
  }

  // Check each category's keywords against the message
  const matchedCategories: string[] = [];
  for (const cat of TOOL_CATEGORIES) {
    if (cat.keywords.some((kw) => lower.includes(kw))) {
      matchedCategories.push(cat.name);
      for (const name of cat.toolNames) {
        matchedToolNames.add(name);
      }
    }
  }

  // Check if message contains any exact tool name → load that tool's category
  for (const [toolName, catName] of TOOL_TO_CATEGORY) {
    if (lower.includes(toolName) && !matchedCategories.includes(catName)) {
      matchedCategories.push(catName);
      const cat = TOOL_CATEGORIES.find((c) => c.name === catName)!;
      for (const name of cat.toolNames) {
        matchedToolNames.add(name);
      }
    }
  }

  // Filter allDefs to matched names
  const filtered = allDefs.filter((d) => matchedToolNames.has(d.name));

  // Always include local skills
  const localDefs = getLocalToolDefinitions();
  const existingNames = new Set(filtered.map((d) => d.name));
  for (const def of localDefs) {
    if (!existingNames.has(def.name)) {
      filtered.push(def);
      existingNames.add(def.name);
    }
  }

  // Always include MCP tools (user explicitly configured them)
  const mcpDefs = getMcpToolDefinitions();
  for (const def of mcpDefs) {
    if (!existingNames.has(def.name)) {
      filtered.push(def);
      existingNames.add(def.name);
    }
  }

  // Always append meta-tools
  filtered.push(LOAD_TOOLS_DEF);
  filtered.push(LOAD_KNOWLEDGE_DEF);
  filtered.push(LIST_KNOWLEDGE_DEF);

  if (matchedCategories.length > 0) {
    console.log(`[tool-loader] Matched categories: ${matchedCategories.join(", ")}`);
  }

  return filtered;
}

/**
 * Get tool definitions for the given category names.
 */
export function getToolsForCategories(
  categories: string[],
  allDefs: ToolDefinition[]
): ToolDefinition[] {
  const toolNames = new Set<string>();
  const resolved: string[] = [];
  const unknown: string[] = [];

  for (const catName of categories) {
    const cat = TOOL_CATEGORIES.find((c) => c.name === catName);
    if (cat) {
      resolved.push(catName);
      for (const name of cat.toolNames) {
        toolNames.add(name);
      }
    } else {
      unknown.push(catName);
    }
  }

  if (unknown.length > 0) {
    console.log(`[tool-loader] Unknown categories ignored: ${unknown.join(", ")}`);
  }

  return allDefs.filter((d) => toolNames.has(d.name));
}

/**
 * Build a compact system prompt section listing available tool categories.
 */
export function buildCategorySystemPromptSection(): string {
  const lines = TOOL_CATEGORIES.map(
    (c) => `- ${c.name}: ${c.description} (${c.toolNames.length} tools)`
  );
  const mcpDefs = getMcpToolDefinitions();
  if (mcpDefs.length > 0) {
    lines.push(`\nMCP server tools: ${mcpDefs.length} (always available from connected servers)`);
  }

  return `\n\nTool loading:
You currently have a subset of your tools loaded. If you need tools from another category, use load_tools to activate them.
Available categories:
${lines.join("\n")}`;
}

/**
 * Build a system prompt section listing local skills (always available).
 * Returns empty string if no local skills are loaded.
 */
export function buildLocalSkillsPromptSection(): string {
  const localDefs = getLocalToolDefinitions();
  if (localDefs.length === 0) return "";

  const lines = localDefs.map((d) => {
    const desc = d.description?.split(".")[0]?.slice(0, 120) ?? "No description";
    return `- ${d.name}: ${desc}`;
  });

  return `\n\nYour personal local skills (always loaded — no need for load_tools):
${lines.join("\n")}`;
}

/**
 * Count how many tool categories match a message (keyword matching).
 * Used by cost-mode routing to assess task complexity.
 */
export function countMatchedCategories(message: string): number {
  const lower = message.toLowerCase();
  let count = 0;
  for (const cat of TOOL_CATEGORIES) {
    if (cat.keywords.some((kw) => lower.includes(kw))) {
      count++;
    }
  }
  return count;
}

/**
 * Check if a category name is valid.
 */
export function isValidCategory(name: string): boolean {
  return VALID_CATEGORY_NAMES.has(name);
}
