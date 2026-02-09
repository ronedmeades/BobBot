/**
 * Analytics & History Skill
 *
 * 3 tools for querying Bob's SQLite database:
 * - search_history: Search past conversations
 * - get_tool_stats: Tool usage statistics
 * - get_event_log: Persistent event log queries
 *
 * All tools degrade gracefully if SQLite isn't available.
 */

import type { ToolDefinition } from "../providers/types.js";
import {
  searchConversations,
  getToolUsageStats,
  getMostUsedTools,
  getEventsInRange,
  getRecentEvents,
} from "../db/queries.js";
import { isDbAvailable } from "../db/database.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ─── Tool definitions ──────────────────────────────────────────────

export const analyticsToolDefinitions: ToolDefinition[] = [
  {
    name: "search_history",
    description:
      "Search past conversation history. Find when a topic was discussed, what was said, or recall a previous conversation. " +
      "Searches across all conversations stored in the SQLite database.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search terms to find in conversation history",
        },
        from: {
          type: "string",
          description: "Start date filter (ISO format, e.g. '2026-01-01')",
        },
        to: {
          type: "string",
          description: "End date filter (ISO format, e.g. '2026-02-08')",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 20)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_tool_stats",
    description:
      "Get usage statistics for Bob's tools. Shows which tools are used most, " +
      "success/failure rates, and average execution time. Useful for understanding usage patterns.",
    input_schema: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["day", "week", "month", "all"],
          description: "Time period to analyze (default: 'week')",
        },
        tool_name: {
          type: "string",
          description: "Filter to a specific tool name",
        },
        limit: {
          type: "number",
          description: "Max tools to return (default: 15)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_event_log",
    description:
      "Query the persistent event log. Find what happened at a specific time, " +
      "which tools were used, or review Bob's activity history. Events survive restarts.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: {
          type: "string",
          description: "Start datetime (ISO format)",
        },
        to: {
          type: "string",
          description: "End datetime (ISO format)",
        },
        type: {
          type: "string",
          description:
            "Filter by event type (e.g. 'tool:call', 'message:in', 'task:update', 'mcp:connect')",
        },
        limit: {
          type: "number",
          description: "Max results (default: 50)",
        },
      },
      required: [],
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────

export async function handleSearchHistory(
  input: Record<string, unknown>
): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return {
      success: false,
      output: "SQLite is not available. History search requires the database to be initialized.",
    };
  }

  const query = input.query as string;
  if (!query) {
    return { success: false, output: "query is required" };
  }

  const rows = searchConversations(query, {
    from: input.from as string | undefined,
    to: input.to as string | undefined,
    limit: (input.limit as number) ?? 20,
  });

  if (rows.length === 0) {
    return { success: true, output: `No conversations found matching "${query}".` };
  }

  const lines = rows.map((r) => {
    const date = r.timestamp.slice(0, 16).replace("T", " ");
    const preview = r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content;
    return `[${date}] ${r.role}: ${preview}`;
  });

  return {
    success: true,
    output: `Found ${rows.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`,
  };
}

export async function handleGetToolStats(
  input: Record<string, unknown>
): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return {
      success: false,
      output: "SQLite is not available. Tool stats require the database to be initialized.",
    };
  }

  const period = (input.period as string) ?? "week";
  const toolName = input.tool_name as string | undefined;
  const limit = (input.limit as number) ?? 15;

  // Calculate date range
  let from: string | undefined;
  const now = new Date();
  if (period === "day") {
    from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  } else if (period === "week") {
    from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (period === "month") {
    from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (toolName) {
    // Stats for a specific tool
    const stats = getToolUsageStats({ from });
    const match = stats.find((s) => s.tool_name === toolName);
    if (!match) {
      return { success: true, output: `No usage data for tool "${toolName}" in the ${period} period.` };
    }
    return {
      success: true,
      output: `Tool: ${match.tool_name}\nCalls: ${match.call_count}\nSuccess rate: ${match.success_rate}%\nAvg duration: ${match.avg_duration_ms ?? "N/A"}ms\nPeriod: ${period}`,
    };
  }

  // Overall stats
  const stats = getToolUsageStats({ from }).slice(0, limit);
  if (stats.length === 0) {
    return { success: true, output: `No tool usage data for the ${period} period.` };
  }

  const totalCalls = stats.reduce((sum, s) => sum + s.call_count, 0);
  const lines = stats.map(
    (s) =>
      `  ${s.tool_name}: ${s.call_count} calls (${s.success_rate}% success${s.avg_duration_ms ? `, avg ${s.avg_duration_ms}ms` : ""})`
  );

  return {
    success: true,
    output: `Tool usage stats (${period}, ${totalCalls} total calls):\n${lines.join("\n")}`,
  };
}

export async function handleGetEventLog(
  input: Record<string, unknown>
): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return {
      success: false,
      output: "SQLite is not available. Event log requires the database to be initialized.",
    };
  }

  const eventType = input.type as string | undefined;
  const limit = (input.limit as number) ?? 50;
  const from = input.from as string | undefined;
  const to = input.to as string | undefined;

  let rows;
  if (from && to) {
    rows = getEventsInRange(from, to, eventType);
  } else if (from) {
    rows = getEventsInRange(from, new Date().toISOString(), eventType);
  } else {
    rows = getRecentEvents(limit);
    if (eventType) {
      rows = rows.filter((r) => r.type === eventType);
    }
  }

  rows = rows.slice(0, limit);

  if (rows.length === 0) {
    return { success: true, output: "No events found matching the criteria." };
  }

  const lines = rows.map((r) => {
    const date = r.timestamp.slice(0, 19).replace("T", " ");
    const data = JSON.parse(r.data_json);
    const summary = Object.entries(data)
      .map(([k, v]) => {
        const val = typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "..." : v;
        return `${k}=${val}`;
      })
      .join(", ");
    return `[${date}] ${r.type}: ${summary}`;
  });

  return {
    success: true,
    output: `Event log (${rows.length} entries):\n${lines.join("\n")}`,
  };
}
