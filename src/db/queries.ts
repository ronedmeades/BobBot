/**
 * Typed SQLite Query Wrappers
 *
 * All queries use prepared statements (cached by better-sqlite3).
 * Each function checks isDbAvailable() and returns gracefully if not.
 * No ORM — raw SQL with TypeScript types.
 */

import { getDb, isDbAvailable } from "./database.js";

// ─── Row types ──────────────────────────────────────────────────────

export interface ConversationRow {
  id: number;
  user_id: string;
  role: string;
  content: string;
  source: string | null;
  timestamp: string;
}

export interface ToolCallRow {
  id: number;
  conversation_id: number | null;
  tool_name: string;
  input_json: string | null;
  output_text: string | null;
  success: number;
  duration_ms: number | null;
  user_id: string;
  timestamp: string;
}

export interface ToolStats {
  tool_name: string;
  call_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration_ms: number | null;
}

export interface EventRow {
  id: number;
  type: string;
  data_json: string;
  timestamp: string;
}

export interface TaskRow {
  id: string;
  user_id: string;
  chat_id: number;
  description: string;
  status: string;
  priority: string;
  findings: string | null;
  next_action: string | null;
  steps_completed: number;
  max_steps: number;
  result: string | null;
  error: string | null;
  tools_used: string | null;
  created_at: string;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  created_by: string;
  tags: string | null;
  retry_count: number;
  notify_via: string | null;
  escalate_after_min: number | null;
}

export interface TaskStepRow {
  id: number;
  task_id: string;
  step_number: number;
  prompt: string | null;
  response: string | null;
  tools_used: string | null;
  timestamp: string;
  duration_ms: number | null;
}

// ─── Conversation queries ───────────────────────────────────────────

export function insertConversation(entry: {
  userId: string;
  role: string;
  content: string;
  source?: string;
}): number | null {
  if (!isDbAvailable()) return null;
  const db = getDb()!;
  const stmt = db.prepare(
    "INSERT INTO conversations (user_id, role, content, source, timestamp) VALUES (?, ?, ?, ?, ?)"
  );
  const result = stmt.run(
    entry.userId,
    entry.role,
    entry.content,
    entry.source ?? null,
    new Date().toISOString()
  );
  return result.lastInsertRowid as number;
}

export function searchConversations(
  query: string,
  opts?: { userId?: string; limit?: number; from?: string; to?: string }
): ConversationRow[] {
  if (!isDbAvailable()) return [];
  const db = getDb()!;
  const limit = opts?.limit ?? 20;
  const conditions: string[] = ["content LIKE ?"];
  const params: (string | number)[] = [`%${query}%`];

  if (opts?.userId) {
    conditions.push("user_id = ?");
    params.push(opts.userId);
  }
  if (opts?.from) {
    conditions.push("timestamp >= ?");
    params.push(opts.from);
  }
  if (opts?.to) {
    conditions.push("timestamp <= ?");
    params.push(opts.to);
  }

  const where = conditions.join(" AND ");
  const sql = `SELECT * FROM conversations WHERE ${where} ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as ConversationRow[];
}

export function getConversationHistory(
  userId: string,
  limit = 100
): ConversationRow[] {
  if (!isDbAvailable()) return [];
  const db = getDb()!;
  return db
    .prepare(
      "SELECT * FROM conversations WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?"
    )
    .all(userId, limit) as ConversationRow[];
}

// ─── Tool call queries ──────────────────────────────────────────────

export function insertToolCall(entry: {
  toolName: string;
  input: unknown;
  output: string;
  success: boolean;
  durationMs?: number;
  userId: string;
  conversationId?: number | null;
}): number | null {
  if (!isDbAvailable()) return null;
  const db = getDb()!;
  const inputJson =
    typeof entry.input === "string"
      ? entry.input.slice(0, 5000)
      : JSON.stringify(entry.input).slice(0, 5000);

  const stmt = db.prepare(
    "INSERT INTO tool_calls (conversation_id, tool_name, input_json, output_text, success, duration_ms, user_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const result = stmt.run(
    entry.conversationId ?? null,
    entry.toolName,
    inputJson,
    entry.output.slice(0, 5000),
    entry.success ? 1 : 0,
    entry.durationMs ?? null,
    entry.userId,
    new Date().toISOString()
  );
  return result.lastInsertRowid as number;
}

export function getToolUsageStats(opts?: {
  from?: string;
  to?: string;
}): ToolStats[] {
  if (!isDbAvailable()) return [];
  const db = getDb()!;

  const conditions: string[] = [];
  const params: string[] = [];

  if (opts?.from) {
    conditions.push("timestamp >= ?");
    params.push(opts.from);
  }
  if (opts?.to) {
    conditions.push("timestamp <= ?");
    params.push(opts.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      tool_name,
      COUNT(*) as call_count,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failure_count,
      ROUND(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) * 100, 1) as success_rate,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM tool_calls ${where}
    GROUP BY tool_name
    ORDER BY call_count DESC
  `;

  return db.prepare(sql).all(...params) as ToolStats[];
}

export function getMostUsedTools(limit = 10): ToolStats[] {
  if (!isDbAvailable()) return [];
  const db = getDb()!;

  return db
    .prepare(
      `SELECT
        tool_name,
        COUNT(*) as call_count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failure_count,
        ROUND(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) * 100, 1) as success_rate,
        ROUND(AVG(duration_ms), 0) as avg_duration_ms
      FROM tool_calls
      GROUP BY tool_name
      ORDER BY call_count DESC
      LIMIT ?`
    )
    .all(limit) as ToolStats[];
}

