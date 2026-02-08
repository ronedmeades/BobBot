/**
 * A2A HTTP Server
 *
 * Handles inbound A2A protocol requests:
 * - GET  /.well-known/agent.json — Agent Card (public discovery)
 * - POST /a2a — JSON-RPC 2.0 dispatch (authenticated)
 * - POST /a2a/handshake — Mutual discovery handshake
 * - GET  /a2a/ping — Lightweight presence check
 *
 * Integrates with the dashboard server via handleA2ARequest().
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { events } from "../dashboard/events.js";
import {
  getPeer,
  getPeerByToken,
  getPeerByUrl,
  registerPeer,
  checkRateLimit,
  checkBudget,
  recordRequest,
  recordCost,
  setTrustTier,
  listPeers,
} from "./registry.js";
import { logA2AEvent } from "./audit.js";
import {
  createApprovalRequest,
  setApprovalCallback,
  resolveApproval,
  getPendingApprovals,
  getApproval,
} from "./approvals.js";
import { createA2ATask, updateA2ATaskState, addMessageToTask, getA2ATask } from "./tasks.js";
import { executeSandboxed } from "./sandbox.js";
import { buildAgentCardSkills } from "./public-skills.js";
import type {
  A2ARequest,
  A2AResponse,
  A2AMessage,
  AgentCard,
  HandshakeRequest,
  HandshakeResponse,
  PeerAgent,
} from "./types.js";
import { A2A_ERRORS } from "./types.js";

// Anti-recursion guard
let handlingExternalRequest = false;

// Bob's agent ID (stable across restarts)
let agentId: string | null = null;
function getAgentId(): string {
  if (!agentId) {
    // Derive from public URL for stability, fall back to random
    agentId = config.a2a.publicUrl
      ? `bob-${Buffer.from(config.a2a.publicUrl).toString("base64url").slice(0, 12)}`
      : `bob-${randomUUID().slice(0, 8)}`;
  }
  return agentId;
}

// ─── Route Handler (called by dashboard server) ─────────────────────

/**
 * Handle A2A HTTP requests. Returns true if the request was handled.
 */
export async function handleA2ARequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "";
  const method = req.method?.toUpperCase() ?? "GET";

  // Agent Card
  if (method === "GET" && url === "/.well-known/agent.json") {
    if (config.a2a.discoveryMode === "private") {
      res.writeHead(404);
      res.end();
      return true;
    }
    serveAgentCard(res);
    return true;
  }

  // Presence ping
  if (method === "GET" && url === "/a2a/ping") {
    jsonResponse(res, {
      status: "online",
      name: config.a2a.agentName,
      agentId: getAgentId(),
    });
    return true;
  }

  // Handshake
  if (method === "POST" && url === "/a2a/handshake") {
    await handleHandshake(req, res);
    return true;
  }

  // JSON-RPC dispatch
  if (method === "POST" && url === "/a2a") {
    await handleJsonRpc(req, res);
    return true;
  }

  return false;
}

// ─── Agent Card ─────────────────────────────────────────────────────

