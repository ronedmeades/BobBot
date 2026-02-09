/**
 * MCP (Model Context Protocol) type definitions.
 */

/** Persistent config for an MCP server connection. */
export interface McpServerConfig {
  /** Unique key, used as tool name prefix (lowercase, no underscores). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Transport type: stdio (subprocess) or sse (HTTP/SSE). */
  transport: "stdio" | "sse";

  // stdio transport fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // SSE transport fields
  url?: string;
  headers?: Record<string, string>;

  enabled: boolean;
  /** Connect automatically on Bob startup (default: true). */
  autoConnect: boolean;
  addedAt: string;
}

export type McpServerStatus = "disconnected" | "connecting" | "connected" | "error";

/** Runtime state for a connected MCP server. */
export interface McpServerState {
  config: McpServerConfig;
  status: McpServerStatus;
  error?: string;
  tools: McpToolInfo[];
  lastConnected?: string;
  reconnectAttempts: number;
}

/** Info about a single tool from an MCP server. */
export interface McpToolInfo {
  serverName: string;
  originalName: string;
  /** The prefixed name used in Bob's tool system: serverName_toolName */
  prefixedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Persistence schema for memory/mcp-servers.json */
export interface McpServersFile {
  version: number;
  servers: McpServerConfig[];
}
