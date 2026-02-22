/**
 * Shared busy state — prevents concurrent agent loops.
 * No dependencies to avoid circular imports.
 */

let busy = false;
let activeContext: "chat" | "worker" | null = null;
let preemptRequested = false;

export function getIsBusy(): boolean {
  return busy;
}

export function setIsBusy(b: boolean, context?: "chat" | "worker"): void {
  busy = b;
  activeContext = b ? (context ?? null) : null;
}

export function getActiveContext(): "chat" | "worker" | null {
  return activeContext;
}

/** Signal the worker to yield at the next opportunity. */
export function requestPreempt(): void {
  preemptRequested = true;
}

/** Check if a preemption was requested (used by worker in agent loop). */
export function isPreemptRequested(): boolean {
  return preemptRequested;
}

/** Clear the preemption flag (called after worker yields). */
export function clearPreempt(): void {
  preemptRequested = false;
}

// ---------------------------------------------------------------------------
// Current task tracking (lives here to avoid circular imports)
// ---------------------------------------------------------------------------

let currentTaskId: string | null = null;

export function setCurrentTaskId(id: string | null): void {
  currentTaskId = id;
}

export function getCurrentTaskId(): string | null {
  return currentTaskId;
}
