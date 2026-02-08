/**
 * Standing Rules — Persistent monitoring rules checked hourly by the scheduler.
 *
 * Rule types:
 *   - unshipped_orders: Alert if orders older than N hours haven't shipped
 *   - unread_messages: Alert if there are unread buyer messages
 *   - new_orders: Alert when new orders arrive (tracks baseline)
 *   - daily_summary: Daily sales digest at a configured hour
 *   - weekly_insights: Weekly digest with trends, patterns, and suggestions
 *
 * Phase 3 additions: trigger history tracking, per-alert insights, weekly digest.
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

type StandingRuleType = "unshipped_orders" | "unread_messages" | "new_orders" | "daily_summary" | "weekly_insights";

interface TriggerEvent {
  timestamp: string;
  summary: string;
  data?: {
    orderCount?: number;
    revenue?: number;
    currency?: string;
    unshippedCount?: number;
    messageCount?: number;
    platforms?: string[];
    avgHoursToShip?: number;
  };
}

interface CheckerResult {
  alert: string;
  data?: TriggerEvent["data"];
}

interface StandingRule {
  id: string;
  name: string;
  type: StandingRuleType;
  enabled: boolean;
  params: {
    threshold_hours?: number;
    platforms?: string[];
    summary_hour?: number;
  };
  notifyChannels: NotifyChannel[];
  escalateAfterMin?: number;
  lastChecked: string | null;
  lastTriggered: string | null;
  triggerCount: number;
  lastSeenOrderIds?: string[];
  triggerHistory?: TriggerEvent[];
  insightsDigestDay?: number;       // 0=Sun..6=Sat (default 1=Mon)
  createdAt: string;
}

interface StandingRulesFile {
  version: number;
  rules: StandingRule[];
}

const CURRENT_VERSION = 2;
const MAX_HISTORY = 90;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const RULES_PATH = resolve("memory", "standing-rules.json");

let rules: StandingRule[] = [];
let initialized = false;

async function loadRules(): Promise<void> {
  try {
    const raw = await readFile(RULES_PATH, "utf-8");
    const data = JSON.parse(raw) as StandingRulesFile;
    rules = data.rules ?? [];

    // Version migration: v1 → v2 (add triggerHistory)
    if ((data.version ?? 1) < CURRENT_VERSION) {
      for (const rule of rules) {
        if (!rule.triggerHistory) rule.triggerHistory = [];
      }
      await saveRules();
    }
  } catch {
    rules = [];
  }
  initialized = true;
}

async function saveRules(): Promise<void> {
  await mkdir(resolve("memory"), { recursive: true });
  const data: StandingRulesFile = { version: CURRENT_VERSION, rules };
  await writeFile(RULES_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export async function initStandingRules(): Promise<void> {
  await ensureLoaded();
  if (rules.length > 0) {
    console.log(`[standing-rules] Loaded ${rules.length} rules from disk`);
  }
}

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
      "- daily_summary: Daily sales digest at a specific hour\n" +
      "- weekly_insights: Weekly digest with trends, patterns, and actionable suggestions (configurable day)\n\n" +
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
          enum: ["unshipped_orders", "unread_messages", "new_orders", "daily_summary", "weekly_insights"],
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
          description: "For daily_summary/weekly_insights: hour of day to send (0-23, default: 9)",
        },
        insights_digest_day: {
          type: "number",
          description: "For weekly_insights: day of week (0=Sunday, 1=Monday, ..., 6=Saturday, default: 1=Monday)",
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
      "List all standing monitoring rules with their current status, last triggered time, trigger count, and history depth.",
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
          description: "New summary hour (for daily_summary/weekly_insights)",
        },
        insights_digest_day: {
          type: "number",
          description: "New digest day (for weekly_insights, 0-6)",
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

  const validTypes: StandingRuleType[] = ["unshipped_orders", "unread_messages", "new_orders", "daily_summary", "weekly_insights"];
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
      summary_hour: (input.summary_hour as number | undefined) ??
        (type === "daily_summary" || type === "weekly_insights" ? 9 : undefined),
    },
    notifyChannels: channels,
    escalateAfterMin: escalateAfterMin,
    lastChecked: null,
    lastTriggered: null,
    triggerCount: 0,
    lastSeenOrderIds: type === "new_orders" ? [] : undefined,
    triggerHistory: [],
    insightsDigestDay: type === "weekly_insights"
      ? (input.insights_digest_day as number | undefined) ?? 1
      : undefined,
    createdAt: new Date().toISOString(),
  };

  rules.push(rule);
  await saveRules();

  const parts = [`Created standing rule "${name}" (${rule.id})`];
  parts.push(`Type: ${type}`);
  parts.push(`Notify via: ${channels.join(" → ")}`);
  if (type === "unshipped_orders") parts.push(`Threshold: ${rule.params.threshold_hours}h`);
  if (type === "daily_summary") parts.push(`Summary hour: ${rule.params.summary_hour}:00`);
  if (type === "weekly_insights") {
    parts.push(`Digest: ${DAY_NAMES[rule.insightsDigestDay ?? 1]}s at ${rule.params.summary_hour ?? 9}:00`);
  }
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
    const historyCount = r.triggerHistory?.length ?? 0;

    let detail = "";
    if (r.type === "unshipped_orders") detail = `threshold: ${r.params.threshold_hours ?? 24}h`;
    if (r.type === "daily_summary") detail = `at ${r.params.summary_hour ?? 9}:00`;
    if (r.type === "weekly_insights") detail = `${DAY_NAMES[r.insightsDigestDay ?? 1]}s at ${r.params.summary_hour ?? 9}:00`;

    return (
      `[${status}] ${r.name} (${r.id})\n` +
      `  Type: ${r.type}${detail ? ` — ${detail}` : ""}\n` +
      `  Platforms: ${platforms}\n` +
      `  Notify: ${channels}\n` +
      `  Triggered: ${r.triggerCount}x (last: ${lastTriggered})\n` +
      `  History: ${historyCount} events`
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
  if (input.insights_digest_day !== undefined) {
    rule.insightsDigestDay = input.insights_digest_day as number;
    changes.push(`insights_digest_day: ${DAY_NAMES[rule.insightsDigestDay]}`);
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
// Insight detectors — pure functions that analyze trigger history
// ---------------------------------------------------------------------------

function insightFrequency(history: TriggerEvent[]): string | null {
  if (history.length < 5) return null;

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentTriggers = history.filter((e) => new Date(e.timestamp).getTime() > sevenDaysAgo);

  // Count unique days with triggers
  const days = new Set(recentTriggers.map((e) => new Date(e.timestamp).toDateString()));
  if (days.size >= 5) {
    return `Triggered ${days.size} of the last 7 days — consider adjusting the threshold.`;
  }
  return null;
}

function insightDayOfWeekPattern(history: TriggerEvent[]): string | null {
  if (history.length < 7) return null;

  const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat
  for (const event of history) {
    dayCounts[new Date(event.timestamp).getDay()]++;
  }

  const weekendTotal = dayCounts[0] + dayCounts[6];
  const weekdayTotal = dayCounts.slice(1, 6).reduce((a, b) => a + b, 0);
  const weekdayAvg = weekdayTotal / 5;
  const weekendAvg = weekendTotal / 2;

  if (weekendAvg > 0 && weekendAvg > weekdayAvg * 2) {
    return "Fulfillment tends to fall behind on weekends.";
  }
  return null;
}

function insightWeekOverWeek(history: TriggerEvent[]): string | null {
  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;

  const thisWeek = history.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return t > oneWeekAgo;
  });
  const lastWeek = history.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return t > twoWeeksAgo && t <= oneWeekAgo;
  });

  if (lastWeek.length === 0) return null;

  // Compare revenue if available
  const thisRevenue = thisWeek.reduce((s, e) => s + (e.data?.revenue ?? 0), 0);
  const lastRevenue = lastWeek.reduce((s, e) => s + (e.data?.revenue ?? 0), 0);

  if (thisRevenue > 0 && lastRevenue > 0) {
    const pctChange = Math.round(((thisRevenue - lastRevenue) / lastRevenue) * 100);
    const currency = thisWeek.find((e) => e.data?.currency)?.data?.currency ?? "USD";
    if (Math.abs(pctChange) >= 10) {
      const direction = pctChange > 0 ? "up" : "down";
      return `Revenue ${direction} ${Math.abs(pctChange)}% vs last week (${currency} ${thisRevenue.toFixed(0)} vs ${lastRevenue.toFixed(0)}).`;
    }
  }

  // Compare order count
  const thisOrders = thisWeek.reduce((s, e) => s + (e.data?.orderCount ?? 0), 0);
  const lastOrders = lastWeek.reduce((s, e) => s + (e.data?.orderCount ?? 0), 0);

  if (thisOrders > 0 && lastOrders > 0) {
    const pctChange = Math.round(((thisOrders - lastOrders) / lastOrders) * 100);
    if (Math.abs(pctChange) >= 15) {
      const direction = pctChange > 0 ? "up" : "down";
      return `Order volume ${direction} ${Math.abs(pctChange)}% vs last week.`;
    }
  }

  return null;
}

function insightAvgTimeToShip(history: TriggerEvent[]): string | null {
  const recent = history.slice(-10);
  const shipTimes = recent
    .map((e) => e.data?.avgHoursToShip)
    .filter((h): h is number => h !== undefined);

  if (shipTimes.length < 3) return null;

  const avg = Math.round(shipTimes.reduce((a, b) => a + b, 0) / shipTimes.length);
  return `Average unshipped order age: ${avg}h.`;
}

function insightThresholdTuning(rule: StandingRule): string | null {
  const history = rule.triggerHistory ?? [];
  if (history.length < 10) return null;

  const recent = history.slice(-10);
  const allSingle = recent.every((e) => (e.data?.orderCount ?? 0) <= 1);

  if (allSingle) {
    return "Most recent triggers are for single items — threshold may be too sensitive.";
  }
  return null;
}

function generateInsights(rule: StandingRule, _event: TriggerEvent): string | null {
  const history = rule.triggerHistory ?? [];
  if (history.length < 3) return null;

  const insights: string[] = [];

  const freq = insightFrequency(history);
  if (freq) insights.push(freq);

  if (rule.type === "unshipped_orders") {
    const dow = insightDayOfWeekPattern(history);
    if (dow) insights.push(dow);
    const ship = insightAvgTimeToShip(history);
    if (ship) insights.push(ship);
    const thresh = insightThresholdTuning(rule);
    if (thresh) insights.push(thresh);
  }

  if (rule.type === "new_orders" || rule.type === "daily_summary") {
    const wow = insightWeekOverWeek(history);
    if (wow) insights.push(wow);
  }

  if (insights.length === 0) return null;
  return insights.map((i) => `  • ${i}`).join("\n");
}

// ---------------------------------------------------------------------------
// Rule checkers — return CheckerResult | null
// ---------------------------------------------------------------------------

async function checkUnshippedOrders(rule: StandingRule): Promise<CheckerResult | null> {
  const adapters = getConfiguredAdapters();
  if (adapters.length === 0) return null;

  const thresholdHours = rule.params.threshold_hours ?? 24;
  const cutoff = Date.now() - thresholdHours * 60 * 60 * 1000;
  const stale: string[] = [];
  const platforms: string[] = [];
  let totalHours = 0;

  for (const adapter of adapters) {
    if (rule.params.platforms && !rule.params.platforms.includes(adapter.platform)) continue;

    try {
      const orders = await adapter.getOrders({ status: "paid" });
      for (const order of orders) {
        const createdAt = new Date(order.createdAt).getTime();
        if (createdAt < cutoff) {
          const hoursAgo = Math.round((Date.now() - createdAt) / (60 * 60 * 1000));
          totalHours += hoursAgo;
          const itemSummary = order.items.map((i) => i.title).join(", ");
          stale.push(`${adapter.displayName} #${order.id}: ${itemSummary} (${hoursAgo}h ago)`);
          if (!platforms.includes(adapter.platform)) platforms.push(adapter.platform);
        }
      }
    } catch (err) {
      console.error(`[standing-rules] Error checking unshipped on ${adapter.platform}:`, err);
    }
  }

  if (stale.length === 0) return null;

  return {
    alert:
      `${stale.length} unshipped order${stale.length > 1 ? "s" : ""} older than ${thresholdHours}h:\n` +
      stale.map((s) => `  • ${s}`).join("\n"),
    data: {
      orderCount: stale.length,
      unshippedCount: stale.length,
      avgHoursToShip: Math.round(totalHours / stale.length),
      platforms,
    },
  };
}

async function checkUnreadMessages(rule: StandingRule): Promise<CheckerResult | null> {
  const adapters = getConfiguredAdapters();
  if (adapters.length === 0) return null;

  const unread: string[] = [];
  const platforms: string[] = [];

  for (const adapter of adapters) {
    if (rule.params.platforms && !rule.params.platforms.includes(adapter.platform)) continue;

    try {
      const messages = await adapter.getMessages({ unreadOnly: true });
      for (const msg of messages) {
        unread.push(`${adapter.displayName}: ${msg.sender} — "${msg.body.slice(0, 80)}${msg.body.length > 80 ? "..." : ""}"`);
        if (!platforms.includes(adapter.platform)) platforms.push(adapter.platform);
      }
    } catch (err) {
      console.error(`[standing-rules] Error checking messages on ${adapter.platform}:`, err);
    }
  }

  if (unread.length === 0) return null;

  return {
    alert:
      `${unread.length} unread buyer message${unread.length > 1 ? "s" : ""}:\n` +
      unread.map((u) => `  • ${u}`).join("\n"),
    data: {
      messageCount: unread.length,
      platforms,
    },
  };
}

async function checkNewOrders(rule: StandingRule): Promise<CheckerResult | null> {
  const adapters = getConfiguredAdapters();
  if (adapters.length === 0) return null;

  const baseline = new Set(rule.lastSeenOrderIds ?? []);
  const allOrderIds: string[] = [];
  const newOrders: string[] = [];
  const platforms: string[] = [];
  let totalRevenue = 0;
  let currency = "USD";

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
          totalRevenue += order.total.amount;
          currency = order.total.currency;
          if (!platforms.includes(adapter.platform)) platforms.push(adapter.platform);
        }
      }
    } catch (err) {
      console.error(`[standing-rules] Error checking new orders on ${adapter.platform}:`, err);
    }
  }

  rule.lastSeenOrderIds = allOrderIds.slice(0, 200);

  if (baseline.size === 0 && newOrders.length > 0) {
    return null; // First run: establish baseline
  }

  if (newOrders.length === 0) return null;

  return {
    alert:
      `${newOrders.length} new order${newOrders.length > 1 ? "s" : ""}:\n` +
      newOrders.map((o) => `  • ${o}`).join("\n"),
    data: {
      orderCount: newOrders.length,
      revenue: totalRevenue,
      currency,
      platforms,
    },
  };
}

async function checkDailySummary(rule: StandingRule): Promise<CheckerResult | null> {
  const targetHour = rule.params.summary_hour ?? 9;
  const now = new Date();

  if (now.getHours() !== targetHour) return null;
  if (sameDate(rule.lastTriggered, now)) return null;

  const adapters = getConfiguredAdapters();
  if (adapters.length === 0) return null;

  let totalOrders = 0;
  let totalRevenue = 0;
  let currency = "USD";
  let unshippedCount = 0;
  const byPlatform: string[] = [];
  const platforms: string[] = [];

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
        platforms.push(adapter.platform);
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
    return {
      alert: "Daily sales summary: No orders in the last 24 hours across configured platforms.",
      data: { orderCount: 0, revenue: 0, currency },
    };
  }

  const parts = [`Daily sales summary (last 24h):`];
  parts.push(`  Total orders: ${totalOrders}`);
  parts.push(`  Total revenue: ${currency} ${totalRevenue.toFixed(2)}`);
  if (unshippedCount > 0) parts.push(`  Awaiting shipment: ${unshippedCount}`);
  if (byPlatform.length > 0) {
    parts.push("");
    parts.push(...byPlatform.map((p) => `  ${p}`));
  }

  return {
    alert: parts.join("\n"),
    data: {
      orderCount: totalOrders,
      revenue: totalRevenue,
      currency,
      unshippedCount,
      platforms,
    },
  };
}

// ---------------------------------------------------------------------------
// Weekly insights checker
// ---------------------------------------------------------------------------

async function checkWeeklyInsights(rule: StandingRule): Promise<CheckerResult | null> {
  const targetDay = rule.insightsDigestDay ?? 1; // Monday
  const targetHour = rule.params.summary_hour ?? 9;
  const now = new Date();

  if (now.getDay() !== targetDay || now.getHours() !== targetHour) return null;
  if (sameDate(rule.lastTriggered, now)) return null;

  // Aggregate trigger history from ALL enabled rules (not just this one)
  const allRules = rules.filter((r) => r.enabled && r.type !== "weekly_insights");
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

  // --- Rule activity ---
  let totalTriggersThisWeek = 0;
  let totalTriggersLastWeek = 0;
  const triggersByRule: Array<{ name: string; count: number }> = [];

  for (const r of allRules) {
    const history = r.triggerHistory ?? [];
    const thisWeek = history.filter((e) => new Date(e.timestamp).getTime() > oneWeekAgo);
    const lastWeek = history.filter((e) => {
      const t = new Date(e.timestamp).getTime();
      return t > twoWeeksAgo && t <= oneWeekAgo;
    });
    totalTriggersThisWeek += thisWeek.length;
    totalTriggersLastWeek += lastWeek.length;
    if (thisWeek.length > 0) {
      triggersByRule.push({ name: r.name, count: thisWeek.length });
    }
  }

  // --- Live marketplace data ---
  const adapters = getConfiguredAdapters();
  let weekOrders = 0;
  let weekRevenue = 0;
  let prevWeekOrders = 0;
  let prevWeekRevenue = 0;
  let currency = "USD";
  const platformBreakdown: Array<{ name: string; orders: number }> = [];

  for (const adapter of adapters) {
    if (rule.params.platforms && !rule.params.platforms.includes(adapter.platform)) continue;

    try {
      const orders7 = await adapter.getOrders({ daysBack: 7 });
      const orders14 = await adapter.getOrders({ daysBack: 14 });

      const rev7 = orders7.reduce((s, o) => s + o.total.amount, 0);
      const prevOrders = orders14.filter((o) => {
        const t = new Date(o.createdAt).getTime();
        return t <= oneWeekAgo;
      });
      const revPrev = prevOrders.reduce((s, o) => s + o.total.amount, 0);

      if (orders7.length > 0) currency = orders7[0].total.currency;
      weekOrders += orders7.length;
      weekRevenue += rev7;
      prevWeekOrders += prevOrders.length;
      prevWeekRevenue += revPrev;

      if (orders7.length > 0) {
        platformBreakdown.push({ name: adapter.displayName, orders: orders7.length });
      }
    } catch (err) {
      console.error(`[standing-rules] Weekly insights error for ${adapter.platform}:`, err);
    }
  }

  // --- Build digest ---
  const sections: string[] = [];
  const dayName = DAY_NAMES[now.getDay()];
  const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  sections.push(`Weekly Insights (${dayName} ${dateStr}):`);

  // Rule activity section
  if (totalTriggersThisWeek > 0 || totalTriggersLastWeek > 0) {
    const activityLines = [`\nRule Activity:`];
    const comparison = totalTriggersLastWeek > 0
      ? ` (vs ${totalTriggersLastWeek} last week)`
      : "";
    activityLines.push(`  ${totalTriggersThisWeek} total triggers this week${comparison}`);
    for (const tr of triggersByRule.sort((a, b) => b.count - a.count)) {
      activityLines.push(`  "${tr.name}" fired ${tr.count}x`);
    }
    sections.push(activityLines.join("\n"));
  }

  // Marketplace section
  if (weekOrders > 0 || prevWeekOrders > 0) {
    const mktLines = [`\nMarketplace:`];
    if (weekOrders > 0) {
      let revLine = `  Revenue: ${currency} ${weekRevenue.toFixed(2)} across ${weekOrders} order${weekOrders > 1 ? "s" : ""}`;
      if (prevWeekRevenue > 0) {
        const pct = Math.round(((weekRevenue - prevWeekRevenue) / prevWeekRevenue) * 100);
        revLine += ` (vs ${currency} ${prevWeekRevenue.toFixed(2)} last week, ${pct >= 0 ? "+" : ""}${pct}%)`;
      }
      mktLines.push(revLine);
      if (weekOrders > 0) {
        mktLines.push(`  Avg order value: ${currency} ${(weekRevenue / weekOrders).toFixed(2)}`);
      }
      if (platformBreakdown.length > 0) {
        mktLines.push(`  Platforms: ${platformBreakdown.map((p) => `${p.name} (${p.orders})`).join(", ")}`);
      }
    }
    sections.push(mktLines.join("\n"));
  }

  // Fulfillment section — from unshipped_orders trigger history
  const unshippedRule = allRules.find((r) => r.type === "unshipped_orders");
  if (unshippedRule) {
    const unshippedHistory = (unshippedRule.triggerHistory ?? [])
      .filter((e) => new Date(e.timestamp).getTime() > oneWeekAgo);
    if (unshippedHistory.length > 0) {
      const shipTimes = unshippedHistory
        .map((e) => e.data?.avgHoursToShip)
        .filter((h): h is number => h !== undefined);
      const fulfillLines = [`\nFulfillment:`];
      if (shipTimes.length > 0) {
        const avg = Math.round(shipTimes.reduce((a, b) => a + b, 0) / shipTimes.length);
        fulfillLines.push(`  Avg unshipped order age: ${avg}h`);
      }
      const dow = insightDayOfWeekPattern(unshippedHistory);
      if (dow) fulfillLines.push(`  ${dow}`);
      if (fulfillLines.length > 1) sections.push(fulfillLines.join("\n"));
    }
  }

  // Suggestions section
  const suggestions: string[] = [];
  for (const r of allRules) {
    const history = r.triggerHistory ?? [];
    const freq = insightFrequency(history);
    if (freq) suggestions.push(`"${r.name}": ${freq}`);
    const thresh = insightThresholdTuning(r);
    if (thresh) suggestions.push(`"${r.name}": ${thresh}`);
  }
  if (weekOrders > prevWeekOrders && prevWeekOrders > 0) {
    const pct = Math.round(((weekOrders - prevWeekOrders) / prevWeekOrders) * 100);
    if (pct >= 20) suggestions.push("Order volume trending up — consider restocking top sellers.");
  }
  if (weekOrders < prevWeekOrders && prevWeekOrders > 0) {
    const pct = Math.round(((prevWeekOrders - weekOrders) / prevWeekOrders) * 100);
    if (pct >= 20) suggestions.push("Order volume declining — consider promotional pricing or new listings.");
  }

  if (suggestions.length > 0) {
    sections.push(`\nSuggestions:\n${suggestions.map((s) => `  • ${s}`).join("\n")}`);
  }

  // If nothing to report
  if (sections.length <= 1) {
    return {
      alert: `Weekly Insights (${dayName} ${dateStr}): No marketplace activity this week.`,
      data: { orderCount: 0, revenue: 0, currency },
    };
  }

  return {
    alert: sections.join("\n"),
    data: {
      orderCount: weekOrders,
      revenue: weekRevenue,
      currency,
      platforms: platformBreakdown.map((p) => p.name),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sameDate(isoOrNull: string | null, date: Date): boolean {
  if (!isoOrNull) return false;
  const d = new Date(isoOrNull);
  return (
    d.getFullYear() === date.getFullYear() &&
    d.getMonth() === date.getMonth() &&
    d.getDate() === date.getDate()
  );
}

function recordTriggerEvent(rule: StandingRule, result: CheckerResult): void {
  if (!rule.triggerHistory) rule.triggerHistory = [];
  rule.triggerHistory.push({
    timestamp: new Date().toISOString(),
    summary: result.alert.split("\n")[0],
    data: result.data,
  });
  if (rule.triggerHistory.length > MAX_HISTORY) {
    rule.triggerHistory = rule.triggerHistory.slice(-MAX_HISTORY);
  }
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
    let result: CheckerResult | null = null;

    try {
      switch (rule.type) {
        case "unshipped_orders":
          result = await checkUnshippedOrders(rule);
          break;
        case "unread_messages":
          result = await checkUnreadMessages(rule);
          break;
        case "new_orders":
          result = await checkNewOrders(rule);
          break;
        case "daily_summary":
          result = await checkDailySummary(rule);
          break;
        case "weekly_insights":
          result = await checkWeeklyInsights(rule);
          break;
      }
    } catch (err) {
      console.error(`[standing-rules] Error checking rule "${rule.name}":`, err);
    }

    rule.lastChecked = new Date().toISOString();
    changed = true;

    if (result) {
      rule.lastTriggered = new Date().toISOString();
      rule.triggerCount++;

      // Record trigger event for history
      recordTriggerEvent(rule, result);

      // Generate insights for non-weekly rules (weekly IS the insight)
      let alertMsg = result.alert;
      if (rule.type !== "weekly_insights") {
        const insights = generateInsights(rule, {
          timestamp: new Date().toISOString(),
          summary: result.alert.split("\n")[0],
          data: result.data,
        });
        if (insights) {
          alertMsg += "\n\n--- Insights ---\n" + insights;
        }
      }

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
        alerts.push(`[${rule.name}] ${alertMsg}`);
      }
    }
  }

  if (changed) await saveRules();

  return alerts;
}
