export type TaskStatus = "pending" | "active" | "paused" | "completed" | "failed" | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type NotifyChannel = "telegram" | "sms" | "call";

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
  notifyVia: NotifyChannel[];
  escalateAfterMin?: number;
}

export interface TaskQueueFile {
  version: number;
  tasks: Task[];
  lastWorkerRun?: string;
}

// --- Escalation Engine ---

export interface EscalationStep {
  channel: NotifyChannel;
  delayMin: number;       // minutes after trigger to send this step
  sentAt?: string;        // ISO timestamp when sent (undefined = not yet sent)
  error?: string;         // error if sending failed
}

export type EscalationStatus = "active" | "acknowledged" | "completed" | "cancelled";

export interface EscalationChain {
  id: string;
  triggerType: string;       // "task_complete" | "task_failed" | "ebay_sale" | etc.
  triggerRef: string;        // reference ID (task ID, order ID, etc.)
  description: string;       // human-readable: "Research HIPAA requirements"
  steps: EscalationStep[];
  currentStep: number;       // index of next step to send (0-based)
  triggeredAt: string;       // ISO timestamp
  acknowledgedAt?: string;   // ISO timestamp — user responded
  status: EscalationStatus;
  userId: string;
  chatId: number;
  context?: Record<string, string>; // extra data for message formatting
}

export interface EscalationFile {
  version: number;
  chains: EscalationChain[];
}
