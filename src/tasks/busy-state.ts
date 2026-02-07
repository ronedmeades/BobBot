/**
 * Shared busy state — prevents concurrent agent loops.
 * No dependencies to avoid circular imports.
 */

let busy = false;
let activeContext: "chat" | "worker" | null = null;

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
