/**
 * A2A Client Skill — Owner-only tools for communicating with other agents.
 *
 * 8 tools:
 * - discover_agent: Fetch Agent Card from URL, initiate handshake
 * - send_to_agent: Send message to a known peer
 * - list_peers: List all peers with trust/presence info
 * - get_peer_details: Full details on a peer
 * - set_peer_trust: Change trust tier + budget/rate limit
 * - remove_peer: Remove peer from registry
 * - a2a_audit_log: View recent A2A activity
 * - approve_a2a_request: Approve/reject pending requests from chat
 */

import type { ToolDefinition } from "../providers/types.js";
import { config } from "../config.js";
import {
  registerPeer,
  getPeer,
  getPeerByUrl,
  listPeers,
  setTrustTier,
  removePeer,
  updatePeer,
} from "../a2a/registry.js";
import { getAuditLog, getAuditStats } from "../a2a/audit.js";
import { resolveApproval, getPendingApprovals } from "../a2a/approvals.js";
import type { AgentCard, TrustTier, HandshakeRequest, HandshakeResponse } from "../a2a/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

function requireA2AEnabled(): ToolResult | null {
  if (config.a2a.enabled) return null;
  return {
    success: false,
    output: "A2A is not enabled. Set A2A_ENABLED=true in .env and restart Bob.",
  };
}

// ─── Tool Definitions ────────────────────────────────────────────────