function serveAgentCard(res: ServerResponse): void {
  const card: AgentCard = {
    id: getAgentId(),
    name: config.a2a.agentName,
    description: `${config.a2a.agentName} — an autonomous AI personal agent powered by Bob.`,
    url: config.a2a.publicUrl || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`,
    provider: {
      organization: "Bob Agent",
      url: "https://github.com/ronedmeades/BobBot",
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      multiTurn: true,
    },
    skills: buildAgentCardSkills(),
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
      },
    },
    security: [{ bearerAuth: [] }],
    version: "1.0.0",
  };

  jsonResponse(res, card);
}

// ─── JSON-RPC Dispatch ──────────────────────────────────────────────

async function handleJsonRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Body size limit
  const bodyStr = await readBodyLimited(req, config.a2a.maxRequestBodyBytes);
  if (bodyStr === null) {
    jsonRpcError(res, null, A2A_ERRORS.REQUEST_TOO_LARGE);
    return;
  }

  // Parse JSON-RPC
  let rpc: A2ARequest;
  try {
    rpc = JSON.parse(bodyStr) as A2ARequest;
  } catch {
    jsonRpcError(res, null, A2A_ERRORS.PARSE_ERROR);
    return;
  }

  if (rpc.jsonrpc !== "2.0" || !rpc.method || !rpc.id) {
    jsonRpcError(res, rpc?.id ?? null, A2A_ERRORS.INVALID_REQUEST);
    return;
  }

  // Authenticate — extract bearer token
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let peer = token ? await getPeerByToken(token) : null;

  // Unknown token handling based on discovery mode
  if (!peer) {
    if (config.a2a.discoveryMode === "private") {
      // Private mode: pretend endpoint doesn't exist
      res.writeHead(404);
      res.end();
      return;
    }
    if (config.a2a.discoveryMode === "handshake") {
      jsonRpcError(res, rpc.id, A2A_ERRORS.UNAUTHORIZED, "Complete handshake first");
      return;
    }
    // Open mode: we can't auto-register without an Agent Card.
    // The peer should use the handshake endpoint or discover first.
    jsonRpcError(res, rpc.id, A2A_ERRORS.UNAUTHORIZED, "Unknown peer — use handshake first");
    return;
  }

  // Check blocked
  if (peer.trustTier === "blocked" || peer.status === "blocked") {
    await logA2AEvent({
      direction: "inbound",
      peerId: peer.id,
      peerName: peer.name,
      method: rpc.method,
      approved: false,
      approvedBy: "rejected",
      estimatedCostUsd: 0,
      summary: "Blocked peer",
    });
    jsonRpcError(res, rpc.id, A2A_ERRORS.BLOCKED);
    return;
  }

  // Check rate limit
  if (!checkRateLimit(peer)) {
    await logA2AEvent({
      direction: "inbound",
      peerId: peer.id,
      peerName: peer.name,
      method: rpc.method,
      approved: false,
      approvedBy: "rejected",
      estimatedCostUsd: 0,
      summary: "Rate limited",
    });
    jsonRpcError(res, rpc.id, A2A_ERRORS.RATE_LIMITED);
    return;
  }

  // Record the request
  await recordRequest(peer);

  // Dispatch by method
  switch (rpc.method) {
    case "message/send":
      await handleMessageSend(rpc, res, peer);
      break;
    case "tasks/get":
      await handleTasksGet(rpc, res, peer);
      break;
    case "tasks/cancel":
      await handleTasksCancel(rpc, res, peer);
      break;
    default:
      jsonRpcError(res, rpc.id, A2A_ERRORS.METHOD_NOT_FOUND);
  }
}

// ─── message/send ───────────────────────────────────────────────────

async function handleMessageSend(
  rpc: A2ARequest,
  res: ServerResponse,
  peer: PeerAgent
): Promise<void> {
  const params = rpc.params ?? {};
  const message = params.message as A2AMessage | undefined;

  if (!message || !message.parts || message.parts.length === 0) {
    jsonRpcError(res, rpc.id, A2A_ERRORS.INVALID_PARAMS, "Missing message.parts");
    return;
  }

  const textParts = message.parts.filter((p) => p.text).map((p) => p.text!);
  const messageText = textParts.join("\n");
  const contextId = message.contextId ?? randomUUID();

  events.emitEvent("a2a:request", {
    peerId: peer.id,
    peerName: peer.name,
    method: "message/send",
    approved: false, // Updated below
  });

  // Trust tier decision
  if (peer.trustTier === "manual") {
    // Create approval request and return "input-required"
    const task = await createA2ATask(peer.id, contextId, message);
    await updateA2ATaskState(task.id, "input-required");

    await createApprovalRequest({
      type: "task",
      peerId: peer.id,
      peerName: peer.name,
      peerUrl: peer.url,
      method: "message/send",
      taskDescription: messageText.slice(0, 200),
    });

    await logA2AEvent({
      direction: "inbound",
      peerId: peer.id,
      peerName: peer.name,
      method: "message/send",
      taskId: task.id,
      approved: false,
      approvedBy: "rejected",
      estimatedCostUsd: 0,
      summary: `Awaiting approval: ${messageText.slice(0, 100)}`,
    });

    events.emitEvent("a2a:approval", {
      requestId: task.id,
      peerName: peer.name,
      description: messageText.slice(0, 100),
      status: "pending",
      type: "task",
    });

    jsonRpcResult(res, rpc.id, {
      id: task.id,
      contextId,
      state: "input-required",
      messages: [],
      artifacts: [],
    });
    return;
  }

  if (peer.trustTier === "budget-capped") {
    const budget = checkBudget(peer);
    if (!budget.allowed) {
      // Budget exhausted — fall back to manual behavior
      const task = await createA2ATask(peer.id, contextId, message);
      await updateA2ATaskState(task.id, "input-required");

      await createApprovalRequest({
        type: "task",
        peerId: peer.id,
        peerName: peer.name,
        peerUrl: peer.url,
        method: "message/send",
        taskDescription: `[Budget exhausted] ${messageText.slice(0, 150)}`,
      });

      jsonRpcResult(res, rpc.id, {
        id: task.id,
        contextId,
        state: "input-required",
        messages: [{ role: "agent", parts: [{ text: "Budget exhausted — owner approval required." }] }],
        artifacts: [],
      });
      return;
    }
  }

  // Anti-recursion check
  if (handlingExternalRequest) {
    jsonRpcError(res, rpc.id, A2A_ERRORS.RECURSIVE_FORWARDING);
    return;
  }

  // Execute in sandbox
  handlingExternalRequest = true;
  const task = await createA2ATask(peer.id, contextId, message);

  try {
    await updateA2ATaskState(task.id, "working");

    const result = await executeSandboxed(peer, messageText, task.id);

    // Record cost
    await recordCost(peer.id, result.estimatedCostUsd);

    // Update task
    await addMessageToTask(task.id, {
      role: "agent",
      parts: [{ text: result.text }],
    });
    await updateA2ATaskState(task.id, "completed");

    // Audit
    await logA2AEvent({
      direction: "inbound",
      peerId: peer.id,
      peerName: peer.name,
      method: "message/send",
      taskId: task.id,
      approved: true,
      approvedBy: "auto",
      estimatedCostUsd: result.estimatedCostUsd,
      durationMs: result.durationMs,
      summary: messageText.slice(0, 100),
    });

    events.emitEvent("a2a:response", {
      peerId: peer.id,
      taskId: task.id,
      state: "completed",
      costUsd: result.estimatedCostUsd,
    });

    jsonRpcResult(res, rpc.id, {
      id: task.id,
      contextId,
      state: "completed",
      messages: [
        message,
        { role: "agent", parts: [{ text: result.text }] },
      ],
      artifacts: [],
    });
  } catch (err) {
    await updateA2ATaskState(task.id, "failed");

    const errorMsg = err instanceof Error ? err.message : String(err);

    await logA2AEvent({
      direction: "inbound",
      peerId: peer.id,
      peerName: peer.name,
      method: "message/send",
      taskId: task.id,
      approved: true,
      approvedBy: "auto",
      estimatedCostUsd: 0,
      error: errorMsg,
      summary: `Failed: ${errorMsg.slice(0, 100)}`,
    });

    if (errorMsg.includes("timed out")) {
      jsonRpcError(res, rpc.id, A2A_ERRORS.TIMEOUT);
    } else {
      jsonRpcError(res, rpc.id, A2A_ERRORS.INTERNAL_ERROR, errorMsg);
    }
  } finally {
    handlingExternalRequest = false;
  }
}

// ─── tasks/get ──────────────────────────────────────────────────────

async function handleTasksGet(
  rpc: A2ARequest,
  res: ServerResponse,
  peer: PeerAgent
): Promise<void> {
  const taskId = rpc.params?.id as string;
  if (!taskId) {
    jsonRpcError(res, rpc.id, A2A_ERRORS.INVALID_PARAMS, "Missing id");
    return;
  }

  const task = await getA2ATask(taskId);
  if (!task || task.peerId !== peer.id) {
    jsonRpcError(res, rpc.id, A2A_ERRORS.INVALID_PARAMS, "Task not found");
    return;
  }

  jsonRpcResult(res, rpc.id, task);
}

// ─── tasks/cancel ───────────────────────────────────────────────────

async function handleTasksCancel(
  rpc: A2ARequest,
  res: ServerResponse,
  peer: PeerAgent
): Promise<void> {
  const taskId = rpc.params?.id as string;
  if (!taskId) {
    jsonRpcError(res, rpc.id, A2A_ERRORS.INVALID_PARAMS, "Missing id");
    return;
  }

  const task = await getA2ATask(taskId);
  if (!task || task.peerId !== peer.id) {
    jsonRpcError(res, rpc.id, A2A_ERRORS.INVALID_PARAMS, "Task not found");
    return;
  }

  await updateA2ATaskState(taskId, "canceled");
  jsonRpcResult(res, rpc.id, { id: taskId, state: "canceled" });
}

// ─── Handshake ──────────────────────────────────────────────────────

async function handleHandshake(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (config.a2a.discoveryMode === "private") {
    res.writeHead(404);
    res.end();
    return;
  }

  const bodyStr = await readBodyLimited(req, config.a2a.maxRequestBodyBytes);
  if (bodyStr === null) {
    jsonResponse(res, { accepted: false, error: "Request too large" } as HandshakeResponse, 413);
    return;
  }

  let hsReq: HandshakeRequest;
  try {
    hsReq = JSON.parse(bodyStr) as HandshakeRequest;
  } catch {
    jsonResponse(res, { accepted: false, error: "Invalid JSON" } as HandshakeResponse, 400);
    return;
  }

  if (!hsReq.agentCard || !hsReq.callbackUrl) {
    jsonResponse(res, { accepted: false, error: "Missing agentCard or callbackUrl" } as HandshakeResponse, 400);
    return;
  }

  // Check if already registered
  const existing = await getPeerByUrl(hsReq.agentCard.url ?? hsReq.callbackUrl);

  if (config.a2a.discoveryMode === "open") {
    // Auto-accept in open mode
    const peer = existing ?? await registerPeer(hsReq.agentCard, hsReq.callbackUrl, {
      ourTokenForThem: hsReq.token ?? "",
    });

    if (hsReq.token && !existing) {
      // Store the token they gave us to use with them
      const { updatePeer } = await import("./registry.js");
      await updatePeer(peer.id, { ourTokenForThem: hsReq.token });
    }

    events.emitEvent("a2a:peer", {
      peerId: peer.id,
      peerName: peer.name,
      action: "registered",
    });

    const response: HandshakeResponse = {
      accepted: true,
      agentCard: buildOurAgentCard(),
      token: peer.peerToken, // Token they should use with us
    };
    jsonResponse(res, response);
    return;
  }

  // Handshake mode — require owner approval
  if (existing && existing.status === "active") {
    // Already approved — refresh
    const response: HandshakeResponse = {
      accepted: true,
      agentCard: buildOurAgentCard(),
      token: existing.peerToken,
    };
    jsonResponse(res, response);
    return;
  }

  // Create approval request
  const pendingPeer = existing ?? await registerPeer(hsReq.agentCard, hsReq.callbackUrl, {
    trustTier: config.a2a.defaultTrustTier,
    ourTokenForThem: hsReq.token ?? "",
  });

  const { updatePeer } = await import("./registry.js");
  await updatePeer(pendingPeer.id, { status: "pending_handshake" });

  await createApprovalRequest({
    type: "handshake",
    peerId: pendingPeer.id,
    peerName: pendingPeer.name,
    peerUrl: hsReq.callbackUrl,
    method: "handshake",
    taskDescription: `Connection request from "${pendingPeer.name}"`,
    agentCard: hsReq.agentCard,
    callbackUrl: hsReq.callbackUrl,
  });

  events.emitEvent("a2a:peer", {
    peerId: pendingPeer.id,
    peerName: pendingPeer.name,
    action: "handshake_pending",
  });

  // Respond with pending — the peer should poll or wait for callback
  const response: HandshakeResponse = {
    accepted: false,
    error: "Handshake pending owner approval",
  };
  jsonResponse(res, response, 202);
}

function buildOurAgentCard(): AgentCard {
  return {
    id: getAgentId(),
    name: config.a2a.agentName,
    description: `${config.a2a.agentName} — an autonomous AI personal agent.`,
    url: config.a2a.publicUrl || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`,
    provider: { organization: "Bob Agent" },
    capabilities: { streaming: false, pushNotifications: false, multiTurn: true },
    skills: buildAgentCardSkills(),
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    security: [{ bearerAuth: [] }],
    version: "1.0.0",
  };
}

