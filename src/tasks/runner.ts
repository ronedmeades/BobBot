import { randomUUID } from "node:crypto";
import { runAgent } from "../agent/core.js";
import { memory } from "../agent/memory.js";
import type { Task } from "./types.js";
import { events } from "../dashboard/events.js";

type NotifyFn = (chatId: number, message: string) => Promise<void>;

/** In-memory task store. Swap for SQLite/Redis later if needed. */
const tasks = new Map<string, Task>();

let notifyUser: NotifyFn | null = null;

export function setNotifier(fn: NotifyFn): void {
  notifyUser = fn;
}

/** Submit a task for background execution. Returns immediately with the task ID. */
export function submitTask(userId: string, chatId: number, description: string): Task {
  const task: Task = {
    id: randomUUID(),
    userId,
    chatId,
    description,
    status: "pending",
    toolsUsed: [],
    createdAt: new Date().toISOString(),
  };

  tasks.set(task.id, task);
  events.emitEvent("task:update", { taskId: task.id, status: "pending", description });

  // Fire and forget — runs in the background
  runTaskAsync(task);

  return task;
}

async function runTaskAsync(task: Task): Promise<void> {
  task.status = "running";
  events.emitEvent("task:update", { taskId: task.id, status: "running", description: task.description });
  console.log(`[task:${task.id.slice(0, 8)}] Starting: ${task.description}`);

  try {
    const response = await runAgent(task.userId, task.description);

    task.status = "completed";
    task.result = response.text;
    task.toolsUsed = response.toolsUsed;
    task.completedAt = new Date().toISOString();
    events.emitEvent("task:update", { taskId: task.id, status: "completed", description: task.description });

    console.log(`[task:${task.id.slice(0, 8)}] Completed (${response.toolsUsed.length} tool calls)`);

    // Save task result to memory
    const noteContent = `# Task: ${task.description}

- **ID**: ${task.id}
- **Completed**: ${task.completedAt}
- **Tools used**: ${task.toolsUsed.join(", ") || "none"}

## Result

${response.text}
`;
    await memory.saveNote(`task-${task.id.slice(0, 8)}`, noteContent);

    // Notify the user on Telegram
    if (notifyUser) {
      const summary = response.text.length > 4000
        ? response.text.slice(0, 4000) + "\n\n...(truncated, full report saved to file)"
        : response.text;

      await notifyUser(task.chatId, `Done! Here's what I found:\n\n${summary}`);
    }
  } catch (err) {
    task.status = "failed";
    task.error = err instanceof Error ? err.message : String(err);
    task.completedAt = new Date().toISOString();
    events.emitEvent("task:update", { taskId: task.id, status: "failed", description: task.description });

    console.error(`[task:${task.id.slice(0, 8)}] Failed:`, task.error);

    if (notifyUser) {
      await notifyUser(task.chatId, `Something went wrong with that task:\n\n${task.error}\n\nLet me know if you want me to try again.`);
    }
  }
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function getTasksForUser(userId: string): Task[] {
  return [...tasks.values()].filter((t) => t.userId === userId);
}
