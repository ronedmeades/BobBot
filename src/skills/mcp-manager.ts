/**
 * MCP Server Management Skill
 *
 * 6 owner-facing tools for managing MCP (Model Context Protocol) servers.
 * Lets Bob self-configure MCP servers via chat.
 */

import type { ToolDefinition } from "../providers/types.js";
import {
  addMcpServer,
  removeMcpServer,
  reconnectMcpServer,
  toggleMcpServer,
  listMcpServers,
  getMcpServer,
} from "../mcp/client.js";
import type { McpServerConfig } from "../mcp/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ─── Tool definitions ──────────────────────────────────────────────

export const mcpManagerToolDefinitions: ToolDefinition[] = [
  {
    name: "mcp_add_server",
    description:
      "Connect Bob to a new MCP (Model Context Protocol) server. Supports stdio (subprocess) and SSE (HTTP) transports. " +
      "The server's tools become available immediately with the prefix '{server_name}_'. " +
      "Example: adding server named 'github' makes its tools available as 'github_create_issue', etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Short unique name for this server (lowercase, no underscores). Used as tool prefix. Example: 'github', 'filesystem', 'brave-search'",
        },
        display_name: {
          type: "string",
          description: "Human-readable name (e.g. 'GitHub MCP Server')",
        },
        transport: {
          type: "string",
          enum: ["stdio", "sse"],
          description: "Transport type: 'stdio' for local subprocess, 'sse' for remote HTTP/SSE",
        },
        command: {
          type: "string",
          description: "For stdio: command to run (e.g. 'npx', 'node', 'python')",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "For stdio: command arguments (e.g. ['-y', '@modelcontextprotocol/server-filesystem', '/path'])",
        },
        env: {
          type: "object",
          description: "For stdio: environment variables for the subprocess (e.g. { GITHUB_PERSONAL_ACCESS_TOKEN: 'xxx' })",
          additionalProperties: { type: "string" },
        },
        url: {
          type: "string",
          description: "For SSE: the server URL (e.g. 'http://localhost:8080/sse')",
        },
        headers: {
          type: "object",
          description: "For SSE: HTTP headers (e.g. auth headers)",
          additionalProperties: { type: "string" },
        },
      },
      required: ["name", "transport"],
    },
  },
  {
    name: "mcp_remove_server",
    description: "Disconnect and remove an MCP server. Its tools will no longer be available.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name of the server to remove",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "mcp_list_servers",
    description: "List all configured MCP servers with their status, tool count, and connection info.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mcp_list_tools",
    description: "List all tools available from MCP servers. Optionally filter by server name.",
    input_schema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "Optional: list tools from a specific server only",
        },
      },
      required: [],
    },
  },
  {
    name: "mcp_reconnect",
    description: "Reconnect to an MCP server (or all servers if no name given). Useful after a server crash or network issue.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Server name to reconnect (omit for all servers)",
        },
      },
      required: [],
    },
  },
  {
    name: "mcp_toggle_server",
    description: "Enable or disable an MCP server without removing its configuration.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Server name to toggle",
        },
        enabled: {
          type: "boolean",
          description: "true to enable, false to disable",
        },
      },
      required: ["name", "enabled"],
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────

export async function handleMcpAddServer(input: Record<string, unknown>): Promise<ToolResult> {
  const name = input.name as string;
  const transport = input.transport as "stdio" | "sse";

  if (!name || !transport) {
    return { success: false, output: "name and transport are required" };
  }

  const config: McpServerConfig = {
    name,
    displayName: (input.display_name as string) ?? name,
    transport,
    command: input.command as string | undefined,
    args: input.args as string[] | undefined,
    env: input.env as Record<string, string> | undefined,
    url: input.url as string | undefined,
    headers: input.headers as Record<string, string> | undefined,
    enabled: true,
    autoConnect: true,
    addedAt: new Date().toISOString(),
  };

  // Validate transport-specific fields
  if (transport === "stdio" && !config.command) {
    return { success: false, output: "stdio transport requires a 'command' field (e.g. 'npx')" };
  }
  if (transport === "sse" && !config.url) {
    return { success: false, output: "sse transport requires a 'url' field" };
  }

  const result = await addMcpServer(config);

  if (result.success && result.tools) {
    const toolNames = result.tools.map((t) => t.prefixedName).join(", ");
    return {
      success: true,
      output: `Connected to "${config.displayName}"! ${result.tools.length} tools available:\n${toolNames}`,
    };
  }

  return { success: false, output: result.error ?? "Failed to connect" };
}

