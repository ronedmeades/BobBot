import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { events } from "../dashboard/events.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Types ---

interface ScheduledTask {
  name: string;
  description: string;
  intervalMs: number | null;
  lastRun: string | null;
  nextRun: string;
  enabled: boolean;
  runCount: number;
  createdAt: string;
}

interface ScheduledTasksFile {
  version: number;
  tasks: ScheduledTask[];
}

// --- Persistence ---

const MEMORY_DIR = resolve("memory");
const TASKS_FILE = join(MEMORY_DIR, "scheduled-tasks.json");

async function loadTasksFile(): Promise<ScheduledTasksFile> {
  try {
    const raw = await readFile(TASKS_FILE, "utf-8");
    return JSON.parse(raw) as ScheduledTasksFile;
  } catch {
    return { version: 1, tasks: [] };
  }
}

async function saveTasksFile(data: ScheduledTasksFile): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
  await writeFile(TASKS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
let tasksCache: ScheduledTask[] = [];

// --- Tool Definitions ---

export const schedulerToolDefinitions: Anthropic.Tool[] = [
  {
    name: "add_scheduled_task",
    description:
      "Schedule a recurring or one-shot task for Bob to run automatically. " +
      "Recurring tasks repeat at a fixed interval. One-shot tasks run once at a specified time. " +
      "The task description is what Bob will do when the task fires. It gets fed into the agent loop as a message.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Unique name for this scheduled task (use hyphens, no spaces). Used to identify and manage the task.",
        },
        description: {
          type: "string",
          description:
            "What Bob should do when this task runs. This will be sent to the agent as a user message, " +
            "so write it as an instruction.",
        },
        interval_hours: {
          type: "number",
          description:
            "How often to repeat this task, in hours. Mutually exclusive with interval_days and run_at.",
        },
        interval_days: {
          type: "number",
          description:
            "How often to repeat this task, in days. Mutually exclusive with interval_hours and run_at.",
        },
        run_at: {
          type: "string",
          description:
            "ISO 8601 timestamp for a one-shot task (e.g. 2026-02-07T09:00:00Z). " +
            "The task runs once at this time and is then disabled. Mutually exclusive with interval_hours/interval_days.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the task is enabled (default: true). Disabled tasks are skipped.",
        },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "remove_scheduled_task",
    description:
      "Remove a scheduled task by name. The task is permanently deleted.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The name of the scheduled task to remove.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_scheduled_tasks",
    description:
      "List all scheduled tasks with their next run time, status, and run history.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "run_scheduled_task",
    description:
      "Manually trigger a scheduled task by name, running it immediately regardless of its next scheduled time. " +
      "The next run time is recalculated after execution (for recurring tasks).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The name of the scheduled task to run now.",
        },
      },
      required: ["name"],
    },
  },
];

// --- Helpers ---

function computeIntervalMs(input: Record<string, unknown>): number | null {
  const intervalHours = input.interval_hours as number | undefined;
  const intervalDays = input.interval_days as number | undefined;
  const runAt = input.run_at as string | undefined;

  if (runAt) return null; // one-shot

  if (intervalHours !== undefined && intervalHours > 0) {
    return intervalHours * 60 * 60 * 1000;
  }
  if (intervalDays !== undefined && intervalDays > 0) {
    return intervalDays * 24 * 60 * 60 * 1000;
  }

  return null;
}

