import type { ToolDefinition } from "../providers/types.js";
import { config } from "../config.js";
import {
  createTask,
  getTask,
  getAllTasks,
  cancelTask,
  pauseTask,
  resumeTask,
  updateTask,
} from "../tasks/queue.js";
import type { TaskPriority } from "../tasks/types.js";

export const taskManagerToolDefinitions: ToolDefinition[] = [
  {
    name: "create_background_task",
    description:
      "Create a background task that Bob works on autonomously between conversations. Use this when the user asks you to research something, investigate a topic, or do work that requires multiple steps over time. The task runs in the background while you're idle — no need for the user to stay in the chat.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: {
          type: "string",
          description:
            "Clear description of what to do (e.g. 'Research HIPAA medical records requirements and summarize the key compliance rules for a health app')",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "Task priority — higher priority tasks run first (default: normal)",
        },
        max_steps: {
          type: "number",
          description:
            "Maximum work sessions before completing (default: 10). Each step is one round of research/work.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for organization (e.g. ['vitalos', 'research'])",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "list_background_tasks",
    description:
      "List all background tasks with their status and progress. Use this to check what work is queued, in progress, or completed.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_task_details",
    description:
      "Get full details of a specific background task including all findings, steps completed, and tools used.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "The task ID (full UUID or first 8 characters)",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "cancel_background_task",
    description: "Cancel a pending or active background task.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to cancel",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "update_task_priority",
    description: "Change the priority of a background task.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to update",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "New priority level",
        },
      },
      required: ["task_id", "priority"],
    },
  },
  {
    name: "pause_resume_task",
    description: "Pause or resume a background task.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "The task ID",
        },
        action: {
          type: "string",
          enum: ["pause", "resume"],
          description: "Whether to pause or resume the task",
        },
      },
      required: ["task_id", "action"],
    },
  },
];

interface ToolResult {
  success: boolean;
  output: string;
}

async function findTask(idInput: string) {
  // Support both full UUID and short prefix
  let task = await getTask(idInput);
  if (!task) {
    const all = await getAllTasks();
    task = all.find((t) => t.id.startsWith(idInput));
  }
  return task;
}

export async function handleCreateBackgroundTask(
  input: Record<string, unknown>,
  context?: { userId: string }
): Promise<ToolResult> {
  const description = input.description as string;
  if (!description) {
    return { success: false, output: "description is required" };
  }

  const task = await createTask({
    userId: context?.userId ?? config.owner.userId,
    description,
    priority: (input.priority as TaskPriority) ?? "normal",
    maxSteps: (input.max_steps as number) ?? 10,
    createdBy: "agent",
    tags: (input.tags as string[]) ?? [],
  });

  return {
    success: true,
    output: `Background task created!\n\nID: ${task.id}\nDescription: ${task.description}\nPriority: ${task.priority}\nMax steps: ${task.maxSteps}\n\nI'll work on this autonomously when I'm not in a direct conversation. The task bar on the dashboard will show progress.`,
  };
}

export async function handleListBackgroundTasks(): Promise<ToolResult> {
  const tasks = await getAllTasks();
  if (tasks.length === 0) {
    return { success: true, output: "No background tasks." };
  }

  const statusIcons: Record<string, string> = {
    pending: "[ ]",
    active: "[~]",
    paused: "[||]",
    completed: "[+]",
    failed: "[x]",
    cancelled: "[-]",
  };

  const lines = tasks.map((t) => {
    const icon = statusIcons[t.status] ?? "[?]";
    const progress = t.maxSteps > 0 ? ` (${t.stepsCompleted}/${t.maxSteps} steps)` : "";
    const priority = t.priority !== "normal" ? ` [${t.priority.toUpperCase()}]` : "";
    return `${icon}${priority} ${t.description.slice(0, 60)}${progress}\n    ID: ${t.id.slice(0, 8)} | Status: ${t.status} | Created: ${t.createdAt}`;
  });

  return { success: true, output: lines.join("\n\n") };
}

export async function handleGetTaskDetails(input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;
  if (!taskId) return { success: false, output: "task_id is required" };

  const task = await findTask(taskId);
  if (!task) return { success: false, output: `Task not found: ${taskId}` };

  const details = `# Task: ${task.description}

- **ID**: ${task.id}
- **Status**: ${task.status}
- **Priority**: ${task.priority}
- **Progress**: ${task.stepsCompleted}/${task.maxSteps} steps
- **Created**: ${task.createdAt}
- **Tools used**: ${task.toolsUsed.join(", ") || "none"}

## Findings

${task.findings || "(No findings yet)"}

## Next Action

${task.nextAction || "(Not started)"}
${task.error ? `\n## Error\n\n${task.error}` : ""}`;

  return { success: true, output: details };
}

export async function handleCancelBackgroundTask(input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;
  if (!taskId) return { success: false, output: "task_id is required" };

  const task = await findTask(taskId);
  if (!task) return { success: false, output: `Task not found: ${taskId}` };

  const cancelled = await cancelTask(task.id);
  return {
    success: true,
    output: `Task cancelled: "${cancelled?.description}"`,
  };
}

export async function handleUpdateTaskPriority(input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;
  const priority = input.priority as TaskPriority;
  if (!taskId || !priority) return { success: false, output: "task_id and priority are required" };

  const task = await findTask(taskId);
  if (!task) return { success: false, output: `Task not found: ${taskId}` };

  await updateTask(task.id, { priority });
  return {
    success: true,
    output: `Priority updated to ${priority} for: "${task.description}"`,
  };
}

export async function handlePauseResumeTask(input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;
  const action = input.action as string;
  if (!taskId || !action) return { success: false, output: "task_id and action are required" };

  const task = await findTask(taskId);
  if (!task) return { success: false, output: `Task not found: ${taskId}` };

  if (action === "pause") {
    await pauseTask(task.id);
    return { success: true, output: `Paused: "${task.description}"` };
  } else {
    await resumeTask(task.id);
    return { success: true, output: `Resumed: "${task.description}"` };
  }
}