export async function handleMcpRemoveServer(input: Record<string, unknown>): Promise<ToolResult> {
  const name = input.name as string;
  if (!name) return { success: false, output: "name is required" };

  const removed = await removeMcpServer(name);
  if (removed) {
    return { success: true, output: `Server "${name}" removed and disconnected.` };
  }
  return { success: false, output: `Server "${name}" not found.` };
}

export async function handleMcpListServers(): Promise<ToolResult> {
  const all = listMcpServers();
  if (all.length === 0) {
    return {
      success: true,
      output: "No MCP servers configured. Use mcp_add_server to connect one.",
    };
  }

  const lines = all.map((s) => {
    const status = s.status === "connected" ? "connected" : s.status === "error" ? `error: ${s.error}` : s.status;
    const enabled = s.config.enabled ? "" : " [DISABLED]";
    return `- ${s.config.displayName} (${s.config.name})${enabled}\n  Status: ${status} | Tools: ${s.tools.length} | Transport: ${s.config.transport}${s.lastConnected ? ` | Last connected: ${s.lastConnected}` : ""}`;
  });

  return { success: true, output: `MCP Servers (${all.length}):\n${lines.join("\n")}` };
}

export async function handleMcpListTools(input: Record<string, unknown>): Promise<ToolResult> {
  const serverName = input.server as string | undefined;

  if (serverName) {
    const server = getMcpServer(serverName);
    if (!server) return { success: false, output: `Server "${serverName}" not found.` };
    if (server.tools.length === 0) {
      return { success: true, output: `Server "${serverName}" has no tools (status: ${server.status}).` };
    }
    const lines = server.tools.map((t) => `- ${t.prefixedName}: ${t.description}`);
    return { success: true, output: `Tools from "${serverName}" (${server.tools.length}):\n${lines.join("\n")}` };
  }

  // List all MCP tools
  const all = listMcpServers();
  const connectedServers = all.filter((s) => s.status === "connected" && s.tools.length > 0);

  if (connectedServers.length === 0) {
    return { success: true, output: "No MCP tools available. Connect a server with mcp_add_server." };
  }

  const sections = connectedServers.map((s) => {
    const tools = s.tools.map((t) => `  - ${t.prefixedName}: ${t.description}`).join("\n");
    return `${s.config.displayName} (${s.tools.length} tools):\n${tools}`;
  });

  const totalTools = connectedServers.reduce((sum, s) => sum + s.tools.length, 0);
  return { success: true, output: `MCP Tools (${totalTools} total):\n\n${sections.join("\n\n")}` };
}

export async function handleMcpReconnect(input: Record<string, unknown>): Promise<ToolResult> {
  const name = input.name as string | undefined;

  if (name) {
    const result = await reconnectMcpServer(name);
    if (result.success) {
      const server = getMcpServer(name);
      return { success: true, output: `Reconnected to "${name}" — ${server?.tools.length ?? 0} tools available.` };
    }
    return { success: false, output: result.error ?? "Reconnection failed" };
  }

  // Reconnect all
  const all = listMcpServers();
  const results: string[] = [];
  for (const server of all) {
    if (!server.config.enabled) continue;
    const result = await reconnectMcpServer(server.config.name);
    results.push(`${server.config.name}: ${result.success ? "connected" : result.error ?? "failed"}`);
  }

  return { success: true, output: `Reconnection results:\n${results.map((r) => `- ${r}`).join("\n")}` };
}

export async function handleMcpToggleServer(input: Record<string, unknown>): Promise<ToolResult> {
  const name = input.name as string;
  const enabled = input.enabled as boolean;

  if (!name || enabled === undefined) {
    return { success: false, output: "name and enabled are required" };
  }

  const result = await toggleMcpServer(name, enabled);
  if (result.success) {
    return { success: true, output: `Server "${name}" ${enabled ? "enabled" : "disabled"}.` };
  }
  return { success: false, output: result.error ?? "Toggle failed" };
}
