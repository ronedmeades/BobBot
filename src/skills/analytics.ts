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
  searchTasks,
  getTaskAudit,
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
  {
    name: "search_tasks",
    description:
      "Search background task history. Find past research tasks, completed work, or failed tasks. " +
      "Tasks are persisted in SQLite — survives restarts and the 7-day JSON cleanup.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search terms to find in task descriptions, findings, or results",
        },
        status: {
          type: "string",
          enum: ["pending", "active", "paused", "completed", "failed", "cancelled"],
          description: "Filter by task status",
        },
        from: {
          type: "string",
          description: "Start date filter (ISO format)",
        },
        to: {
          type: "string",
          description: "End date filter (ISO format)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_task_audit",
    description:
      "Get the full audit trail for a background task — every step, prompt, response, tools used, and timing. " +
      "Use this to review what Bob did during a background task, debug failures, or understand results.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "The task UUID (full or partial — will match prefix)",
        },
      },
      required: ["task_id"],
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

export async function handleSearchTasks(
  input: Record<string, unknown>
): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return {
      success: false,
      output: "SQLite is not available. Task search requires the database to be initialized.",
    };
  }

  const rows = searchTasks({
    query: input.query as string | undefined,
    status: input.status as string | undefined,
    from: input.from as string | undefined,
    to: input.to as string | undefined,
    limit: (input.limit as number) ?? 20,
  });

  if (rows.length === 0) {
    return { success: true, output: "No tasks found matching the criteria." };
  }

  const lines = rows.map((t) => {
    const date = t.created_at.slice(0, 16).replace("T", " ");
    const tools = t.tools_used ? JSON.parse(t.tools_used) as string[] : [];
    const duration = t.completed_at && t.started_at
      ? Math.round((new Date(t.completed_at).getTime() - new Date(t.started_at).getTime()) / 1000)
      : null;
    return [
      `[${date}] ${t.status.toUpperCase()} (${t.priority}) — ${t.description}`,
      `  ID: ${t.id.slice(0, 8)}  Steps: ${t.steps_completed}/${t.max_steps}  Tools: ${tools.length}${duration ? `  Duration: ${duration}s` : ""}`,
      t.result ? `  Result: ${t.result.slice(0, 150)}${t.result.length > 150 ? "..." : ""}` : "",
      t.error ? `  Error: ${t.error.slice(0, 150)}` : "",
    ].filter(Boolean).join("\n");
  });

  return {
    success: true,
    output: `Found ${rows.length} task(s):\n\n${lines.join("\n\n")}`,
  };
}

export async function handleGetTaskAudit(
  input: Record<string, unknown>
): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return {
      success: false,
      output: "SQLite is not available. Task audit requires the database to be initialized.",
    };
  }

  const taskId = input.task_id as string;
  if (!taskId) {
    return { success: false, output: "task_id is required" };
  }

  // Try exact match first, then prefix match
  let audit = getTaskAudit(taskId);
  if (!audit.task && taskId.length < 36) {
    // Prefix match — search for tasks starting with this ID
    const matches = searchTasks({ query: taskId, limit: 5 });
    const match = matches.find((t) => t.id.startsWith(taskId));
    if (match) {
      audit = getTaskAudit(match.id);
    }
  }

  if (!audit.task) {
    return { success: true, output: `No task found with ID "${taskId}".` };
  }

  const t = audit.task;
  const tools = t.tools_used ? JSON.parse(t.tools_used) as string[] : [];
  const tags = t.tags ? JSON.parse(t.tags) as string[] : [];

  const header = [
    `Task: ${t.description}`,
    `ID: ${t.id}`,
    `Status: ${t.status}  Priority: ${t.priority}  Created by: ${t.created_by}`,
    `Steps: ${t.steps_completed}/${t.max_steps}  Retries: ${t.retry_count}`,
    `Created: ${t.created_at}`,
    t.started_at ? `Started: ${t.started_at}` : null,
    t.completed_at ? `Completed: ${t.completed_at}` : null,
    tools.length > 0 ? `Tools used: ${tools.join(", ")}` : null,
    tags.length > 0 ? `Tags: ${tags.join(", ")}` : null,
    t.result ? `\nResult:\n${t.result.slice(0, 2000)}` : null,
    t.error ? `\nError: ${t.error}` : null,
  ].filter(Boolean).join("\n");

  if (audit.steps.length === 0) {
    return { success: true, output: `${header}\n\nNo step audit trail recorded.` };
  }

  const stepLines = audit.steps.map((s) => {
    const stepTools = s.tools_used ? JSON.parse(s.tools_used) as string[] : [];
    const response = s.response
      ? s.response.slice(0, 500) + (s.response.length > 500 ? "..." : "")
      : "(no response)";
    return [
      `--- Step ${s.step_number} (${s.duration_ms ? Math.round(s.duration_ms / 1000) + "s" : "?s"}) ---`,
      stepTools.length > 0 ? `Tools: ${stepTools.join(", ")}` : "Tools: none",
      `Response:\n${response}`,
    ].join("\n");
  });

  return {
    success: true,
    output: `${header}\n\n## Step Audit Trail\n\n${stepLines.join("\n\n")}`,
  };
}
