/**
 * Standing Rules — Persistent monitoring rules checked hourly by the scheduler.
 *
 * Rule types:
 *   - unshipped_orders: Alert if orders older than N hours haven't shipped
 *   - unread_messages: Alert if there are unread buyer messages
 *   - new_orders: Alert when new orders arrive (tracks baseline)
 *   - daily_summary: Daily sales digest at a configured hour
 *
 * Notifications go via Telegram by default, with optional escalation to SMS/call.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";
import type { NotifyChannel } from "../tasks/types.js";
import { getConfiguredAdapters } from "../marketplace/registry.js";
import { createEscalation } from "../tasks/escalation.js";
import { config } from "../config.js";
import { memory } from "../agent/memory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolResult {
  success: boolean;
  output: string;
}

type StandingRuleType = "unshipped_orders" | "unread_messages" | "new_orders" | "daily_summary";

interface StandingRule {
  id: string;
  name: string;
  type: StandingRuleType;
  enabled: boolean;
  params: {
    threshold_hours?: number;   // unshipped_orders: hours before alerting (default 24)
    platforms?: string[];       // filter to specific marketplaces, or all configured
    summary_hour?: number;      // daily_summary: hour of day to send (default 9)
  };
  notifyChannels: NotifyChannel[];
  escalateAfterMin?: number;    // if set + multiple channels, creates escalation chain
  lastChecked: string | null;
  lastTriggered: string | null;
  triggerCount: number;
  lastSeenOrderIds?: string[];  // new_orders: baseline tracking
  createdAt: string;
}

interface StandingRulesFile {
  version: number;
  rules: StandingRule[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const RULES_PATH = resolve("memory", "standing-rules.json");

let rules: StandingRule[] = [];
let initialized = false;

/**
 * Load rules from disk. Called once at startup via initStandingRules().
 * After init, all handlers work with the in-memory array and save on mutation.
 */
async function loadRules(): Promise<void> {
  try {
    const raw = await readFile(RULES_PATH, "utf-8");
    const data = JSON.parse(raw) as StandingRulesFile;
    rules = data.rules ?? [];
  } catch {
    rules = [];
  }
  initialized = true;
}