export const a2aClientToolDefinitions: ToolDefinition[] = [
  {
    name: "discover_agent",
    description:
      "Discover another agent by its URL. Fetches their Agent Card and initiates a connection. In handshake mode, sends a mutual handshake request. In open mode, auto-registers. Returns the peer's info and capabilities.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The base URL of the agent to discover (e.g. 'http://192.168.1.50:3000')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "send_to_agent",
    description:
      "Send a message or task request to a known peer agent. The peer must already be discovered and active. Returns the peer's response.",
    input_schema: {
      type: "object" as const,
      properties: {
        peer_id: {
          type: "string",
          description: "The peer's ID (from list_peers)",
        },
        message: {
          type: "string",
          description: "The message to send to the peer agent",
        },
      },
      required: ["peer_id", "message"],
    },
  },
  {
    name: "list_peers",
    description:
      "List all known peer agents with their trust tier, presence status, and activity summary.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_peer_details",
    description:
      "Get full details on a specific peer agent including skills, budget usage, rate limits, and recent audit entries.",
    input_schema: {
      type: "object" as const,
      properties: {
        peer_id: {
          type: "string",
          description: "The peer's ID",
        },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "set_peer_trust",
    description:
      "Change a peer's trust tier. Options: 'blocked' (reject all), 'manual' (require approval each time), 'trusted' (auto-approve all), 'budget-capped' (auto-approve up to a USD budget). Can also set budget cap and rate limit.",
    input_schema: {
      type: "object" as const,
      properties: {
        peer_id: {
          type: "string",
          description: "The peer's ID",
        },
        trust_tier: {
          type: "string",
          enum: ["blocked", "manual", "trusted", "budget-capped"],
          description: "The new trust tier",
        },
        budget_cap: {
          type: "number",
          description: "USD budget cap (only for budget-capped tier)",
        },
        rate_limit: {
          type: "number",
          description: "Max requests per hour (default: 10)",
        },
      },
      required: ["peer_id", "trust_tier"],
    },
  },
  {
    name: "remove_peer",
    description:
      "Remove a peer agent from the registry. They will need to re-discover to connect again.",
    input_schema: {
      type: "object" as const,
      properties: {
        peer_id: {
          type: "string",
          description: "The peer's ID to remove",
        },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "a2a_audit_log",
    description:
      "View the A2A activity audit log. Shows recent interactions with peer agents including costs, methods, and approval status.",
    input_schema: {
      type: "object" as const,
      properties: {
        peer_id: {
          type: "string",
          description: "Filter by peer ID (optional)",
        },
        limit: {
          type: "number",
          description: "Max entries to return (default: 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "approve_a2a_request",
    description:
      "Approve or reject a pending A2A request (task or handshake). Use list_peers or check notifications to find pending request IDs.",
    input_schema: {
      type: "object" as const,
      properties: {
        request_id: {
          type: "string",
          description: "The approval request ID",
        },
        decision: {
          type: "string",
          enum: ["approve", "reject"],
          description: "Whether to approve or reject the request",
        },
      },
      required: ["request_id", "decision"],
    },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────

export async function handleDiscoverAgent(input: Record<string, unknown>): Promise<ToolResult> {
  const disabled = requireA2AEnabled();
  if (disabled) return disabled;

  const baseUrl = (input.url as string).replace(/\/+$/, "");

  // Fetch Agent Card
  let card: AgentCard;
  try {
    const resp = await fetch(`${baseUrl}/.well-known/agent.json`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 404) {
      return { success: false, output: `Agent at ${baseUrl} is not discoverable (404 on Agent Card). They may be in private mode.` };
    }
    if (!resp.ok) {
      return { success: false, output: `Failed to fetch Agent Card: HTTP ${resp.status}` };
    }
    card = await resp.json() as AgentCard;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Could not reach agent at ${baseUrl}: ${msg}` };
  }

  // Check if already registered
  const existing = await getPeerByUrl(card.url ?? baseUrl);
  if (existing && existing.status === "active") {
    return {
      success: true,
      output: `Already connected to "${existing.name}" (${existing.id})\nTrust: ${existing.trustTier}\nSkills: ${card.skills?.map((s) => s.name).join(", ") || "none listed"}`,
    };
  }

  // Build our Agent Card for handshake
  const ourUrl = config.a2a.publicUrl || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`;

  // Try handshake
  try {
    const hsReq: HandshakeRequest = {
      agentCard: {
        id: `bob-local`,
        name: config.a2a.agentName,
        description: `${config.a2a.agentName} — an autonomous AI personal agent.`,
        url: ourUrl,
        provider: { organization: "Bob Agent" },
        capabilities: { streaming: false, pushNotifications: false, multiTurn: true },
        skills: [],
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        security: [{ bearerAuth: [] }],
        version: "1.0.0",
      },
      callbackUrl: `${ourUrl}/a2a/handshake`,
    };

    const hsResp = await fetch(`${baseUrl}/a2a/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hsReq),
      signal: AbortSignal.timeout(15_000),
    });

    const hsData = await hsResp.json() as HandshakeResponse;

    if (hsData.accepted) {
      // Handshake accepted — register peer
      const peer = existing ?? await registerPeer(card, baseUrl, {
        ourTokenForThem: hsData.token ?? "",
      });

      if (hsData.token && existing) {
        await updatePeer(existing.id, { ourTokenForThem: hsData.token });
      }

      return {
        success: true,
        output: `Connected to "${card.name}" (${peer.id})!\nTrust: ${peer.trustTier}\nSkills: ${card.skills?.map((s) => s.name).join(", ") || "none listed"}\nUse send_to_agent to start chatting.`,
      };
    } else {
      // Handshake pending or rejected
      const peer = existing ?? await registerPeer(card, baseUrl, {
        trustTier: config.a2a.defaultTrustTier,
      });

      return {
        success: true,
        output: `Handshake sent to "${card.name}" — awaiting their owner's approval.\nPeer ID: ${peer.id}\nStatus: pending_handshake\nYou'll be notified when they accept.`,
      };
    }
  } catch {
    // Handshake endpoint not available — register directly (open mode)
    const peer = existing ?? await registerPeer(card, baseUrl, {});

    return {
      success: true,
      output: `Discovered "${card.name}" (${peer.id})\nNote: Handshake not available — registered in open mode.\nSkills: ${card.skills?.map((s) => s.name).join(", ") || "none listed"}`,
    };
  }
}

export async function handleSendToAgent(input: Record<string, unknown>): Promise<ToolResult> {
  const disabled = requireA2AEnabled();
  if (disabled) return disabled;

  const peerId = input.peer_id as string;
  const message = input.message as string;

  const peer = await getPeer(peerId);
  if (!peer) {
    return { success: false, output: `Peer "${peerId}" not found. Use list_peers to see available peers.` };
  }

  if (peer.status !== "active") {
    return { success: false, output: `Peer "${peer.name}" is ${peer.status} — cannot send messages until they're active.` };
  }

  if (!peer.ourTokenForThem) {
    return { success: false, output: `No auth token for "${peer.name}". Re-discover the agent to establish authentication.` };
  }

  // Build JSON-RPC request
  const rpcRequest = {
    jsonrpc: "2.0",
    id: Date.now().toString(),
    method: "message/send",
    params: {
      message: {
        role: "user",
        parts: [{ text: message }],
      },
    },
  };

  try {
    const resp = await fetch(`${peer.url}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${peer.ourTokenForThem}`,
      },
      body: JSON.stringify(rpcRequest),
      signal: AbortSignal.timeout(90_000), // Give sandbox time to process
    });

    if (!resp.ok) {
      return { success: false, output: `HTTP ${resp.status} from "${peer.name}": ${await resp.text()}` };
    }

    const rpcResp = await resp.json() as { result?: Record<string, unknown>; error?: { message: string; code: number } };

    if (rpcResp.error) {
      return { success: false, output: `Error from "${peer.name}": [${rpcResp.error.code}] ${rpcResp.error.message}` };
    }

    const result = rpcResp.result;
    if (!result) {
      return { success: false, output: `Empty response from "${peer.name}"` };
    }

    // Extract response text
    const messages = result.messages as Array<{ role: string; parts: Array<{ text?: string }> }> | undefined;
    const agentMessages = messages?.filter((m) => m.role === "agent") ?? [];
    const responseText = agentMessages
      .flatMap((m) => m.parts.filter((p) => p.text).map((p) => p.text))
      .join("\n") || "(No text response)";

    const state = result.state as string;

    // Log outbound
    const { logA2AEvent } = await import("../a2a/audit.js");
    await logA2AEvent({
      direction: "outbound",
      peerId: peer.id,
      peerName: peer.name,
      method: "message/send",
      taskId: result.id as string,
      approved: true,
      approvedBy: "owner",
      estimatedCostUsd: 0,
      summary: message.slice(0, 100),
    });

    return {
      success: true,
      output: `Response from "${peer.name}" (state: ${state}):\n\n${responseText}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to reach "${peer.name}": ${msg}` };
  }
}

export async function handleListPeers(): Promise<ToolResult> {
  const disabled = requireA2AEnabled();
  if (disabled) return disabled;

  const peers = await listPeers();
  if (peers.length === 0) {
    return { success: true, output: "No peer agents connected yet. Use discover_agent to find other agents." };
  }

  const lines = peers.map((p) => {
    const budget = p.trustTier === "budget-capped"
      ? ` | Budget: $${p.budgetUsed.toFixed(2)}/$${(p.budgetCap ?? 0).toFixed(2)}`
      : "";
    const presence = p.presence ?? "unknown";
    return `- ${p.name} (${p.id})\n  Trust: ${p.trustTier} | Status: ${p.status} | Presence: ${presence}${budget}\n  URL: ${p.url} | Requests: ${p.totalRequests} | Cost: $${p.totalCostUsd.toFixed(4)}`;
  });

  return { success: true, output: `${peers.length} peer(s):\n\n${lines.join("\n\n")}` };
}

export async function handleGetPeerDetails(input: Record<string, unknown>): Promise<ToolResult> {
  const disabled = requireA2AEnabled();
  if (disabled) return disabled;

  const peerId = input.peer_id as string;
  const peer = await getPeer(peerId);
  if (!peer) {
    return { success: false, output: `Peer "${peerId}" not found.` };
  }

  const auditEntries = await getAuditLog({ peerId, limit: 10 });

  const details = [
    `Name: ${peer.name}`,
    `ID: ${peer.id}`,
    `Agent ID: ${peer.agentId}`,
    `URL: ${peer.url}`,
    `Status: ${peer.status}`,
    `Trust Tier: ${peer.trustTier}`,
    `Presence: ${peer.presence ?? "unknown"}`,
    `Rate Limit: ${peer.requestsThisHour}/${peer.rateLimitPerHour} per hour`,
    `Total Requests: ${peer.totalRequests}`,
    `Total Cost: $${peer.totalCostUsd.toFixed(4)}`,
    peer.trustTier === "budget-capped"
      ? `Budget: $${peer.budgetUsed.toFixed(2)} / $${(peer.budgetCap ?? 0).toFixed(2)}`
      : null,
    peer.skills?.length ? `Skills: ${peer.skills.join(", ")}` : null,
    peer.notes ? `Notes: ${peer.notes}` : null,
  ].filter(Boolean);

  const auditLines = auditEntries.length > 0
    ? `\nRecent activity:\n${auditEntries.map((e) => `  ${e.timestamp} | ${e.direction} | ${e.method} | ${e.approved ? "approved" : "rejected"} | ${e.summary}`).join("\n")}`
    : "\nNo recent activity.";

  return { success: true, output: details.join("\n") + auditLines };
}

export async function handleSetPeerTrust(input: Record<string, unknown>): Promise<ToolResult> {
  const disabled = requireA2AEnabled();
  if (disabled) return disabled;

  const peerId = input.peer_id as string;
  const tier = input.trust_tier as TrustTier;
  const budgetCap = input.budget_cap as number | undefined;
  const rateLimit = input.rate_limit as number | undefined;

  const peer = await getPeer(peerId);
  if (!peer) {
    return { success: false, output: `Peer "${peerId}" not found.` };
  }

  await setTrustTier(peerId, tier);

  const updates: Partial<typeof peer> = {};
  if (budgetCap !== undefined && tier === "budget-capped") {
    updates.budgetCap = budgetCap;
  }
  if (rateLimit !== undefined) {
    updates.rateLimitPerHour = rateLimit;
  }
  if (Object.keys(updates).length > 0) {
    await updatePeer(peerId, updates);
  }

  const extra = tier === "budget-capped" && budgetCap !== undefined
    ? ` with $${budgetCap} budget cap`
    : "";
  const rateLimitMsg = rateLimit !== undefined ? `, rate limit: ${rateLimit}/hr` : "";

  return {
    success: true,
    output: `"${peer.name}" trust tier set to ${tier}${extra}${rateLimitMsg}`,
  };
}

export async function handleRemovePeer(input: Record<string, unknown>): Promise<ToolResult> {
  const disabled = requireA2AEnabled();
  if (disabled) return disabled;

  const peerId = input.peer_id as string;
  const peer = await getPeer(peerId);
  if (!peer) {
    return { success: false, output: `Peer "${peerId}" not found.` };
  }

  await removePeer(peerId);
  return { success: true, output: `Removed peer "${peer.name}" (${peerId}). They'll need to re-discover to reconnect.` };
}

export async function handleA2AAuditLog(input: Record<string, unknown>): Promise<ToolResult> {
  const disabled = requireA2AEnabled();
  if (disabled) return disabled;

  const peerId = input.peer_id as string | undefined;
  const limit = (input.limit as number) ?? 20;

  const entries = await getAuditLog({ peerId, limit });
  const stats = await getAuditStats();

  if (entries.length === 0) {
    return { success: true, output: "No A2A activity recorded yet." };
  }

  const lines = entries.map((e) => {
    const cost = e.estimatedCostUsd > 0 ? ` | $${e.estimatedCostUsd.toFixed(4)}` : "";
    const duration = e.durationMs ? ` | ${e.durationMs}ms` : "";
    return `${e.timestamp} | ${e.direction} | ${e.peerName} | ${e.method} | ${e.approved ? "OK" : "DENIED"}${cost}${duration}\n  ${e.summary}`;
  });

  const totalReqs = stats.totalInbound + stats.totalOutbound;
  const header = `A2A Activity (${entries.length} entries, total cost: $${stats.totalCostUsd.toFixed(4)}, ${totalReqs} requests):\n`;
  return { success: true, output: header + lines.join("\n") };
}

export async function handleApproveA2ARequest(input: Record<string, unknown>): Promise<ToolResult> {
  const disabled = requireA2AEnabled();
  if (disabled) return disabled;

  const requestId = input.request_id as string;
  const decision = input.decision as "approve" | "reject";

  const result = await resolveApproval(requestId, decision === "approve" ? "approved" : "rejected");
  if (!result) {
    // Try pending list for better error message
    const pending = await getPendingApprovals();
    if (pending.length === 0) {
      return { success: false, output: "No pending approval requests found." };
    }
    const ids = pending.map((p) => `  ${p.id} — ${p.type} from "${p.peerName}": ${p.taskDescription}`).join("\n");
    return { success: false, output: `Request "${requestId}" not found. Pending requests:\n${ids}` };
  }

  return {
    success: true,
    output: `${decision === "approve" ? "Approved" : "Rejected"} ${result.type} request from "${result.peerName}" (${requestId})`,
  };
}
