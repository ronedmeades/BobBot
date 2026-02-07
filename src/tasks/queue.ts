import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Task, TaskPriority, TaskQueueFile } from "./types.js";

const QUEUE_FILE = resolve("memory", "task-queue.json");

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

let queue: Task[] = [];

async function save(): Promise<void> {
  const data: TaskQueueFile = {
    version: 1,
    tasks: queue,
    lastWorkerRun: new Date().toISOString(),
  };
  await mkdir(resolve("memory"), { recursive: true });
  await writeFile(QUEUE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export async function initTaskQueue(): Promise<void> {
  try {
    const raw = await readFile(QUEUE_FILE, "utf-8");
    const data = JSON.parse(raw) as TaskQueueFile;
    queue = data.tasks ?? [];

    // Resume any tasks that were active when we shut down
    for (const task of queue) {
      if (task.status === "active") {
        task.status = "pending"; // Will be picked up by worker
        console.log(`[queue] Resuming task ${task.id.slice(0, 8)}: ${task.description.slice(0, 50)}`);
      }
    }

    console.log(`[queue] Loaded ${queue.length} tasks from disk`);
  } catch {
    queue = [];
    console.log("[queue] No existing task queue — starting fresh");
  }
}

export interface CreateTaskOpts {
  userId: string;
  chatId?: number;
  description: string;
  priority?: TaskPriority;
  maxSteps?: number;
  createdBy?: Task["createdBy"];
  tags?: string[];
}

export async function createTask(opts: CreateTaskOpts): Promise<Task> {
  const task: Task = {
    id: randomUUID(),
    userId: opts.userId,
    chatId: opts.chatId ?? 0,
    description: opts.description,
    status: "pending",
    priority: opts.priority ?? "normal",
    steps: [],
    findings: "",
    nextAction: "",
    stepsCompleted: 0,
    maxSteps: opts.maxSteps ?? 10,
    toolsUsed: [],
    createdAt: new Date().toISOString(),
    createdBy: opts.createdBy ?? "user",
    tags: opts.tags ?? [],
    retryCount: 0,
  };

  queue.push(task);
  await save();
  return task;
}

export async function getTask(id: string): Promise<Task | undefined> {
  return queue.find((t) => t.id === id);
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task | undefined> {
  const task = queue.find((t) => t.id === id);
  if (!task) return undefined;

  Object.assign(task, updates);
  await save();
  return task;
}

/**
 * Get the next task to work on.
 * Prioritizes: active tasks first (resume), then pending, sorted by priority then age.
 */
export async function getNextTask(): Promise<Task | undefined> {
  // First: any task already active (was in progress)
  const active = queue.find((t) => t.status === "active");
  if (active) return active;

  // Next: highest priority pending task
  const pending = queue
    .filter((t) => t.status === "pending")
    .sort((a, b) => {
      const pDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
      if (pDiff !== 0) return pDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  return pending[0];
}

export async function getTasksForUser(userId: string): Promise<Task[]> {
  return queue.filter((t) => t.userId === userId);
}

export async function getAllTasks(): Promise<Task[]> {
  return [...queue];
}

export async function cancelTask(id: string): Promise<Task | undefined> {
  const task = queue.find((t) => t.id === id);
  if (!task) return undefined;
  if (task.status === "completed" || task.status === "cancelled") return task;

  task.status = "cancelled";
  task.completedAt = new Date().toISOString();
  await save();
  return task;
}

export async function pauseTask(id: string): Promise<Task | undefined> {
  const task = queue.find((t) => t.id === id);
  if (!task) return undefined;
  if (task.status !== "pending" && task.status !== "active") return task;

  task.status = "paused";
  task.pausedAt = new Date().toISOString();
  await save();
  return task;
}

export async function resumeTask(id: string): Promise<Task | undefined> {
  const task = queue.find((t) => t.id === id);
  if (!task) return undefined;
  if (task.status !== "paused") return task;

  task.status = "pending";
  task.pausedAt = undefined;
  await save();
  return task;
}

/**
 * Clean up old completed/cancelled/failed tasks (older than 7 days).
 */
export async function cleanupOldTasks(): Promise<number> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const before = queue.length;

  queue = queue.filter((t) => {
    if (t.status === "completed" || t.status === "cancelled" || t.status === "failed") {
      const completedTime = t.completedAt ? new Date(t.completedAt).getTime() : 0;
      return completedTime > cutoff;
    }
    return true;
  });

  const removed = before - queue.length;
  if (removed > 0) await save();
  return removed;
}
