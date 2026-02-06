export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface Task {
  id: string;
  userId: string;
  chatId: number;
  description: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  toolsUsed: string[];
  createdAt: string;
  completedAt?: string;
}
