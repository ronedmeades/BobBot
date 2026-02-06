import { EventEmitter } from "node:events";

export interface BobEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface BobEventMap {
  "tool:call": { tool: string; input: unknown; userId: string };
  "tool:result": { tool: string; success: boolean; output: string };
  "message:in": { userId: string; text: string; source: "telegram" | "dashboard" };
  "message:out": { userId: string; text: string };
  "task:update": { taskId: string; status: string; description: string };
  "bot:status": { running: boolean };
}

const BUFFER_SIZE = 50;

class BobEventBus extends EventEmitter {
  private recentEvents: BobEvent[] = [];

  emitEvent<K extends keyof BobEventMap>(type: K, data: BobEventMap[K]): void {
    const event: BobEvent = {
      type,
      timestamp: new Date().toISOString(),
      data: data as Record<string, unknown>,
    };

    this.recentEvents.push(event);
    if (this.recentEvents.length > BUFFER_SIZE) {
      this.recentEvents.shift();
    }

    this.emit("event", event);
  }

  getRecentEvents(): BobEvent[] {
    return [...this.recentEvents];
  }
}

export const events = new BobEventBus();