export function getToolCallsByName(
  toolName: string,
  limit = 20
): ToolCallRow[] {
  if (!isDbAvailable()) return [];
  const db = getDb()!;
  return db
    .prepare(
      "SELECT * FROM tool_calls WHERE tool_name = ? ORDER BY timestamp DESC LIMIT ?"
    )
    .all(toolName, limit) as ToolCallRow[];
}

// ─── Event queries ──────────────────────────────────────────────────

export function insertEvent(
  type: string,
  data: Record<string, unknown>
): number | null {
  if (!isDbAvailable()) return null;
  const db = getDb()!;
  const stmt = db.prepare(
    "INSERT INTO events (type, data_json, timestamp) VALUES (?, ?, ?)"
  );
  const result = stmt.run(type, JSON.stringify(data), new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function getRecentEvents(limit = 50): EventRow[] {
  if (!isDbAvailable()) return [];
  const db = getDb()!;
  return db
    .prepare("SELECT * FROM events ORDER BY timestamp DESC LIMIT ?")
    .all(limit) as EventRow[];
}

export function getEventsInRange(
  from: string,
  to: string,
  type?: string
): EventRow[] {
  if (!isDbAvailable()) return [];
  const db = getDb()!;

  if (type) {
    return db
      .prepare(
        "SELECT * FROM events WHERE timestamp >= ? AND timestamp <= ? AND type = ? ORDER BY timestamp DESC"
      )
      .all(from, to, type) as EventRow[];
  }

  return db
    .prepare(
      "SELECT * FROM events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC"
    )
    .all(from, to) as EventRow[];
}

// ─── Metadata helpers ───────────────────────────────────────────────

export function getMetadata(key: string): string | null {
  if (!isDbAvailable()) return null;
  const db = getDb()!;
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMetadata(key: string, value: string): void {
  if (!isDbAvailable()) return;
  const db = getDb()!;
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
  ).run(key, value);
}

// ─── Task queries ────────────────────────────────────────────────────

export function upsertTask(task: {
  id: string;
  userId: string;
  chatId: number;
  description: string;
  status: string;
  priority: string;
  findings?: string;
  nextAction?: string;
  stepsCompleted: number;
  maxSteps: number;
  result?: string;
  error?: string;
  toolsUsed: string[];
  createdAt: string;
  startedAt?: string;
  pausedAt?: string;
  completedAt?: string;
  createdBy: string;
  tags: string[];
  retryCount: number;
  notifyVia: string[];
  escalateAfterMin?: number;
}): void {
  if (!isDbAvailable()) return;
  const db = getDb()!;
  db.prepare(`
    INSERT INTO tasks (
      id, user_id, chat_id, description, status, priority,
      findings, next_action, steps_completed, max_steps,
      result, error, tools_used, created_at, started_at,
      paused_at, completed_at, created_by, tags, retry_count,
      notify_via, escalate_after_min
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      priority = excluded.priority,
      findings = excluded.findings,
      next_action = excluded.next_action,
      steps_completed = excluded.steps_completed,
      result = excluded.result,
      error = excluded.error,
      tools_used = excluded.tools_used,
      started_at = excluded.started_at,
      paused_at = excluded.paused_at,
      completed_at = excluded.completed_at,
      retry_count = excluded.retry_count
  `).run(
    task.id,
    task.userId,
    task.chatId,
    task.description,
    task.status,
    task.priority,
    task.findings ?? null,
    task.nextAction ?? null,
    task.stepsCompleted,
    task.maxSteps,
    task.result ?? null,
    task.error ?? null,
    JSON.stringify(task.toolsUsed),
    task.createdAt,
    task.startedAt ?? null,
    task.pausedAt ?? null,
    task.completedAt ?? null,
    task.createdBy,
    JSON.stringify(task.tags),
    task.retryCount,
    JSON.stringify(task.notifyVia),
    task.escalateAfterMin ?? null,
  );
}

export function insertTaskStep(step: {
  taskId: string;
  stepNumber: number;
  prompt: string;
  response: string;
  toolsUsed: string[];
  timestamp: string;
  durationMs: number;
}): number | null {
  if (!isDbAvailable()) return null;
  const db = getDb()!;
  const result = db.prepare(`
    INSERT INTO task_steps (task_id, step_number, prompt, response, tools_used, timestamp, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    step.taskId,
    step.stepNumber,
    step.prompt.slice(0, 10000),
    step.response.slice(0, 10000),
    JSON.stringify(step.toolsUsed),
    step.timestamp,
    step.durationMs,
  );
  return result.lastInsertRowid as number;
}

export function searchTasks(opts?: {
  query?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
}): TaskRow[] {
  if (!isDbAvailable()) return [];
  const db = getDb()!;
  const limit = opts?.limit ?? 20;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.query) {
    conditions.push("(description LIKE ? OR findings LIKE ? OR result LIKE ?)");
    const pattern = `%${opts.query}%`;
    params.push(pattern, pattern, pattern);
  }
  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.from) {
    conditions.push("created_at >= ?");
    params.push(opts.from);
  }
  if (opts?.to) {
    conditions.push("created_at <= ?");
    params.push(opts.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as TaskRow[];
}

export function getTaskAudit(taskId: string): {
  task: TaskRow | null;
  steps: TaskStepRow[];
} {
  if (!isDbAvailable()) return { task: null, steps: [] };
  const db = getDb()!;

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!task) return { task: null, steps: [] };

  const steps = db.prepare(
    "SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_number ASC"
  ).all(taskId) as TaskStepRow[];

  return { task, steps };
}
