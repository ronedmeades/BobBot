/**
 * A2A Task State Management
 *
 * Tracks A2A protocol-level tasks (separate from Bob's internal task queue).
 * Each inbound request creates an A2A task that tracks state through
 * the protocol lifecycle: submitted → working → completed/failed.
 *
 * Persistence in memory/a2a-tasks.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AArtifact,
  A2ATasksFile,
} from "./types.js";

const TASKS_PATH = resolve("memory", "a2a-tasks.json");
const CURRENT_VERSION = 1;
const MAX_AGE_DAYS = 7;

// Module-level state
let tasks: A2ATask[] = [];
let initialized = false;

// ─── Persistence ────────────────────────────────────────────────────

async function loadTasks(): Promise<void> {
  try {
    const raw = await readFile(TASKS_PATH, "utf-8");
    const data = JSON.parse(raw) as A2ATasksFile;
    tasks = data.tasks ?? [];
  } catch {
    tasks = [];
  }
  initialized = true;
}

async function saveTasks(): Promise<void> {
  await mkdir(resolve("memory"), { recursive: true });
  const data: A2ATasksFile = { version: CURRENT_VERSION, tasks };
  await writeFile(TASKS_PATH, JSON.stringify(data, null, 2));
}

async function ensureLoaded(): Promise<void> {
  if (!initialized) await loadTasks();
}

// ─── Public API ─────────────────────────────────────────────────────

export async function initA2ATasks(): Promise<void> {
  await ensureLoaded();
  const active = tasks.filter((t) =>
    t.state === "submitted" || t.state === "working"
  ).length;
  if (active > 0) {
    console.log(`[a2a] ${active} active A2A tasks`);
  }
}

export async function createA2ATask(
  peerId: string,
  contextId: string,
  message: A2AMessage
): Promise<A2ATask> {
  await ensureLoaded();

  const now = new Date().toISOString();
  const task: A2ATask = {
    id: randomUUID(),
    contextId,
    state: "submitted",
    messages: [message],
    artifacts: [],
    peerId,
    createdAt: now,
    updatedAt: now,
  };

  tasks.push(task);
  await saveTasks();
  return task;
}

export async function getA2ATask(id: string): Promise<A2ATask | null> {
  await ensureLoaded();
  return tasks.find((t) => t.id === id) ?? null;
}

export async function getA2ATaskByContext(
  contextId: string,
  peerId: string
): Promise<A2ATask | null> {
  await ensureLoaded();
  return tasks.find((t) => t.contextId === contextId && t.peerId === peerId) ?? null;
}

export async function updateA2ATaskState(
  id: string,
  state: A2ATaskState
): Promise<A2ATask | null> {
  await ensureLoaded();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  task.state = state;
  task.updatedAt = new Date().toISOString();
  await saveTasks();
  return task;
}

export async function addMessageToTask(
  id: string,
  message: A2AMessage
): Promise<A2ATask | null> {
  await ensureLoaded();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  task.messages.push(message);
  task.updatedAt = new Date().toISOString();
  await saveTasks();
  return task;
}

export async function addArtifactToTask(
  id: string,
  artifact: A2AArtifact
): Promise<A2ATask | null> {
  await ensureLoaded();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  task.artifacts.push(artifact);
  task.updatedAt = new Date().toISOString();
  await saveTasks();
  return task;
}

export async function listA2ATasks(opts?: {
  peerId?: string;
  state?: A2ATaskState;
  contextId?: string;
}): Promise<A2ATask[]> {
  await ensureLoaded();
  let filtered = tasks;
  if (opts?.peerId) filtered = filtered.filter((t) => t.peerId === opts.peerId);
  if (opts?.state) filtered = filtered.filter((t) => t.state === opts.state);
  if (opts?.contextId) filtered = filtered.filter((t) => t.contextId === opts.contextId);
  return [...filtered];
}

export async function cleanupOldA2ATasks(): Promise<number> {
  await ensureLoaded();
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const before = tasks.length;

  tasks = tasks.filter((t) => {
    // Keep active tasks regardless of age
    if (t.state === "submitted" || t.state === "working") return true;
    return new Date(t.updatedAt).getTime() > cutoff;
  });

  const removed = before - tasks.length;
  if (removed > 0) {
    await saveTasks();
  }
  return removed;
}
