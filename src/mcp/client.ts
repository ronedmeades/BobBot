/**
 * MCP Client Manager
 *
 * Manages multiple MCP server connections, tool discovery, execution,
 * reconnection, and persistence. Uses the official @modelcontextprotocol/sdk.
 *
 * Tool naming: {serverName}_{originalToolName} to avoid collisions.
 * A Map<prefixedName, {server, originalName}> provides O(1) dispatch.
 */

import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolDefinition } from "../providers/types.js";
import type {
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  McpToolInfo,
  McpServersFile,
} from "./types.js";
import { events } from "../dashboard/events.js";

// ─── Internal state ────────────────────────────────────────────────

const servers = new Map<string, McpServerState>();
const clients = new Map<string, Client>();
const toolLookup = new Map<string, { server: string; originalName: string }>();

const CONFIG_PATH = resolve("memory/mcp-servers.json");
const MAX_RECONNECT_ATTEMPTS = 5;

// ─── Persistence ───────────────────────────────────────────────────

async function loadConfig(): Promise<McpServersFile> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as McpServersFile;
  } catch {
    return { version: 1, servers: [] };
  }
}

async function saveConfig(): Promise<void> {
  const configs: McpServerConfig[] = [];
  for (const state of servers.values()) {
    configs.push(state.config);
  }
  await mkdir(resolve("memory"), { recursive: true });
  await writeFile(
    CONFIG_PATH,
    JSON.stringify({ version: 1, servers: configs } satisfies McpServersFile, null, 2),
    "utf-8"
  );
}

// ─── Connection management ─────────────────────────────────────────

function createTransport(config: McpServerConfig): StdioClientTransport | SSEClientTransport {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("stdio transport requires a command");
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });
  } else {
    if (!config.url) throw new Error("sse transport requires a url");
    return new SSEClientTransport(new URL(config.url));
  }
}

function mapToolResult(result: {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): { success: boolean; output: string } {
  const success = !result.isError;
  const textParts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    }
  }
  const output = textParts.join("\n") || (success ? "(No output)" : "Tool call failed");
  return { success, output };
}

