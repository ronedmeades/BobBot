import { config } from "../config.js";
import { runAgent } from "../agent/core.js";
import { memory } from "../agent/memory.js";
import { events } from "../dashboard/events.js";
import { getIsBusy, setIsBusy, setCurrentTaskId } from "./busy-state.js";
import { getNextTask, updateTask, cleanupOldTasks } from "./queue.js";
import {
  escalationTick,
  createEscalation,
  setEscalationNotifier,
  cleanupOldChains,
} from "./escalation.js";
import type { Task, TaskStep } from "./types.js";

type NotifyFn = (chatId: number, message: string) => Promise<void>;

let workerTimer: ReturnType<typeof setInterval> | null = null;
let notifyUser: NotifyFn | null = null;
let stepsThisHour = 0;
let hourResetTimer: ReturnType<typeof setInterval> | null = null;

const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS) || 30_000;
const MAX_STEPS_PER_HOUR = Number(process.env.WORKER_MAX_STEPS_PER_HOUR) || 20;

export function setWorkerNotifier(fn: NotifyFn): void {
  notifyUser = fn;
  setEscalationNotifier(fn);
}

function buildInitialPrompt(task: Task): string {
  return `[Background Task] You are working on a background research task. Work autonomously and save your progress.

Task: ${task.description}

Instructions:
- Take the FIRST concrete step toward completing this task
- Use your tools (fetch_url, save_note, run_command, etc.) to make real progress
- Be thorough — fetch real data, read documentation, explore APIs
- At the END of your response, include exactly these two markdown sections:

## Findings So Far
(Summarize what you learned or accomplished in this step)

## Next Steps
(What you plan to do in the next work session. Write "DONE" if the task is fully complete.)`;
}

function buildContinuationPrompt(task: Task): string {
  return `[Background Task — Step ${task.stepsCompleted + 1}] You are continuing a background research task.

Task: ${task.description}

Previous findings:
${task.findings || "(No findings yet)"}

Your planned next action was: ${task.nextAction || "Continue research"}

Instructions:
- Continue from where you left off — build on your previous findings
- Use your tools to make further progress
- At the END of your response, include exactly these two markdown sections:

## Findings So Far
(Full accumulated summary — include previous findings plus anything new)

## Next Steps
(What to do next, or "DONE" if the task is fully complete.)`;
}