async function saveRules(): Promise<void> {
  await mkdir(resolve("memory"), { recursive: true });
  const data: StandingRulesFile = { version: 1, rules };
  await writeFile(RULES_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** Initialize standing rules — load from disk once at startup. */
export async function initStandingRules(): Promise<void> {
  await ensureLoaded();
  if (rules.length > 0) {
    console.log(`[standing-rules] Loaded ${rules.length} rules from disk`);
  }
}

/** Ensure rules are loaded (fallback if init wasn't called). */
async function ensureLoaded(): Promise<void> {
  if (!initialized) await loadRules();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const standingRulesToolDefinitions: ToolDefinition[] = [
  {
    name: "create_standing_rule",
    description:
      "Create a persistent monitoring rule that Bob checks hourly. Rule types:\n" +
      "- unshipped_orders: Alert when orders older than threshold_hours haven't shipped\n" +
      "- unread_messages: Alert when there are unread buyer messages\n" +
      "- new_orders: Alert when new orders arrive (tracks a baseline so it only fires for genuinely new ones)\n" +
      "- daily_summary: Daily sales digest at a specific hour\n\n" +
      "Rules check all configured marketplace platforms by default (eBay, Etsy, etc.).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Human-readable name (e.g. 'Alert on unshipped orders')",
        },
        type: {
          type: "string",
          enum: ["unshipped_orders", "unread_messages", "new_orders", "daily_summary"],
          description: "What to monitor",
        },
        threshold_hours: {
          type: "number",
          description: "For unshipped_orders: hours before alerting (default: 24)",
        },
        platforms: {
          type: "array",
          items: { type: "string" },
          description: "Specific platforms to monitor (e.g. ['ebay']). Omit for all configured platforms.",
        },
        summary_hour: {
          type: "number",
          description: "For daily_summary: hour of day to send (0-23, default: 9)",
        },
        notify_channels: {
          type: "array",
          items: { type: "string", enum: ["telegram", "sms", "call"] },
          description: "Notification channels in order (default: ['telegram'])",
        },
        escalate_after_min: {
          type: "number",
          description: "Minutes between escalation steps when using multiple channels (e.g. 15 = Telegram first, SMS after 15min)",
        },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "list_standing_rules",
    description:
      "List all standing monitoring rules with their current status, last triggered time, and trigger count.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "update_standing_rule",
    description:
      "Update a standing rule — change its parameters, enable/disable it, or modify notification channels.",
    input_schema: {
      type: "object" as const,
      properties: {
        rule_id: {
          type: "string",
          description: "The rule ID to update",
        },
        enabled: {
          type: "boolean",
          description: "Enable or disable the rule",
        },
        name: {
          type: "string",
          description: "New name for the rule",
        },
        threshold_hours: {
          type: "number",
          description: "New threshold (for unshipped_orders)",
        },
        platforms: {
          type: "array",
          items: { type: "string" },
          description: "New platform filter",
        },
        summary_hour: {
          type: "number",
          description: "New summary hour (for daily_summary)",
        },
        notify_channels: {
          type: "array",
          items: { type: "string", enum: ["telegram", "sms", "call"] },
          description: "New notification channels",
        },
        escalate_after_min: {
          type: "number",
          description: "New escalation delay in minutes",
        },
      },
      required: ["rule_id"],
    },
  },
  {
    name: "remove_standing_rule",
    description: "Delete a standing monitoring rule.",
    input_schema: {
      type: "object" as const,
      properties: {
        rule_id: {
          type: "string",
          description: "The rule ID to remove",
        },
      },
      required: ["rule_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleCreateStandingRule(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  await ensureLoaded();

  const name = input.name as string;
  const type = input.type as StandingRuleType;

  if (!name || !type) {
    return { success: false, output: "name and type are required." };
  }

  const validTypes: StandingRuleType[] = ["unshipped_orders", "unread_messages", "new_orders", "daily_summary"];
  if (!validTypes.includes(type)) {
    return { success: false, output: `Invalid type. Must be one of: ${validTypes.join(", ")}` };
  }

  const channels = (input.notify_channels as NotifyChannel[] | undefined) ?? ["telegram"];
  const escalateAfterMin = input.escalate_after_min as number | undefined;

  const rule: StandingRule = {
    id: randomUUID().slice(0, 8),
    name,
    type,
    enabled: true,
    params: {
      threshold_hours: (input.threshold_hours as number | undefined) ?? (type === "unshipped_orders" ? 24 : undefined),
      platforms: input.platforms as string[] | undefined,
      summary_hour: (input.summary_hour as number | undefined) ?? (type === "daily_summary" ? 9 : undefined),
    },
    notifyChannels: channels,
    escalateAfterMin: escalateAfterMin,
    lastChecked: null,
    lastTriggered: null,
    triggerCount: 0,
    lastSeenOrderIds: type === "new_orders" ? [] : undefined,
    createdAt: new Date().toISOString(),
  };

  rules.push(rule);
  await saveRules();

  const parts = [`Created standing rule "${name}" (${rule.id})`];
  parts.push(`Type: ${type}`);
  parts.push(`Notify via: ${channels.join(" → ")}`);
  if (type === "unshipped_orders") parts.push(`Threshold: ${rule.params.threshold_hours}h`);
  if (type === "daily_summary") parts.push(`Summary hour: ${rule.params.summary_hour}:00`);
  if (rule.params.platforms) parts.push(`Platforms: ${rule.params.platforms.join(", ")}`);
  if (escalateAfterMin) parts.push(`Escalation delay: ${escalateAfterMin}min between channels`);

  return { success: true, output: parts.join("\n") };
}

export async function handleListStandingRules(): Promise<ToolResult> {
  await ensureLoaded();

  if (rules.length === 0) {
    return {
      success: true,
      output: "No standing rules configured.\n\nUse create_standing_rule to set up marketplace monitoring.",
    };
  }

  const lines = rules.map((r) => {
    const status = r.enabled ? "ACTIVE" : "PAUSED";
    const lastTriggered = r.lastTriggered
      ? new Date(r.lastTriggered).toLocaleString()
      : "never";
    const platforms = r.params.platforms?.join(", ") || "all configured";
    const channels = r.notifyChannels.join(" → ");

    let detail = "";
    if (r.type === "unshipped_orders") detail = `threshold: ${r.params.threshold_hours ?? 24}h`;
    if (r.type === "daily_summary") detail = `at ${r.params.summary_hour ?? 9}:00`;

    return (
      `[${status}] ${r.name} (${r.id})\n` +
      `  Type: ${r.type}${detail ? ` — ${detail}` : ""}\n` +
      `  Platforms: ${platforms}\n` +
      `  Notify: ${channels}\n` +
      `  Triggered: ${r.triggerCount}x (last: ${lastTriggered})`
    );
  });

  return { success: true, output: lines.join("\n\n") };
}

export async function handleUpdateStandingRule(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  await ensureLoaded();

  const ruleId = input.rule_id as string;
  if (!ruleId) return { success: false, output: "rule_id is required." };

  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return { success: false, output: `Rule "${ruleId}" not found.` };

  const changes: string[] = [];

  if (input.enabled !== undefined) {
    rule.enabled = input.enabled as boolean;
    changes.push(`enabled: ${rule.enabled}`);
  }
  if (input.name !== undefined) {
    rule.name = input.name as string;
    changes.push(`name: ${rule.name}`);
  }
  if (input.threshold_hours !== undefined) {
    rule.params.threshold_hours = input.threshold_hours as number;
    changes.push(`threshold_hours: ${rule.params.threshold_hours}`);
  }
  if (input.platforms !== undefined) {
    rule.params.platforms = input.platforms as string[];
    changes.push(`platforms: ${rule.params.platforms.join(", ")}`);
  }
  if (input.summary_hour !== undefined) {
    rule.params.summary_hour = input.summary_hour as number;
    changes.push(`summary_hour: ${rule.params.summary_hour}`);
  }
  if (input.notify_channels !== undefined) {
    rule.notifyChannels = input.notify_channels as NotifyChannel[];
    changes.push(`notify_channels: ${rule.notifyChannels.join(" → ")}`);
  }
  if (input.escalate_after_min !== undefined) {
    rule.escalateAfterMin = input.escalate_after_min as number;
    changes.push(`escalate_after_min: ${rule.escalateAfterMin}`);
  }

  if (changes.length === 0) {
    return { success: false, output: "No changes specified." };
  }

  await saveRules();
  return { success: true, output: `Updated rule "${rule.name}" (${rule.id}):\n${changes.join("\n")}` };
}

export async function handleRemoveStandingRule(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  await ensureLoaded();

  const ruleId = input.rule_id as string;
  if (!ruleId) return { success: false, output: "rule_id is required." };

  const idx = rules.findIndex((r) => r.id === ruleId);
  if (idx === -1) return { success: false, output: `Rule "${ruleId}" not found.` };

  const removed = rules.splice(idx, 1)[0];
  await saveRules();

  return { success: true, output: `Removed standing rule "${removed.name}" (${removed.id}).` };
}

// ---------------------------------------------------------------------------
// Rule checkers — called by checkStandingRules()
// ---------------------------------------------------------------------------

async function checkUnshippedOrders(rule: StandingRule): Promise<string | null> {
  const adapters = getConfiguredAdapters();
  if (adapters.length === 0) return null;

  const thresholdHours = rule.params.threshold_hours ?? 24;
  const cutoff = Date.now() - thresholdHours * 60 * 60 * 1000;
  const stale: string[] = [];

  for (const adapter of adapters) {
    if (rule.params.platforms && !rule.params.platforms.includes(adapter.platform)) continue;

    try {
      const orders = await adapter.getOrders({ status: "paid" });
      for (const order of orders) {
        const createdAt = new Date(order.createdAt).getTime();
        if (createdAt < cutoff) {
          const hoursAgo = Math.round((Date.now() - createdAt) / (60 * 60 * 1000));
          const itemSummary = order.items.map((i) => i.title).join(", ");
          stale.push(`${adapter.displayName} #${order.id}: ${itemSummary} (${hoursAgo}h ago)`);
        }
      }
    } catch (err) {
      console.error(`[standing-rules] Error checking unshipped on ${adapter.platform}:`, err);
    }
  }

  if (stale.length === 0) return null;

  return (
    `${stale.length} unshipped order${stale.length > 1 ? "s" : ""} older than ${thresholdHours}h:\n` +
    stale.map((s) => `  • ${s}`).join("\n")
  );
}

async function checkUnreadMessages(rule: StandingRule): Promise<string | null> {
  const adapters = getConfiguredAdapters();
  if (adapters.length === 0) return null;

  const unread: string[] = [];

  for (const adapter of adapters) {
    if (rule.params.platforms && !rule.params.platforms.includes(adapter.platform)) continue;

    try {
      const messages = await adapter.getMessages({ unreadOnly: true });
      for (const msg of messages) {
        unread.push(`${adapter.displayName}: ${msg.sender} — "${msg.body.slice(0, 80)}${msg.body.length > 80 ? "..." : ""}"`);
      }
    } catch (err) {
      console.error(`[standing-rules] Error checking messages on ${adapter.platform}:`, err);
    }
  }

  if (unread.length === 0) return null;

  return (
    `${unread.length} unread buyer message${unread.length > 1 ? "s" : ""}:\n` +
    unread.map((u) => `  • ${u}`).join("\n")
  );
}

async function checkNewOrders(rule: StandingRule): Promise<string | null> {
  const adapters = getConfiguredAdapters();
  if (adapters.length === 0) return null;

  const baseline = new Set(rule.lastSeenOrderIds ?? []);
  const allOrderIds: string[] = [];
  const newOrders: string[] = [];

  for (const adapter of adapters) {
    if (rule.params.platforms && !rule.params.platforms.includes(adapter.platform)) continue;

    try {
      const orders = await adapter.getOrders({ daysBack: 7, limit: 50 });
      for (const order of orders) {
        const key = `${adapter.platform}:${order.id}`;
        allOrderIds.push(key);

        if (!baseline.has(key)) {
          const itemSummary = order.items.map((i) => i.title).join(", ");
          const total = `${order.total.currency} ${order.total.amount.toFixed(2)}`;
          newOrders.push(`${adapter.displayName}: ${itemSummary} — ${total}`);
        }
      }
    } catch (err) {
      console.error(`[standing-rules] Error checking new orders on ${adapter.platform}:`, err);
    }
  }

  // Update baseline — cap at 200 entries
  rule.lastSeenOrderIds = allOrderIds.slice(0, 200);

  // First run: establish baseline without alerting
  if (baseline.size === 0 && newOrders.length > 0) {
    return null;
  }

  if (newOrders.length === 0) return null;

  return (
    `${newOrders.length} new order${newOrders.length > 1 ? "s" : ""}:\n` +
    newOrders.map((o) => `  • ${o}`).join("\n")
  );
}

async function checkDailySummary(rule: StandingRule): Promise<string | null> {
  const targetHour = rule.params.summary_hour ?? 9;
  const now = new Date();
  const currentHour = now.getHours();

  // Only fire at the target hour
  if (currentHour !== targetHour) return null;

  // Don't fire twice in the same day
  if (rule.lastTriggered) {
    const lastDate = new Date(rule.lastTriggered);
    if (
      lastDate.getFullYear() === now.getFullYear() &&
      lastDate.getMonth() === now.getMonth() &&
      lastDate.getDate() === now.getDate()
    ) {
      return null;
    }
  }

  const adapters = getConfiguredAdapters();
  if (adapters.length === 0) return null;

  let totalOrders = 0;
  let totalRevenue = 0;
  let currency = "USD";
  let unshippedCount = 0;
  const byPlatform: string[] = [];

  for (const adapter of adapters) {
    if (rule.params.platforms && !rule.params.platforms.includes(adapter.platform)) continue;

    try {
      const orders = await adapter.getOrders({ daysBack: 1 });
      const revenue = orders.reduce((sum, o) => sum + o.total.amount, 0);
      if (orders.length > 0) currency = orders[0].total.currency;
      const unshipped = orders.filter((o) => o.status === "paid").length;

      totalOrders += orders.length;
      totalRevenue += revenue;
      unshippedCount += unshipped;

      if (orders.length > 0) {
        byPlatform.push(
          `${adapter.displayName}: ${orders.length} order${orders.length > 1 ? "s" : ""}, ` +
          `${currency} ${revenue.toFixed(2)} revenue` +
          (unshipped > 0 ? `, ${unshipped} awaiting shipment` : "")
        );
      }
    } catch (err) {
      console.error(`[standing-rules] Error building summary for ${adapter.platform}:`, err);
      byPlatform.push(`${adapter.displayName}: error fetching data`);
    }
  }

  if (totalOrders === 0 && byPlatform.length === 0) {
    return `Daily sales summary: No orders in the last 24 hours across configured platforms.`;
  }

  const parts = [`Daily sales summary (last 24h):`];
  parts.push(`  Total orders: ${totalOrders}`);
  parts.push(`  Total revenue: ${currency} ${totalRevenue.toFixed(2)}`);
  if (unshippedCount > 0) parts.push(`  Awaiting shipment: ${unshippedCount}`);
  if (byPlatform.length > 0) {
    parts.push("");
    parts.push(...byPlatform.map((p) => `  ${p}`));
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Scheduler integration — called hourly by runAllChecks()
// ---------------------------------------------------------------------------

async function getOwnerChatId(): Promise<number | null> {
  const profile = await memory.loadProfile(config.owner.userId);
  if (!profile || profile.chatId === 0) return null;
  return profile.chatId;
}

/**
 * Check all enabled standing rules.
 * Returns alert messages for rules that triggered (scheduler sends them).
 */
export async function checkStandingRules(): Promise<string[]> {
  await ensureLoaded();

  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0) return [];

  const alerts: string[] = [];
  let changed = false;

  for (const rule of enabled) {
    let alertMsg: string | null = null;

    try {
      switch (rule.type) {
        case "unshipped_orders":
          alertMsg = await checkUnshippedOrders(rule);
          break;
        case "unread_messages":
          alertMsg = await checkUnreadMessages(rule);
          break;
        case "new_orders":
          alertMsg = await checkNewOrders(rule);
          break;
        case "daily_summary":
          alertMsg = await checkDailySummary(rule);
          break;
      }
    } catch (err) {
      console.error(`[standing-rules] Error checking rule "${rule.name}":`, err);
    }

    rule.lastChecked = new Date().toISOString();
    changed = true;

    if (alertMsg) {
      rule.lastTriggered = new Date().toISOString();
      rule.triggerCount++;

      // If multi-channel with escalation, create an escalation chain
      if (rule.notifyChannels.length > 1 && rule.escalateAfterMin) {
        const chatId = await getOwnerChatId();
        if (chatId) {
          await createEscalation({
            triggerType: `standing_rule_${rule.type}`,
            triggerRef: rule.id,
            description: alertMsg.split("\n")[0],
            notifyChannels: rule.notifyChannels,
            escalateAfterMin: rule.escalateAfterMin,
            userId: config.owner.userId,
            chatId,
            context: { findings: alertMsg },
          });
        }
      } else {
        // Single channel — scheduler will send via Telegram
        alerts.push(`[${rule.name}] ${alertMsg}`);
      }
    }
  }

  if (changed) await saveRules();

  return alerts;
}
