/**
 * A2A Three-Tier Tool Security Boundary
 *
 * Categorizes Bob's ~137 tools into three tiers for external access:
 *
 * BLOCKED — Never exposed externally (credentials, filesystem, system)
 * DATA    — Personal/business data, Trusted tier only
 * SAFE    — Everything else, available to any authenticated peer
 *
 * Architecture supports future upgrade to per-peer custom allowlists
 * by swapping set lookups for peer.allowedTools[].
 */

import { toolDefinitions } from "../agent/tools.js";
import type { ToolDefinition } from "../providers/types.js";
import type { TrustTier, AgentCardSkill } from "./types.js";
import { isMcpTool } from "../mcp/client.js";

// ─── BLOCKED: Never exposed externally ──────────────────────────────
// Filesystem, system, credentials, owner comms, business operations

const BLOCKED_TOOLS = new Set([
  // Core — filesystem & system access
  "run_command",
  "read_file",
  "write_file",
  "list_directory",
  "fetch_url",           // SSRF risk — could scan internal network

  // Memory — owner's private data
  "save_note",
  "load_note",
  "list_notes",
  "update_user_profile",
  "install_skill",       // Code execution

  // Personal data vault
  "save_personal_data",
  "load_personal_data",
  "list_personal_data",
  "delete_personal_data",
  "fill_form_fields",
  "suggest_form_mapping",

  // Backup & restore — system level
  "backup_bob",
  "restore_bob",
  "list_backups",

  // Scheduler — system level
  "add_scheduled_task",
  "remove_scheduled_task",
  "list_scheduled_tasks",
  "run_scheduled_task",

  // Environment — credentials
  "set_env_var",
  "list_env_keys",

  // Owner communication — never let external agents contact the owner
  "call_owner",
  "send_sms",
  "get_call_status",

  // Email — could be used for spam or phishing
  "check_email",
  "read_email",
  "send_email",
  "search_email",
  "get_email_summary",
  "import_google_contacts",
  "list_google_contacts",

  // Browser automation — full browser control
  "browse_url",
  "click_element",
  "type_into",
  "extract_content",
  "take_screenshot",
  "close_browser",

  // Background task management — system level
  "create_background_task",
  "list_background_tasks",
  "get_task_details",
  "cancel_background_task",
  "update_task_priority",
  "pause_resume_task",

  // eBay — business operations
  "create_ebay_listing",
  "upload_ebay_image",
  "search_ebay_category",
  "generate_listing_content",
  "get_ebay_listing_status",
  "get_seller_listings",
  "update_ebay_listing",
  "bulk_update_prices",

  // Batch lister — business operations
  "batch_list_posters",
  "batch_list_status",
  "review_batch_samples",
  "approve_batch",

  // Marketplace — business operations
  "marketplace_list_platforms",
  "marketplace_test_connection",
  "marketplace_get_orders",
  "marketplace_get_order",
  "marketplace_ship_order",
  "marketplace_get_messages",
  "marketplace_send_message",
  "marketplace_order_summary",
  "marketplace_get_unshipped",
  "marketplace_bulk_ship",

  // Standing rules — business monitoring
  "create_standing_rule",
  "list_standing_rules",
  "update_standing_rule",
  "remove_standing_rule",

  // Invoices — financial documents
  "create_invoice",
  "list_invoices",
  "get_invoice",

  // Google Calendar — write access blocked
  "list_google_calendars",
  "create_google_event",
  "update_google_event",
  "delete_google_event",

  // File organizer — filesystem access
  "scan_folder",
  "organize_files",
  "find_duplicates",

  // MCP management — system level, owner only
  "mcp_add_server",
  "mcp_remove_server",
  "mcp_list_servers",
  "mcp_list_tools",
  "mcp_reconnect",
  "mcp_toggle_server",

  // Analytics — contains owner conversation history and task data
  "search_history",
  "get_tool_stats",
  "get_event_log",
  "search_tasks",
  "get_task_audit",

  // A2A client tools — prevent recursive forwarding
  "discover_agent",
  "send_to_agent",
  "list_peers",
  "get_peer_details",
  "set_peer_trust",
  "remove_peer",
  "a2a_audit_log",
  "approve_a2a_request",
]);

// ─── DATA: Personal/business data, Trusted tier only ────────────────
// These tools are safe to execute but return owner's personal data

const DATA_TOOLS = new Set([
  // Calendar — read-only
  "list_events",
  "list_google_events",
  "get_google_event",

  // Contacts — read-only
  "search_contacts",
  "get_contact",
  "list_contacts",

  // Inventory — business data
  "search_inventory",
  "get_inventory_stats",

  // Quick capture — personal notes
  "list_captures",
  "search_captures",

  // Expenses — financial data
  "list_expenses",
  "get_expense_summary",

  // Reminders — personal data
  "list_reminders",
]);

// ─── SAFE: Available to any authenticated peer ──────────────────────
// Everything NOT in BLOCKED or DATA
// These tools do NOT expose personal data and are safe for any peer.

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Returns tool definitions available for the given trust tier.
 * - manual/budget-capped: SAFE tools only
 * - trusted: SAFE + DATA tools
 * - blocked: empty (shouldn't be called, but safe)
 */
export function getPublicToolDefinitions(trustTier: TrustTier): ToolDefinition[] {
  if (trustTier === "blocked") return [];

  return toolDefinitions.filter((tool) => {
    if (BLOCKED_TOOLS.has(tool.name)) return false;
    if (DATA_TOOLS.has(tool.name) && trustTier !== "trusted") return false;
    return true;
  });
}

/**
 * Check if a specific tool is allowed for the given trust tier.
 */
export function isPublicTool(name: string, trustTier: TrustTier): boolean {
  if (trustTier === "blocked") return false;
  if (BLOCKED_TOOLS.has(name)) return false;
  if (DATA_TOOLS.has(name) && trustTier !== "trusted") return false;
  // Block MCP tools — they spawn subprocesses, bypass Bob's sandbox
  if (isMcpTool(name)) return false;
  return true;
}

/**
 * Get all SAFE tool names (for Agent Card — advertised to everyone).
 */
export function getSafeToolNames(): string[] {
  return toolDefinitions
    .filter((t) => !BLOCKED_TOOLS.has(t.name) && !DATA_TOOLS.has(t.name))
    .map((t) => t.name);
}

/**
 * Build Agent Card skills from SAFE tools only.
 * DATA tools are not advertised — peers discover them after trust upgrade.
 */
export function buildAgentCardSkills(): AgentCardSkill[] {
  return toolDefinitions
    .filter((t) => !BLOCKED_TOOLS.has(t.name) && !DATA_TOOLS.has(t.name))
    .map((t) => ({
      id: t.name,
      name: t.name,
      description: t.description ?? "",
    }));
}