function computeNextRun(input: Record<string, unknown>): string {
  const runAt = input.run_at as string | undefined;
  if (runAt) {
    const parsed = new Date(runAt);
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid run_at timestamp: ${runAt}`);
    }
    return parsed.toISOString();
  }

  const intervalMs = computeIntervalMs(input);
  if (intervalMs !== null) {
    return new Date(Date.now() + intervalMs).toISOString();
  }

  throw new Error(
    "Must specify at least one of: interval_hours, interval_days, or run_at"
  );
}

function formatDuration(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const days = hours / 24;
  return days === 1 ? "1 day" : `${days} days`;
}

function formatRelativeTime(isoDate: string): string {
  const diff = new Date(isoDate).getTime() - Date.now();
  const absDiff = Math.abs(diff);
  const minutes = Math.floor(absDiff / (60 * 1000));
  const hours = Math.floor(absDiff / (60 * 60 * 1000));
  const days = Math.floor(absDiff / (24 * 60 * 60 * 1000));

  let relative: string;
  if (minutes < 1) relative = "less than a minute";
  else if (minutes < 60) relative = `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  else if (hours < 24) relative = `${hours} hour${hours !== 1 ? "s" : ""}`;
  else relative = `${days} day${days !== 1 ? "s" : ""}`;

  return diff > 0 ? `in ${relative}` : `${relative} ago`;
}

// --- Tool Handlers ---

export async function handleAddScheduledTask(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const name = input.name as string;
  const description = input.description as string;
  const enabled = (input.enabled as boolean) ?? true;

  if (!name || !description) {
    return { success: false, output: "Both name and description are required." };
  }

  if (/\s/.test(name)) {
    return {
      success: false,
      output: "Task name must not contain spaces. Use hyphens instead.",
    };
  }

  const data = await loadTasksFile();
  const existing = data.tasks.find((t) => t.name === name);
  if (existing) {
    return {
      success: false,
      output: `A scheduled task named "${name}" already exists. Remove it first or use a different name.`,
    };
  }

  let nextRun: string;
  let intervalMs: number | null;
  try {
    nextRun = computeNextRun(input);
    intervalMs = computeIntervalMs(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg };
  }

  const task: ScheduledTask = {
    name,
    description,
    intervalMs,
    lastRun: null,
    nextRun,
    enabled,
    runCount: 0,
    createdAt: new Date().toISOString(),
  };

  data.tasks.push(task);
  await saveTasksFile(data);
  tasksCache = data.tasks;

  const typeLabel = intervalMs
    ? `Recurring every ${formatDuration(intervalMs)}`
    : `One-shot at ${nextRun}`;

  return {
    success: true,
    output:
      `Scheduled task "${name}" created.\n` +
      `Type: ${typeLabel}\n` +
      `Next run: ${nextRun} (${formatRelativeTime(nextRun)})\n` +
      `Enabled: ${enabled}\n` +
      `Description: ${description}`,
  };
}

export async function handleRemoveScheduledTask(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const name = input.name as string;
  if (!name) {
    return { success: false, output: "Task name is required." };
  }

  const data = await loadTasksFile();
  const index = data.tasks.findIndex((t) => t.name === name);
  if (index === -1) {
    return {
      success: false,
      output: `No scheduled task found with name "${name}".`,
    };
  }

  const removed = data.tasks.splice(index, 1)[0];
  await saveTasksFile(data);
  tasksCache = data.tasks;

  return {
    success: true,
    output:
      `Removed scheduled task "${removed.name}".\n` +
      `It had run ${removed.runCount} time${removed.runCount !== 1 ? "s" : ""}.`,
  };
}

export async function handleListScheduledTasks(): Promise<ToolResult> {
  const data = await loadTasksFile();

  if (data.tasks.length === 0) {
    return { success: true, output: "No scheduled tasks configured." };
  }

  const lines: string[] = [];
  for (const task of data.tasks) {
    const status = task.enabled ? "ENABLED" : "DISABLED";
    const type = task.intervalMs
      ? `every ${formatDuration(task.intervalMs)}`
      : "one-shot";
    const lastRunStr = task.lastRun
      ? `last run ${formatRelativeTime(task.lastRun)}`
      : "never run";
    const nextRunStr = task.enabled
      ? `next run ${formatRelativeTime(task.nextRun)}`
      : "paused";

    lines.push(
      `[${status}] ${task.name} (${type})\n` +
        `  Description: ${task.description}\n` +
        `  ${lastRunStr} | ${nextRunStr} | run count: ${task.runCount}`
    );
  }

  return {
    success: true,
    output: `Scheduled tasks (${data.tasks.length}):\n\n${lines.join("\n\n")}`,
  };
}

export async function handleRunScheduledTask(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const name = input.name as string;
  if (!name) {
    return { success: false, output: "Task name is required." };
  }

  const data = await loadTasksFile();
  const task = data.tasks.find((t) => t.name === name);
  if (!task) {
    return {
      success: false,
      output: `No scheduled task found with name "${name}".`,
    };
  }

  const success = await executeTask(task);

  task.lastRun = new Date().toISOString();
  task.runCount++;

  if (task.intervalMs) {
    task.nextRun = new Date(Date.now() + task.intervalMs).toISOString();
  } else {
    task.enabled = false;
  }

  await saveTasksFile(data);
  tasksCache = data.tasks;

  return {
    success: true,
    output:
      `Manually triggered "${name}".\n` +
      `Execution result: ${success ? "success" : "completed with issues"}\n` +
      `Run count: ${task.runCount}\n` +
      (task.intervalMs
        ? `Next scheduled run: ${task.nextRun} (${formatRelativeTime(task.nextRun)})`
        : "One-shot task -- now disabled."),
  };
}

// --- Task Execution ---

/**
 * Execute a scheduled task by feeding its description into the agent loop.
 * Dynamically imports runAgent to avoid circular dependencies.
 */
async function executeTask(task: ScheduledTask): Promise<boolean> {
  console.log(`[scheduler-skill] Executing scheduled task: ${task.name}`);
  events.emitEvent("task:update", {
    taskId: `scheduled-${task.name}`,
    status: "running",
    description: `Scheduled task: ${task.description}`,
  });

  try {
    // Dynamic import to avoid circular dependency (core.ts -> tools.ts -> this file)
    const { runAgent } = await import("../agent/core.js");

    const response = await runAgent(
      config.owner.userId,
      `[Scheduled Task: ${task.name}] ${task.description}`,
      "dashboard"
    );

    console.log(
      `[scheduler-skill] Task "${task.name}" completed. Tools used: ${response.toolsUsed.length}`
    );
    events.emitEvent("task:update", {
      taskId: `scheduled-${task.name}`,
      status: "completed",
      description: `Scheduled task complete: ${task.name}`,
    });

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler-skill] Task "${task.name}" failed: ${msg}`);
    events.emitEvent("task:update", {
      taskId: `scheduled-${task.name}`,
      status: "failed",
      description: `Scheduled task failed: ${task.name} -- ${msg}`,
    });
    return false;
  }
}

// --- Scheduler Loop Integration ---

/**
 * Check all scheduled tasks and execute any that are due.
 * Called by the existing hourly scheduler in src/tasks/scheduler.ts.
 */
export async function checkScheduledTasks(): Promise<void> {
  const data = await loadTasksFile();
  const now = Date.now();
  let modified = false;

  for (const task of data.tasks) {
    if (!task.enabled) continue;

    const nextRunTime = new Date(task.nextRun).getTime();
    if (isNaN(nextRunTime)) continue;
    if (nextRunTime > now) continue;

    // Task is due -- execute it
    const success = await executeTask(task);

    task.lastRun = new Date().toISOString();
    task.runCount++;
    modified = true;

    if (task.intervalMs) {
      // Recurring: schedule next run from now (not from the missed time,
      // to avoid rapid-fire catch-up if Bob was offline for a while)
      task.nextRun = new Date(Date.now() + task.intervalMs).toISOString();
    } else {
      // One-shot: disable after running
      task.enabled = false;
    }

    if (!success) {
      console.log(
        `[scheduler-skill] Task "${task.name}" had issues but will remain scheduled.`
      );
    }
  }

  if (modified) {
    await saveTasksFile(data);
    tasksCache = data.tasks;
  }
}

/**
 * Initialize the scheduled tasks system.
 * Loads persisted tasks from disk into memory.
 * Call once at startup from the existing scheduler.
 */
export async function initScheduledTasks(): Promise<void> {
  const data = await loadTasksFile();
  tasksCache = data.tasks;

  const enabledCount = data.tasks.filter((t) => t.enabled).length;
  if (data.tasks.length > 0) {
    console.log(
      `Scheduled tasks: ${enabledCount} enabled, ${data.tasks.length - enabledCount} disabled (${data.tasks.length} total)`
    );
  }
}
