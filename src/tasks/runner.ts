import { config } from "../config.js";
import { createTask, getTask, getTasksForUser as queueGetTasksForUser } from "./queue.js";
import { events } from "../dashboard/events.js";
import type { Task } from "./types.js";

type NotifyFn = (chatId: number, message: string) => Promise<void>;

let notifyUser: NotifyFn | null = null;

export function setNotifier(fn: NotifyFn): void {
  notifyUser = fn;
}

export function getNotifier(): NotifyFn | null {
  return notifyUser;
}

/**
 * Submit a task for background execution.
 * Creates it in the persistent queue — the worker picks it up on its next tick.
 */
export async function submitTask(userId: string, chatId: number, description: string): Promise<Task> {
  const task = await createTask({
    userId,
    chatId,
    description,
    priority: "normal",
    createdBy: "telegram",
  });

  events.emitEvent("task:update", { taskId: task.id, status: "pending", description });
  console.log(`[task] Queued: ${task.id.slice(0, 8)} — ${description}`);

  return task;
}

export { getTask };

export function getTasksForUser(userId: string): Promise<Task[]> {
  return queueGetTasksForUser(userId);
}