function parseFindings(responseText: string): { findings: string; nextAction: string; isDone: boolean } {
  const findingsMatch = responseText.match(/## Findings So Far\s*\n([\s\S]*?)(?=\n## Next Steps|$)/i);
  const nextMatch = responseText.match(/## Next Steps\s*\n([\s\S]*?)$/i);

  const findings = findingsMatch?.[1]?.trim() ?? "";
  const nextAction = nextMatch?.[1]?.trim() ?? "";
  const isDone = /\bDONE\b/i.test(nextAction);

  return { findings, nextAction, isDone };
}

async function ensureTaskProfile(task: Task): Promise<void> {
  const taskUserId = `task-${task.id}`;
  const existing = await memory.loadProfile(taskUserId);
  if (existing) return;

  // Copy owner profile to task context so system prompt builds correctly
  const ownerProfile = await memory.loadProfile(task.userId);
  if (ownerProfile) {
    await memory.saveProfile({
      ...ownerProfile,
      userId: taskUserId,
      notes: `Background task worker context. Original user: ${ownerProfile.name}`,
    });
  } else {
    await memory.saveProfile({
      userId: taskUserId,
      name: config.owner.name,
      chatId: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      preferences: {},
      notes: "Background task worker context",
    });
  }
}

async function executeStep(task: Task): Promise<void> {
  const taskUserId = `task-${task.id}`;
  await ensureTaskProfile(task);

  const prompt = task.stepsCompleted === 0
    ? buildInitialPrompt(task)
    : buildContinuationPrompt(task);

  const stepStart = Date.now();

  events.emitEvent("agent:status", {
    userId: config.owner.userId,
    status: "thinking",
    detail: `Background: ${task.description.slice(0, 50)}... (step ${task.stepsCompleted + 1}/${task.maxSteps})`,
  });

  const response = await runAgent(taskUserId, prompt, "worker");

  const durationMs = Date.now() - stepStart;
  const { findings, nextAction, isDone } = parseFindings(response.text);

  // Record the step
  const stepTimestamp = new Date().toISOString();
  const step: TaskStep = {
    stepNumber: task.stepsCompleted + 1,
    prompt,
    response: response.text,
    toolsUsed: response.toolsUsed,
    timestamp: stepTimestamp,
    durationMs,
  };

  // Persist step to SQLite
  try {
    const { insertTaskStep } = await import("../db/queries.js");
    insertTaskStep({
      taskId: task.id,
      stepNumber: step.stepNumber,
      prompt,
      response: response.text,
      toolsUsed: response.toolsUsed,
      timestamp: stepTimestamp,
      durationMs,
    });
  } catch { /* SQLite unavailable */ }

  // Aggregate tools
  const allTools = [...new Set([...task.toolsUsed, ...response.toolsUsed])];

  // Update task
  await updateTask(task.id, {
    status: isDone || task.stepsCompleted + 1 >= task.maxSteps ? "completed" : "active",
    steps: [...task.steps, step],
    findings: findings || task.findings,
    nextAction: isDone ? "DONE" : nextAction,
    stepsCompleted: task.stepsCompleted + 1,
    toolsUsed: allTools,
    completedAt: isDone || task.stepsCompleted + 1 >= task.maxSteps
      ? new Date().toISOString()
      : undefined,
    result: isDone ? findings : undefined,
    retryCount: 0,
  });

  // Emit progress event
  events.emitEvent("task:update", {
    taskId: task.id,
    status: isDone ? "completed" : "active",
    description: task.description,
  });

  console.log(
    `[worker] Step ${task.stepsCompleted + 1} done for "${task.description.slice(0, 40)}" ` +
    `(${response.toolsUsed.length} tools, ${Math.round(durationMs / 1000)}s)` +
    (isDone ? " — COMPLETE" : "")
  );

  // If done, save findings as a note and notify user
  if (isDone || task.stepsCompleted + 1 >= task.maxSteps) {
    const noteContent = `# Task: ${task.description}

- **ID**: ${task.id}
- **Steps**: ${task.stepsCompleted + 1}
- **Completed**: ${new Date().toISOString()}
- **Tools used**: ${allTools.join(", ") || "none"}

## Findings

${findings || response.text}
`;
    await memory.saveNote(`task-${task.id.slice(0, 8)}`, noteContent);

    events.emitEvent("agent:status", {
      userId: config.owner.userId,
      status: "done",
      detail: `Completed: ${task.description.slice(0, 50)}`,
    });

    // Create escalation chain for external notifications (if channels were requested)
    const channels = task.notifyVia ?? [];
    if (channels.length > 0) {
      const findingsText = (findings || response.text).length > 4000
        ? (findings || response.text).slice(0, 4000) + "\n\n...(truncated, full report saved to notes)"
        : (findings || response.text);

      const escalateMin = task.escalateAfterMin ?? 10;
      await createEscalation({
        triggerType: "task_complete",
        triggerRef: task.id,
        description: task.description,
        notifyChannels: channels,
        escalateAfterMin: escalateMin,
        userId: task.userId,
        chatId: task.chatId,
        context: { findings: findingsText },
      });
    }
  }
}

async function workerTick(): Promise<void> {
  // Always check escalations — they don't need the agent loop
  await escalationTick().catch((err) => console.error("[worker] Escalation tick error:", err));

  if (getIsBusy()) return;
  if (stepsThisHour >= MAX_STEPS_PER_HOUR) {
    return; // Rate limit
  }

  const task = await getNextTask();
  if (!task) return;

  setIsBusy(true, "worker");
  setCurrentTaskId(task.id);

  try {
    // Mark as active if pending
    if (task.status === "pending") {
      await updateTask(task.id, {
        status: "active",
        startedAt: task.startedAt ?? new Date().toISOString(),
      });
    }

    await executeStep(task);
    stepsThisHour++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] Error on task ${task.id.slice(0, 8)}:`, message);

    const newRetry = (task.retryCount ?? 0) + 1;
    if (newRetry >= 3) {
      await updateTask(task.id, {
        status: "failed",
        error: `Failed after ${newRetry} retries: ${message}`,
        retryCount: newRetry,
        completedAt: new Date().toISOString(),
      });
      events.emitEvent("task:update", {
        taskId: task.id,
        status: "failed",
        description: task.description,
      });

      // Escalation on failure too (if channels were requested)
      const failChannels = task.notifyVia ?? [];
      if (failChannels.length > 0) {
        await createEscalation({
          triggerType: "task_failed",
          triggerRef: task.id,
          description: task.description,
          notifyChannels: failChannels,
          escalateAfterMin: task.escalateAfterMin ?? 10,
          userId: task.userId,
          chatId: task.chatId,
          context: { error: message },
        }).catch((err) => console.error("[worker] Failed to create failure escalation:", err));
      }
    } else {
      await updateTask(task.id, { retryCount: newRetry });
    }
  } finally {
    setCurrentTaskId(null);
    setIsBusy(false);
  }
}

export function startWorker(): void {
  if (workerTimer) return;

  console.log(`[worker] Starting background worker (every ${WORKER_INTERVAL_MS / 1000}s, max ${MAX_STEPS_PER_HOUR} steps/hr)`);

  // Run first tick after 10 seconds (let everything start up)
  setTimeout(() => {
    workerTick().catch((err) => console.error("[worker] Tick error:", err));
  }, 10_000);

  workerTimer = setInterval(() => {
    workerTick().catch((err) => console.error("[worker] Tick error:", err));
  }, WORKER_INTERVAL_MS);

  // Reset steps counter every hour
  hourResetTimer = setInterval(() => {
    stepsThisHour = 0;
  }, 60 * 60 * 1000);

  // Clean up old tasks + escalation chains on worker start
  cleanupOldTasks().then((removed) => {
    if (removed > 0) console.log(`[worker] Cleaned up ${removed} old tasks`);
  }).catch(() => {});
  cleanupOldChains().then((removed) => {
    if (removed > 0) console.log(`[worker] Cleaned up ${removed} old escalation chains`);
  }).catch(() => {});
}

export function stopWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  if (hourResetTimer) {
    clearInterval(hourResetTimer);
    hourResetTimer = null;
  }
  console.log("[worker] Stopped");
}
