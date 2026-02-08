/**
 * A2A Approval Flow
 *
 * Manages owner approval requests for Manual-tier peers
 * and handshake connection requests.
 *
 * Integrates with Telegram for approve/reject notifications.
 * Persistence in memory/a2a-approvals.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type {
  ApprovalRequest,
  ApprovalStatus,
  ApprovalType,
  AgentCard,
  A2AApprovalsFile,
} from "./types.js";

const APPROVALS_PATH = resolve("memory", "a2a-approvals.json");
const CURRENT_VERSION = 1;

// Module-level state
let requests: ApprovalRequest[] = [];
let initialized = false;

// Telegram notifier — set by index.ts after bot starts
type NotifyFn = (chatId: number, message: string) => Promise<void>;
let notifyOwner: NotifyFn | null = null;

// Callback for when an approval is resolved — set by server.ts
type ApprovalCallback = (request: ApprovalRequest) => Promise<void>;
let onApprovalResolved: ApprovalCallback | null = null;

// ─── Persistence ────────────────────────────────────────────────────

async function loadApprovals(): Promise<void> {
  try {
    const raw = await readFile(APPROVALS_PATH, "utf-8");
    const data = JSON.parse(raw) as A2AApprovalsFile;
    requests = data.requests ?? [];
  } catch {
    requests = [];
  }
  initialized = true;
}

async function saveApprovals(): Promise<void> {
  await mkdir(resolve("memory"), { recursive: true });
  const data: A2AApprovalsFile = { version: CURRENT_VERSION, requests };
  await writeFile(APPROVALS_PATH, JSON.stringify(data, null, 2));
}

async function ensureLoaded(): Promise<void> {
  if (!initialized) await loadApprovals();
}

// ─── Public API ─────────────────────────────────────────────────────

export async function initApprovals(): Promise<void> {
  await ensureLoaded();
  const pending = requests.filter((r) => r.status === "pending").length;
  if (pending > 0) {
    console.log(`[a2a] ${pending} pending approval requests`);
  }
}

export function setApprovalNotifier(fn: NotifyFn): void {
  notifyOwner = fn;
}

export function setApprovalCallback(fn: ApprovalCallback): void {
  onApprovalResolved = fn;
}

export async function createApprovalRequest(opts: {
  type: ApprovalType;
  peerId: string;
  peerName: string;
  peerUrl: string;
  method: string;
  taskDescription: string;
  agentCard?: AgentCard;
  callbackUrl?: string;
}): Promise<ApprovalRequest> {
  await ensureLoaded();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.a2a.approvalTimeoutMin * 60 * 1000);

  const request: ApprovalRequest = {
    id: randomUUID().slice(0, 8), // Short ID for Telegram commands
    type: opts.type,
    peerId: opts.peerId,
    peerName: opts.peerName,
    peerUrl: opts.peerUrl,
    method: opts.method,
    taskDescription: opts.taskDescription,
    receivedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: "pending",
    agentCard: opts.agentCard,
    callbackUrl: opts.callbackUrl,
  };

  requests.push(request);
  await saveApprovals();

  // Notify owner via Telegram
  await notifyOwnerForApproval(request);

  return request;
}

export async function resolveApproval(
  id: string,
  decision: "approved" | "rejected"
): Promise<ApprovalRequest | null> {
  await ensureLoaded();

  const request = requests.find((r) => r.id === id && r.status === "pending");
  if (!request) return null;

  request.status = decision;
  request.resolvedAt = new Date().toISOString();
  await saveApprovals();

  // Trigger callback (server.ts handles execution of approved requests)
  if (onApprovalResolved) {
    try {
      await onApprovalResolved(request);
    } catch (err) {
      console.error(`[a2a] Error in approval callback:`, err);
    }
  }

  return request;
}

export async function getApproval(id: string): Promise<ApprovalRequest | null> {
  await ensureLoaded();
  return requests.find((r) => r.id === id) ?? null;
}

export async function getPendingApprovals(): Promise<ApprovalRequest[]> {
  await ensureLoaded();
  return requests.filter((r) => r.status === "pending");
}

export async function expireOldApprovals(): Promise<number> {
  await ensureLoaded();

  const now = Date.now();
  let expired = 0;

  for (const request of requests) {
    if (request.status === "pending" && new Date(request.expiresAt).getTime() < now) {
      request.status = "expired";
      request.resolvedAt = new Date().toISOString();
      expired++;
    }
  }

  if (expired > 0) {
    await saveApprovals();
  }

  // Clean up old resolved requests (> 7 days)
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const before = requests.length;
  requests = requests.filter(
    (r) => r.status === "pending" || new Date(r.resolvedAt ?? r.receivedAt).getTime() > cutoff
  );
  if (requests.length < before) {
    await saveApprovals();
  }

  return expired;
}

// ─── Telegram Notification ──────────────────────────────────────────

async function notifyOwnerForApproval(request: ApprovalRequest): Promise<void> {
  if (!notifyOwner) {
    console.log(`[a2a] No notifier set — approval ${request.id} pending (check dashboard)`);
    return;
  }

  // Get owner's chatId from profile
  const { memory } = await import("../agent/memory.js");
  const profile = await memory.loadProfile(config.owner.userId);
  if (!profile || !profile.chatId) {
    console.log(`[a2a] Owner chatId not found — approval ${request.id} pending (check dashboard)`);
    return;
  }

  let message: string;

  if (request.type === "handshake") {
    message = [
      `🤝 New Bob wants to connect:`,
      `"${request.peerName}" at ${request.peerUrl}`,
      ``,
      `/approve ${request.id} — accept connection`,
      `/reject ${request.id} — decline`,
      `/trust ${request.id} — accept and auto-approve all future requests`,
      ``,
      `Expires in ${config.a2a.approvalTimeoutMin} minutes.`,
    ].join("\n");
  } else {
    message = [
      `📨 Incoming A2A request from "${request.peerName}":`,
      `"${request.taskDescription.slice(0, 200)}"`,
      ``,
      `/approve ${request.id} — process this request`,
      `/reject ${request.id} — decline`,
      `/trust ${request.id} — approve and trust this Bob for all future requests`,
      ``,
      `Expires in ${config.a2a.approvalTimeoutMin} minutes.`,
    ].join("\n");
  }

  try {
    await notifyOwner(profile.chatId, message);
  } catch (err) {
    console.error(`[a2a] Failed to notify owner:`, err);
  }
}
