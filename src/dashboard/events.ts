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
  "agent:status": { userId: string; status: "thinking" | "tool_use" | "done"; detail?: string };
  "bot:status": { running: boolean };
  "worker:start": { taskId: string; step: number; description: string };
  "worker:progress": { taskId: string; step: number; findings: string; nextAction: string };
  "worker:idle": Record<string, never>;
  "worker:error": { taskId: string; error: string };
  "a2a:request": { peerId: string; peerName: string; method: string; approved: boolean };
  "a2a:response": { peerId: string; taskId: string; state: string; costUsd: number };
  "a2a:approval": { requestId: string; peerName: string; description: string; status: string; type: string };
  "a2a:peer": { peerId: string; peerName: string; action: string };
  "mcp:connect": { server: string; toolCount: number };
  "mcp:disconnect": { server: string; reason?: string };
  "mcp:error": { server: string; error: string };
  "mcp:tools_changed": { server: string; toolCount: number };
}

const BUFFER_SIZE = 50;

// Lazy-loaded SQLite event writer to avoid circular imports at module load time
let dbInsertEvent: ((type: string, data: Record<string, unknown>) => number | null) | null = null;
let dbLoadAttempted = false;

function getDbInsertEvent(): typeof dbInsertEvent {
  if (!dbLoadAttempted) {
    dbLoadAttempted = true;
    try {
      // Synchronous check — if db module is already loaded, grab the function
      // We schedule an async import that will populate on next tick
      import("../db/queries.js").then((mod) => {
        dbInsertEvent = mod.insertEvent;
      }).catch(() => {
        // SQLite not available
      });
    } catch {
      // Module not available
    }
  }
  return dbInsertEvent;
}

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

    // Persist to SQLite (if available)
    const persist = getDbInsertEvent();
    if (persist) {
      try {
        persist(type, data as Record<string, unknown>);
      } catch {
        // SQLite write failed — continue with in-memory only
      }
    }

    this.emit("event", event);
  }

  getRecentEvents(): BobEvent[] {
    return [...this.recentEvents];
  }
}

export const events = new BobEventBus();