async function connectServer(config: McpServerConfig): Promise<void> {
  const { name } = config;

  // Update status
  const state = servers.get(name);
  if (state) state.status = "connecting";

  let client: Client;
  let transport: StdioClientTransport | SSEClientTransport;

  try {
    transport = createTransport(config);
    client = new Client({ name: "Bob", version: "1.0.0" });

    await client.connect(transport);
    clients.set(name, client);

    // Fetch tools
    const { tools } = await client.listTools();
    const toolInfos: McpToolInfo[] = [];

    // Remove old entries for this server
    for (const [prefixed, entry] of toolLookup) {
      if (entry.server === name) toolLookup.delete(prefixed);
    }

    for (const tool of tools) {
      const prefixedName = `${name}_${tool.name}`;
      toolInfos.push({
        serverName: name,
        originalName: tool.name,
        prefixedName,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      });
      toolLookup.set(prefixedName, { server: name, originalName: tool.name });
    }

    // Update state
    const newState: McpServerState = {
      config,
      status: "connected",
      tools: toolInfos,
      lastConnected: new Date().toISOString(),
      reconnectAttempts: 0,
    };
    servers.set(name, newState);

    // Listen for tool list changes
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        console.log(`[mcp] Server "${name}" reported tools changed — refreshing`);
        try {
          await refreshServerTools(name);
        } catch (err) {
          console.error(`[mcp] Failed to refresh tools for "${name}":`, err);
        }
      }
    );

    // Listen for transport close
    transport.onclose = () => {
      const current = servers.get(name);
      if (current && current.status === "connected") {
        console.log(`[mcp] Server "${name}" disconnected`);
        current.status = "disconnected";
        events.emitEvent("mcp:disconnect", { server: name });
        scheduleReconnect(name);
      }
    };

    transport.onerror = (err: Error) => {
      console.error(`[mcp] Server "${name}" error:`, err.message);
      const current = servers.get(name);
      if (current) {
        current.status = "error";
        current.error = err.message;
      }
      events.emitEvent("mcp:error", { server: name, error: err.message });
    };

    events.emitEvent("mcp:connect", { server: name, toolCount: toolInfos.length });
    console.log(`[mcp] Connected to "${config.displayName}" — ${toolInfos.length} tools`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] Failed to connect to "${name}": ${message}`);
    const current = servers.get(name) ?? {
      config,
      status: "error" as McpServerStatus,
      tools: [],
      reconnectAttempts: 0,
    };
    current.status = "error";
    current.error = message;
    servers.set(name, current);
    events.emitEvent("mcp:error", { server: name, error: message });
  }
}

async function disconnectServer(name: string): Promise<void> {
  const client = clients.get(name);
  if (client) {
    try {
      await client.close();
    } catch {
      // Best-effort cleanup
    }
    clients.delete(name);
  }

  // Remove tool entries
  for (const [prefixed, entry] of toolLookup) {
    if (entry.server === name) toolLookup.delete(prefixed);
  }

  const state = servers.get(name);
  if (state) {
    state.status = "disconnected";
    state.tools = [];
  }
}

async function refreshServerTools(name: string): Promise<void> {
  const client = clients.get(name);
  const state = servers.get(name);
  if (!client || !state) return;

  const { tools } = await client.listTools();
  const toolInfos: McpToolInfo[] = [];

  // Remove old entries
  for (const [prefixed, entry] of toolLookup) {
    if (entry.server === name) toolLookup.delete(prefixed);
  }

  for (const tool of tools) {
    const prefixedName = `${name}_${tool.name}`;
    toolInfos.push({
      serverName: name,
      originalName: tool.name,
      prefixedName,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    });
    toolLookup.set(prefixedName, { server: name, originalName: tool.name });
  }

  state.tools = toolInfos;
  events.emitEvent("mcp:tools_changed", { server: name, toolCount: toolInfos.length });

  // Rebuild global tool list
  const { refreshTools } = await import("../agent/tools.js");
  refreshTools();
}

// ─── Reconnection ──────────────────────────────────────────────────

const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleReconnect(name: string): void {
  const state = servers.get(name);
  if (!state || !state.config.enabled) return;
  if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log(`[mcp] Max reconnect attempts reached for "${name}" — giving up`);
    state.status = "error";
    state.error = "Max reconnect attempts reached";
    return;
  }

  state.reconnectAttempts++;
  const delay = Math.min(2000 * Math.pow(2, state.reconnectAttempts - 1), 60000);
  console.log(`[mcp] Reconnecting to "${name}" in ${delay / 1000}s (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  const timer = setTimeout(async () => {
    reconnectTimers.delete(name);
    await connectServer(state.config);
    if (state.status === "connected") {
      const { refreshTools } = await import("../agent/tools.js");
      refreshTools();
    }
  }, delay);

  reconnectTimers.set(name, timer);
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Initialize MCP clients from persistent config.
 * Connects to all enabled servers with autoConnect.
 */
export async function initMcpClients(): Promise<void> {
  const config = await loadConfig();
  if (config.servers.length === 0) return;

  console.log(`[mcp] Loading ${config.servers.length} server(s)...`);

  for (const serverConfig of config.servers) {
    servers.set(serverConfig.name, {
      config: serverConfig,
      status: "disconnected",
      tools: [],
      reconnectAttempts: 0,
    });

    if (serverConfig.enabled && serverConfig.autoConnect) {
      await connectServer(serverConfig);
    }
  }

  const connected = [...servers.values()].filter((s) => s.status === "connected");
  const totalTools = connected.reduce((sum, s) => sum + s.tools.length, 0);

  if (connected.length > 0) {
    console.log(`[mcp] ${connected.length} server(s) connected, ${totalTools} tools available`);
    // Rebuild global tool list to include MCP tools
    const { refreshTools } = await import("../agent/tools.js");
    refreshTools();
  }
}

/** Disconnect all MCP servers. */
export async function shutdownMcpClients(): Promise<void> {
  // Cancel pending reconnects
  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }
  reconnectTimers.clear();

  for (const name of [...clients.keys()]) {
    await disconnectServer(name);
  }
  servers.clear();
  toolLookup.clear();
}

