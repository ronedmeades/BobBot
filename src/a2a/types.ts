/**
 * A2A (Agent-to-Agent) Communication Types
 *
 * Defines all interfaces for peer-to-peer agent communication
 * following the A2A protocol standard (JSON-RPC 2.0 over HTTP).
 */

// ─── Trust & Discovery ──────────────────────────────────────────────

export type TrustTier = "blocked" | "manual" | "trusted" | "budget-capped";

export type DiscoveryMode = "open" | "handshake" | "private";

export type PeerStatus = "pending_handshake" | "active" | "blocked";

export type PresenceStatus = "online" | "offline" | "unknown";

// ─── Peer Agent (Bob's internal representation of a known peer) ─────

export interface PeerAgent {
  id: string;                     // Internal UUID
  agentId: string;                // From their Agent Card
  name: string;                   // Human-readable name (from Agent Card)
  url: string;                    // Base URL (identity-pinned — peer IS this URL)
  description: string;            // From Agent Card
  skills: PeerSkill[];            // Advertised skills
  trustTier: TrustTier;           // Default: "manual"
  status: PeerStatus;             // Connection state
  presence: PresenceStatus;       // Last known online/offline state

  // Per-peer authentication
  peerToken: string;              // Unique token this peer uses to auth with us
  ourTokenForThem: string;        // Token we use to auth with them

  // Budget & rate limiting
  budgetCap?: number;             // USD cap for budget-capped tier
  budgetUsed: number;             // Running total of estimated API cost (USD)
  rateLimitPerHour: number;       // Max requests per hour (default: 10)
  requestsThisHour: number;       // Rolling counter
  lastHourReset: string;          // ISO timestamp of last counter reset

  // Stats
  firstSeen: string;              // ISO timestamp
  lastSeen: string;               // ISO timestamp
  lastRequestAt?: string;         // Last inbound request
  totalRequests: number;          // Lifetime inbound request count
  totalCostUsd: number;           // Lifetime estimated cost

  // Owner notes
  notes: string;
}

export interface PeerSkill {
  id: string;
  name: string;
  description: string;
}

// ─── A2A Protocol: Agent Card ───────────────────────────────────────

export interface AgentCard {
  id: string;
  name: string;
  description: string;
  url: string;
  provider: {
    organization: string;
    url?: string;
  };
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    multiTurn: boolean;
  };
  skills: AgentCardSkill[];
  securitySchemes: Record<string, SecurityScheme>;
  security: Array<Record<string, string[]>>;
  version: string;
}

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface SecurityScheme {
  type: "apiKey" | "http";
  scheme?: string;           // "bearer" for http type
  in?: string;               // "header" for apiKey
  name?: string;             // header name
}

// ─── A2A Protocol: JSON-RPC 2.0 ────────────────────────────────────

export interface A2ARequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2AResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: A2AError;
}

export interface A2AError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const A2A_ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
  // Custom A2A errors
  UNAUTHORIZED: { code: -32001, message: "Unauthorized" },
  RECURSIVE_FORWARDING: { code: -32002, message: "Recursive forwarding not allowed" },
  RATE_LIMITED: { code: -32003, message: "Rate limit exceeded" },
  BUDGET_EXCEEDED: { code: -32004, message: "Budget exceeded" },
  BLOCKED: { code: -32005, message: "Peer is blocked" },
  APPROVAL_REQUIRED: { code: -32006, message: "Owner approval required" },
  REQUEST_TOO_LARGE: { code: -32007, message: "Request body too large" },
  TIMEOUT: { code: -32008, message: "Request timed out" },
} as const;

// ─── A2A Protocol: Messages & Tasks ─────────────────────────────────

export type A2ATaskState =
  | "submitted" | "working" | "input-required"
  | "completed" | "failed" | "canceled" | "rejected";

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
}

export interface A2APart {
  text?: string;
  data?: string;            // base64
  mediaType?: string;
  uri?: string;
}

export interface A2ATask {
  id: string;
  contextId: string;
  state: A2ATaskState;
  messages: A2AMessage[];
  artifacts: A2AArtifact[];
  peerId: string;           // Which peer this task is for
  createdAt: string;
  updatedAt: string;
}

export interface A2AArtifact {
  id: string;
  name: string;
  description?: string;
  mediaType?: string;
  parts: A2APart[];
}

// ─── Audit Log ──────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: string;
  direction: "inbound" | "outbound";
  peerId: string;
  peerName: string;
  method: string;             // JSON-RPC method or "handshake"
  taskId?: string;
  approved: boolean;
  approvedBy: "auto" | "owner" | "rejected";
  estimatedCostUsd: number;
  durationMs?: number;
  error?: string;
  summary: string;            // One-line description
}

// ─── Approval Requests ──────────────────────────────────────────────

export type ApprovalType = "task" | "handshake";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  peerId: string;
  peerName: string;
  peerUrl: string;
  method: string;
  taskDescription: string;
  receivedAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  resolvedAt?: string;
  // For handshake approvals — store the peer's Agent Card
  agentCard?: AgentCard;
  callbackUrl?: string;
}

// ─── Handshake ──────────────────────────────────────────────────────

export interface HandshakeRequest {
  agentCard: AgentCard;
  callbackUrl: string;
  token?: string;             // Token the initiator provides for us to use
}

export interface HandshakeResponse {
  accepted: boolean;
  agentCard?: AgentCard;      // Our Agent Card (if accepted)
  token?: string;             // Token for the initiator to use with us
  error?: string;
}

// ─── Persistence File Schemas ───────────────────────────────────────

export interface A2APeersFile {
  version: number;
  peers: PeerAgent[];
}

export interface A2AAuditFile {
  version: number;
  entries: AuditEntry[];
}

export interface A2ATasksFile {
  version: number;
  tasks: A2ATask[];
}

export interface A2AApprovalsFile {
  version: number;
  requests: ApprovalRequest[];
}

// ─── Tool Result (matches Bob's standard) ───────────────────────────

export interface ToolResult {
  success: boolean;
  output: string;
}
