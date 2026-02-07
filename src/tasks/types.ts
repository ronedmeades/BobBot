export type TaskStatus = "pending" | "active" | "paused" | "completed" | "failed" | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface TaskStep {
  stepNumber: number;
  prompt: string;
  response: string;
  toolsUsed: string[];
  timestamp: string;
  durationMs: number;
}

export interface Task {
  id: string;
  userId: string;
  chatId: number;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;

  // Progress tracking
  steps: TaskStep[];
  findings: string;
  nextAction: string;
  stepsCompleted: number;
  maxSteps: number;

  // Results
  result?: string;
  error?: string;
  toolsUsed: string[];

  // Timestamps
  createdAt: string;
  startedAt?: string;
  pausedAt?: string;
  completedAt?: string;

  // Metadata
  createdBy: "user" | "agent" | "telegram" | "dashboard";
  tags: string[];
  retryCount: number;
}

export interface TaskQueueFile {
  version: number;
  tasks: Task[];
  lastWorkerRun?: string;
}