// ─── Approval Callback ─────────────────────────────────────────────

// Set up the callback for when approvals are resolved
// Called during init
export function initApprovalHandlers(): void {
  setApprovalCallback(async (request) => {
    if (request.status === "approved" && request.type === "handshake") {
      await completeHandshake(request.peerId, request.callbackUrl);
    }
    // Task approvals are handled by re-processing the original message
    // (future enhancement — for now, approved tasks need a re-send from the peer)
  });
}

async function completeHandshake(peerId: string, callbackUrl?: string): Promise<void> {
  const peer = await getPeer(peerId);
  if (!peer) return;

  const { updatePeer } = await import("./registry.js");
  await updatePeer(peerId, { status: "active" });

  // Call back to the peer with our Agent Card and their token
  if (callbackUrl) {
    try {
      const response = await fetch(`${callbackUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentCard: buildOurAgentCard(),
          callbackUrl: config.a2a.publicUrl
            ? `${config.a2a.publicUrl}/a2a/handshake`
            : undefined,
          token: peer.peerToken,
        } as HandshakeRequest),
      });

      if (response.ok) {
        const hsResp = await response.json() as HandshakeResponse;
        if (hsResp.token) {
          await updatePeer(peerId, { ourTokenForThem: hsResp.token });
        }
      }
    } catch (err) {
      console.error(`[a2a] Handshake callback to ${callbackUrl} failed:`, err);
    }
  }

  events.emitEvent("a2a:peer", {
    peerId: peer.id,
    peerName: peer.name,
    action: "registered",
  });

  console.log(`[a2a] Handshake completed with "${peer.name}"`);
}

// ─── Dashboard API helpers ──────────────────────────────────────────

/** For dashboard: list peers, audit, approvals */
export async function getDashboardPeers(): Promise<PeerAgent[]> {
  return listPeers();
}

export async function getDashboardApprovals(): Promise<import("./types.js").ApprovalRequest[]> {
  return getPendingApprovals();
}

export async function dashboardResolveApproval(
  id: string,
  decision: "approved" | "rejected"
): Promise<import("./types.js").ApprovalRequest | null> {
  return resolveApproval(id, decision);
}

// ─── HTTP Helpers ───────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function jsonRpcResult(res: ServerResponse, id: string | number | null, result: unknown): void {
  jsonResponse(res, { jsonrpc: "2.0", id, result });
}

function jsonRpcError(
  res: ServerResponse,
  id: string | number | null,
  error: { code: number; message: string },
  detail?: string
): void {
  jsonResponse(res, {
    jsonrpc: "2.0",
    id,
    error: { code: error.code, message: error.message, data: detail },
  });
}

async function readBodyLimited(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