/** Add and connect to a new MCP server. */
export async function addMcpServer(
  config: McpServerConfig
): Promise<{ success: boolean; error?: string; tools?: McpToolInfo[] }> {
  if (servers.has(config.name)) {
    return { success: false, error: `Server "${config.name}" already exists` };
  }

  // Validate name: lowercase alphanumeric + hyphens only
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.name)) {
    return {
      success: false,
      error: "Server name must be lowercase alphanumeric with hyphens (no underscores). Example: 'github', 'brave-search'",
    };
  }

  servers.set(config.name, {
    config,
    status: "disconnected",
    tools: [],
    reconnectAttempts: 0,
  });

  await connectServer(config);
  await saveConfig();

  const state = servers.get(config.name)!;
  if (state.status === "connected") {
    const { refreshTools } = await import("../agent/tools.js");
    refreshTools();
    return { success: true, tools: state.tools };
  }

  return { success: false, error: state.error ?? "Connection failed" };
}

/** Remove an MCP server and disconnect. */
export async function removeMcpServer(name: string): Promise<boolean> {
  if (!servers.has(name)) return false;

  // Cancel pending reconnect
  const timer = reconnectTimers.get(name);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(name);
  }

  await disconnectServer(name);
  servers.delete(name);
  await saveConfig();

  const { refreshTools } = await import("../agent/tools.js");
  refreshTools();
  return true;
}

/** Reconnect to a specific server. */
export async function reconnectMcpServer(
  name: string
): Promise<{ success: boolean; error?: string }> {
  const state = servers.get(name);
  if (!state) return { success: false, error: `Server "${name}" not found` };

  // Cancel pending reconnect
  const timer = reconnectTimers.get(name);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(name);
  }

  await disconnectServer(name);
  state.reconnectAttempts = 0;
  await connectServer(state.config);

  if (state.status === "connected") {
    const { refreshTools } = await import("../agent/tools.js");
    refreshTools();
    return { success: true };
  }
  return { success: false, error: state.error ?? "Reconnection failed" };
}

/** Toggle a server's enabled state. */
export async function toggleMcpServer(
  name: string,
  enabled: boolean
): Promise<{ success: boolean; error?: string }> {
  const state = servers.get(name);
  if (!state) return { success: false, error: `Server "${name}" not found` };

  state.config.enabled = enabled;

  if (!enabled && state.status === "connected") {
    await disconnectServer(name);
    const { refreshTools } = await import("../agent/tools.js");
    refreshTools();
  } else if (enabled && state.status === "disconnected") {
    await connectServer(state.config);
    // Re-fetch state since connectServer mutates it
    const updated = servers.get(name);
    if (updated?.status === "connected") {
      const { refreshTools } = await import("../agent/tools.js");
      refreshTools();
    }
  }

  await saveConfig();
  return { success: true };
}

/** List all MCP server states. */
export function listMcpServers(): McpServerState[] {
  return [...servers.values()];
}

/** Get a specific server state. */
export function getMcpServer(name: string): McpServerState | undefined {
  return servers.get(name);
}

/**
 * Get tool definitions for all connected MCP servers.
 * Maps MCP tool schemas to Bob's ToolDefinition format.
 */
export function getMcpToolDefinitions(): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  for (const state of servers.values()) {
    if (state.status !== "connected") continue;
    for (const tool of state.tools) {
      defs.push({
        name: tool.prefixedName,
        description: `[MCP:${tool.serverName}] ${tool.description}`,
        input_schema: tool.inputSchema as ToolDefinition["input_schema"],
      });
    }
  }
  return defs;
}

/**
 * Check if a tool name is an MCP tool (sync, O(1)).
 */
export function isMcpTool(name: string): boolean {
  return toolLookup.has(name);
}

/**
 * Execute an MCP tool by its prefixed name.
 */
export async function executeMcpTool(
  prefixedName: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; output: string }> {
  const entry = toolLookup.get(prefixedName);
  if (!entry) {
    return { success: false, output: `Unknown MCP tool: ${prefixedName}` };
  }

  const client = clients.get(entry.server);
  if (!client) {
    return { success: false, output: `MCP server "${entry.server}" is not connected` };
  }

  try {
    const result = await client.callTool({
      name: entry.originalName,
      arguments: args,
    });
    return mapToolResult(result as { content: Array<{ type: string; text?: string }>; isError?: boolean });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: `MCP tool error: ${message}` };
  }
}
