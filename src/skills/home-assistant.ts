import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { config } from "../config.js";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

interface HaService {
  domain: string;
  services: Record<string, { description: string; fields: Record<string, unknown> }>;
}

interface DeviceMonitor {
  id: string;
  entity_id: string;
  operator: "eq" | "neq" | "gt" | "lt" | "gte" | "lte";
  condition: string;
  message: string;
  created_at: string;
}

interface MonitorsFile {
  version: number;
  monitors: DeviceMonitor[];
}

// ---------------------------------------------------------------------------
// Configuration helper
// ---------------------------------------------------------------------------

function getHaConfig(): { url: string; token: string } {
  const url = config.homeAssistant.url;
  const token = config.homeAssistant.token;
  if (!token) {
    throw new Error(
      "Home Assistant not configured. Set HA_URL and HA_TOKEN in .env.\n" +
      "Generate a long-lived token: HA Settings > Users > Security."
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

// ---------------------------------------------------------------------------
// REST API helpers
// ---------------------------------------------------------------------------

async function haGet(path: string): Promise<unknown> {
  const { url, token } = getHaConfig();
  const response = await fetch(`${url}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HA API ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}

async function haPost(path: string, body?: unknown): Promise<unknown> {
  const { url, token } = getHaConfig();
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HA API ${response.status}: ${text || response.statusText}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// WebSocket — real-time state cache
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let wsMessageId = 0;
let wsConnecting = false;
let wsReconnectAttempts = 0;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsPingTimer: ReturnType<typeof setInterval> | null = null;

const pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const stateCache = new Map<string, EntityState>();
let stateCacheReady = false;

function nextWsId(): number {
  return ++wsMessageId;
}

async function connectWebSocket(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (wsConnecting) return;

  let haConfig: { url: string; token: string };
  try {
    haConfig = getHaConfig();
  } catch {
    return; // Not configured
  }

  wsConnecting = true;
  const wsUrl = haConfig.url.replace(/^http/, "ws") + "/api/websocket";

  return new Promise<void>((resolveConnect, rejectConnect) => {
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      wsConnecting = false;
      rejectConnect(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let authed = false;

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        const type = msg.type as string;

        if (type === "auth_required") {
          ws!.send(JSON.stringify({ type: "auth", access_token: haConfig.token }));
          return;
        }

        if (type === "auth_ok") {
          authed = true;
          wsConnecting = false;
          wsReconnectAttempts = 0;
          console.log("[ha] WebSocket connected");

          // Subscribe to state_changed events
          const subId = nextWsId();
          ws!.send(JSON.stringify({ id: subId, type: "subscribe_events", event_type: "state_changed" }));

          // Start keepalive pings
          if (wsPingTimer) clearInterval(wsPingTimer);
          wsPingTimer = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ id: nextWsId(), type: "ping" }));
            }
          }, 30_000);

          resolveConnect();
          return;
        }

        if (type === "auth_invalid") {
          wsConnecting = false;
          ws!.close();
          rejectConnect(new Error(`HA auth failed: ${msg.message ?? "invalid token"}`));
          return;
        }

        if (type === "result") {
          const id = msg.id as number;
          const pending = pendingRequests.get(id);
          if (pending) {
            pendingRequests.delete(id);
            if (msg.success) {
              pending.resolve(msg.result);
            } else {
              pending.reject(new Error(`HA WS error: ${JSON.stringify(msg.error)}`));
            }
          }
          return;
        }

        if (type === "event") {
          const eventData = msg.event as Record<string, unknown> | undefined;
          if (eventData) {
            const innerData = eventData.data as Record<string, unknown> | undefined;
            if (innerData?.new_state) {
              const newState = innerData.new_state as EntityState;
              stateCache.set(newState.entity_id, newState);
              stateCacheReady = true;
            }
          }
          return;
        }

        // pong — no action needed
      } catch {
        // Malformed message — ignore
      }
    });

    ws.addEventListener("close", () => {
      ws = null;
      stateCacheReady = false;
      if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
      if (authed) {
        scheduleReconnect();
      }
      if (wsConnecting) {
        wsConnecting = false;
        rejectConnect(new Error("HA WebSocket closed during auth"));
      }
    });

    ws.addEventListener("error", () => {
      console.error("[ha] WebSocket error");
      if (wsConnecting) {
        wsConnecting = false;
        rejectConnect(new Error("HA WebSocket connection error"));
      }
    });
  });
}

function scheduleReconnect(): void {
  if (wsReconnectAttempts >= 5) {
    console.log("[ha] WebSocket max reconnect attempts reached, using REST fallback");
    return;
  }
  const delay = Math.min(60_000, 2_000 * Math.pow(2, wsReconnectAttempts));
  wsReconnectAttempts++;
  console.log(`[ha] WebSocket reconnecting in ${delay / 1000}s (attempt ${wsReconnectAttempts}/5)`);
  wsReconnectTimer = setTimeout(() => {
    connectWebSocket().catch(() => {});
  }, delay);
}

async function sendWsCommand(type: string, data?: Record<string, unknown>): Promise<unknown> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not connected");
  }
  const id = nextWsId();
  return new Promise<unknown>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    ws!.send(JSON.stringify({ id, type, ...data }));
    // Timeout after 10s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("HA WebSocket command timeout"));
      }
    }, 10_000);
  });
}

/** Try to connect WebSocket silently — used by state-reading tools */
async function ensureWebSocket(): Promise<boolean> {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  try {
    await connectWebSocket();
    return true;
  } catch {
    return false;
  }
}

/** Shut down WebSocket — called on process exit */
export function shutdownHomeAssistant(): void {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
  if (ws) { ws.close(); ws = null; }
}

// ---------------------------------------------------------------------------
// Monitor persistence
// ---------------------------------------------------------------------------

const MEMORY_DIR = resolve("memory");
const MONITORS_FILE = join(MEMORY_DIR, "ha-monitors.json");

async function loadMonitors(): Promise<MonitorsFile> {
  try {
    const raw = await readFile(MONITORS_FILE, "utf-8");
    return JSON.parse(raw) as MonitorsFile;
  } catch {
    return { version: 1, monitors: [] };
  }
}

async function saveMonitors(data: MonitorsFile): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
  await writeFile(MONITORS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const homeAssistantToolDefinitions: ToolDefinition[] = [
  // --- Device Control ---
  {
    name: "ha_get_state",
    description:
      "Get the current state and attributes of a Home Assistant entity. " +
      "Returns state value, attributes (brightness, temperature, etc.), and last changed time.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_id: {
          type: "string",
          description: "Entity ID (e.g. 'light.living_room', 'switch.garage', 'climate.kitchen', 'sensor.temperature')",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "ha_get_all_states",
    description:
      "List all Home Assistant entities, optionally filtered by domain. " +
      "Groups entities by domain (light, switch, climate, sensor, etc.) with their current states.",
    input_schema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Filter by domain (e.g. 'light', 'switch', 'climate', 'sensor', 'binary_sensor', 'automation')",
        },
      },
      required: [],
    },
  },
  {
    name: "ha_call_service",
    description:
      "Call any Home Assistant service. This is the power tool for controlling devices. " +
      "Examples: light/turn_on with brightness, climate/set_temperature, media_player/play_media.",
    input_schema: {
      type: "object" as const,
      properties: {
        domain: { type: "string", description: "Service domain (light, switch, climate, media_player, etc.)" },
        service: { type: "string", description: "Service name (turn_on, turn_off, set_temperature, toggle, etc.)" },
        entity_id: { type: "string", description: "Target entity ID" },
        data: {
          type: "object",
          description: "Service data (e.g. {brightness: 200, color_temp: 2700} or {temperature: 22})",
        },
      },
      required: ["domain", "service"],
    },
  },
  {
    name: "ha_toggle",
    description: "Toggle an entity on/off. Works with lights, switches, fans, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_id: { type: "string", description: "Entity ID to toggle" },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "ha_set_state",
    description:
      "Quick convenience to turn a device on or off. " +
      "For more control (brightness, color, temperature) use ha_call_service instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_id: { type: "string", description: "Entity ID" },
        state: { type: "string", enum: ["on", "off"], description: "Desired state" },
      },
      required: ["entity_id", "state"],
    },
  },
  // --- Scenes & Automations ---
  {
    name: "ha_list_scenes",
    description: "List all available Home Assistant scenes.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ha_activate_scene",
    description: "Activate a Home Assistant scene (e.g. 'movie mode', 'bedtime', 'cooking').",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_id: { type: "string", description: "Scene entity ID (e.g. 'scene.movie_mode')" },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "ha_list_automations",
    description: "List all Home Assistant automations with their enabled/disabled status.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ha_toggle_automation",
    description: "Enable or disable a Home Assistant automation.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_id: { type: "string", description: "Automation entity ID (e.g. 'automation.motion_lights')" },
      },
      required: ["entity_id"],
    },
  },
  // --- Info & History ---
  {
    name: "ha_get_history",
    description:
      "Get state change history for an entity over a time period. " +
      "Useful for checking patterns (when did the door open last? temperature over the past day).",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_id: { type: "string", description: "Entity ID to get history for" },
        hours: { type: "number", description: "Hours of history to fetch (default: 24, max: 168)" },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "ha_get_services",
    description:
      "List available services for a domain. Useful for discovering what actions are available " +
      "(e.g. what can you do with 'climate' entities?).",
    input_schema: {
      type: "object" as const,
      properties: {
        domain: { type: "string", description: "Service domain (light, switch, climate, etc.)" },
      },
      required: ["domain"],
    },
  },
  {
    name: "ha_system_info",
    description: "Get Home Assistant system info: version, location, timezone, and loaded components.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  // --- Monitoring ---
  {
    name: "ha_watch_device",
    description:
      "Create a persistent monitoring rule. Bob will check the device state hourly and alert you " +
      "if the condition is met. Examples: door open too long, temperature above threshold, motion detected.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_id: { type: "string", description: "Entity ID to monitor" },
        operator: {
          type: "string",
          enum: ["eq", "neq", "gt", "lt", "gte", "lte"],
          description: "Comparison operator (eq=equals, neq=not equals, gt/lt/gte/lte for numeric)",
        },
        condition: { type: "string", description: "Value to compare against (e.g. 'on', 'open', '30')" },
        message: { type: "string", description: "Alert message (e.g. 'Front door has been open!')" },
      },
      required: ["entity_id", "operator", "condition", "message"],
    },
  },
  {
    name: "ha_list_watches",
    description: "List all active Home Assistant device monitors.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ha_remove_watch",
    description: "Remove a Home Assistant device monitor by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Monitor ID to remove" },
      },
      required: ["id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers — Device Control
// ---------------------------------------------------------------------------

export async function handleHaGetState(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const entityId = input.entity_id as string;

  try {
    // Try cache first
    if (stateCacheReady && stateCache.has(entityId)) {
      const cached = stateCache.get(entityId)!;
      return { success: true, output: formatEntityState(cached) };
    }

    // Attempt WS connection for future cache hits
    ensureWebSocket().catch(() => {});

    const state = await haGet(`/api/states/${entityId}`) as EntityState;
    return { success: true, output: formatEntityState(state) };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

export async function handleHaGetAllStates(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const domain = input.domain as string | undefined;

  try {
    // Attempt WS connection for future cache hits
    ensureWebSocket().catch(() => {});

    const states = await haGet("/api/states") as EntityState[];
    let filtered = states;
    if (domain) {
      filtered = states.filter((s) => s.entity_id.startsWith(`${domain}.`));
    }

    if (filtered.length === 0) {
      return { success: true, output: domain ? `No entities found in domain "${domain}".` : "No entities found." };
    }

    // Group by domain
    const groups = new Map<string, EntityState[]>();
    for (const s of filtered) {
      const d = s.entity_id.split(".")[0]!;
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d)!.push(s);
    }

    const lines: string[] = [];
    for (const [d, entities] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`\n${d.toUpperCase()} (${entities.length}):`);
      for (const e of entities.sort((a, b) => a.entity_id.localeCompare(b.entity_id))) {
        const friendly = (e.attributes.friendly_name as string) ?? "";
        const name = friendly ? ` — ${friendly}` : "";
        lines.push(`  ${e.entity_id}: ${e.state}${name}`);
      }
    }

    return { success: true, output: `${filtered.length} entities:${lines.join("\n")}` };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

export async function handleHaCallService(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const domain = input.domain as string;
  const service = input.service as string;
  const entityId = input.entity_id as string | undefined;
  const data = input.data as Record<string, unknown> | undefined;

  try {
    const payload: Record<string, unknown> = { ...data };
    if (entityId) payload.entity_id = entityId;

    const result = await haPost(`/api/services/${domain}/${service}`, payload);
    const affected = Array.isArray(result) ? (result as EntityState[]).length : 0;
    return {
      success: true,
      output: `Service ${domain}.${service} called successfully. ${affected > 0 ? `${affected} entity(s) affected.` : ""}`,
    };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

export async function handleHaToggle(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const entityId = input.entity_id as string;
  const domain = entityId.split(".")[0]!;

  try {
    await haPost(`/api/services/${domain}/toggle`, { entity_id: entityId });
    // Fetch new state
    const state = await haGet(`/api/states/${entityId}`) as EntityState;
    return { success: true, output: `Toggled ${entityId} → ${state.state}` };
  } catch (err) {
    // Fallback: some domains don't have toggle, try homeassistant.toggle
    try {
      await haPost("/api/services/homeassistant/toggle", { entity_id: entityId });
      const state = await haGet(`/api/states/${entityId}`) as EntityState;
      return { success: true, output: `Toggled ${entityId} → ${state.state}` };
    } catch {
      return { success: false, output: errMsg(err) };
    }
  }
}

export async function handleHaSetState(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const entityId = input.entity_id as string;
  const desired = input.state as string;
  const domain = entityId.split(".")[0]!;
  const service = desired === "on" ? "turn_on" : "turn_off";

  try {
    await haPost(`/api/services/${domain}/${service}`, { entity_id: entityId });
    return { success: true, output: `${entityId} turned ${desired}` };
  } catch (err) {
    // Fallback to homeassistant domain
    try {
      await haPost(`/api/services/homeassistant/${service}`, { entity_id: entityId });
      return { success: true, output: `${entityId} turned ${desired}` };
    } catch {
      return { success: false, output: errMsg(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers — Scenes & Automations
// ---------------------------------------------------------------------------

export async function handleHaListScenes(): Promise<ToolResult> {
  try {
    const states = await haGet("/api/states") as EntityState[];
    const scenes = states.filter((s) => s.entity_id.startsWith("scene."));

    if (scenes.length === 0) {
      return { success: true, output: "No scenes configured in Home Assistant." };
    }

    const lines = scenes
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
      .map((s) => {
        const name = (s.attributes.friendly_name as string) ?? s.entity_id;
        return `  ${s.entity_id} — ${name}`;
      });

    return { success: true, output: `${scenes.length} scene(s):\n${lines.join("\n")}` };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

export async function handleHaActivateScene(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const entityId = input.entity_id as string;

  try {
    await haPost("/api/services/scene/turn_on", { entity_id: entityId });
    return { success: true, output: `Scene activated: ${entityId}` };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

export async function handleHaListAutomations(): Promise<ToolResult> {
  try {
    const states = await haGet("/api/states") as EntityState[];
    const automations = states.filter((s) => s.entity_id.startsWith("automation."));

    if (automations.length === 0) {
      return { success: true, output: "No automations configured in Home Assistant." };
    }

    const lines = automations
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
      .map((s) => {
        const name = (s.attributes.friendly_name as string) ?? s.entity_id;
        const status = s.state === "on" ? "enabled" : "disabled";
        const lastTriggered = s.attributes.last_triggered as string | undefined;
        const triggered = lastTriggered ? ` (last: ${new Date(lastTriggered).toLocaleString()})` : "";
        return `  ${s.entity_id} — ${name} [${status}]${triggered}`;
      });

    return { success: true, output: `${automations.length} automation(s):\n${lines.join("\n")}` };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

export async function handleHaToggleAutomation(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const entityId = input.entity_id as string;

  try {
    await haPost("/api/services/automation/toggle", { entity_id: entityId });
    const state = await haGet(`/api/states/${entityId}`) as EntityState;
    const status = state.state === "on" ? "enabled" : "disabled";
    return { success: true, output: `Automation ${entityId} is now ${status}` };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

// ---------------------------------------------------------------------------
// Handlers — Info & History
// ---------------------------------------------------------------------------

export async function handleHaGetHistory(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const entityId = input.entity_id as string;
  const hours = Math.min(168, Math.max(1, (input.hours as number) ?? 24));

  try {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const data = await haGet(
      `/api/history/period/${since}?filter_entity_id=${entityId}&minimal_response`
    ) as EntityState[][];

    const entries = data[0] ?? [];
    if (entries.length === 0) {
      return { success: true, output: `No history for ${entityId} in the last ${hours} hours.` };
    }

    const lines = entries.slice(-50).map((e) => {
      const time = new Date(e.last_changed).toLocaleString();
      return `  ${time}: ${e.state}`;
    });

    const truncated = entries.length > 50 ? `\n  (showing last 50 of ${entries.length} entries)` : "";
    return {
      success: true,
      output: `History for ${entityId} (last ${hours}h, ${entries.length} changes):\n${lines.join("\n")}${truncated}`,
    };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

export async function handleHaGetServices(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const domain = input.domain as string;

  try {
    const services = await haGet("/api/services") as HaService[];
    const found = services.find((s) => s.domain === domain);

    if (!found) {
      const domains = services.map((s) => s.domain).sort().join(", ");
      return { success: false, output: `Domain "${domain}" not found. Available: ${domains}` };
    }

    const lines = Object.entries(found.services).map(([name, info]) => {
      const fields = Object.keys(info.fields ?? {});
      const fieldStr = fields.length > 0 ? ` (fields: ${fields.join(", ")})` : "";
      return `  ${domain}.${name}${fieldStr}\n    ${info.description || "No description"}`;
    });

    return {
      success: true,
      output: `Services for ${domain} (${Object.keys(found.services).length}):\n${lines.join("\n")}`,
    };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

export async function handleHaSystemInfo(): Promise<ToolResult> {
  try {
    const cfg = await haGet("/api/config") as Record<string, unknown>;
    const lines = [
      `Home Assistant`,
      `  Version: ${cfg.version ?? "unknown"}`,
      `  Name: ${cfg.location_name ?? "unknown"}`,
      `  Timezone: ${cfg.time_zone ?? "unknown"}`,
      `  Latitude: ${cfg.latitude ?? "?"}`,
      `  Longitude: ${cfg.longitude ?? "?"}`,
      `  Elevation: ${cfg.elevation ?? "?"}m`,
      `  Unit system: ${(cfg.unit_system as Record<string, unknown>)?.temperature ?? "unknown"}`,
      `  Components: ${Array.isArray(cfg.components) ? (cfg.components as string[]).length : "?"}`,
    ];
    return { success: true, output: lines.join("\n") };
  } catch (err) {
    return { success: false, output: errMsg(err) };
  }
}

// ---------------------------------------------------------------------------
// Handlers — Monitoring
// ---------------------------------------------------------------------------

export async function handleHaWatchDevice(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const monitor: DeviceMonitor = {
    id: generateId(),
    entity_id: input.entity_id as string,
    operator: input.operator as DeviceMonitor["operator"],
    condition: input.condition as string,
    message: input.message as string,
    created_at: new Date().toISOString(),
  };

  const data = await loadMonitors();
  data.monitors.push(monitor);
  await saveMonitors(data);

  return {
    success: true,
    output: `Monitor created: ${monitor.entity_id} ${monitor.operator} "${monitor.condition}"\nMessage: ${monitor.message}\nID: ${monitor.id}`,
  };
}

export async function handleHaListWatches(): Promise<ToolResult> {
  const data = await loadMonitors();

  if (data.monitors.length === 0) {
    return { success: true, output: "No active device monitors." };
  }

  const lines = data.monitors.map((m) =>
    `  ${m.entity_id} ${m.operator} "${m.condition}" — ${m.message} [${m.id}]`
  );

  return {
    success: true,
    output: `${data.monitors.length} monitor(s):\n${lines.join("\n")}`,
  };
}

export async function handleHaRemoveWatch(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const id = input.id as string;
  const data = await loadMonitors();
  const index = data.monitors.findIndex((m) => m.id === id);

  if (index === -1) {
    return { success: false, output: `Monitor not found: ${id}` };
  }

  const removed = data.monitors.splice(index, 1)[0]!;
  await saveMonitors(data);

  return { success: true, output: `Removed monitor for ${removed.entity_id}` };
}

// ---------------------------------------------------------------------------
// Scheduler — hourly monitor checks
// ---------------------------------------------------------------------------

/**
 * Check all device monitors and return alerts for conditions that are met.
 * Called by the hourly scheduler.
 */
export async function checkHomeAssistantMonitors(): Promise<string[]> {
  if (!config.homeAssistant.token) return [];

  const data = await loadMonitors();
  if (data.monitors.length === 0) return [];

  const alerts: string[] = [];

  for (const monitor of data.monitors) {
    try {
      // Try cache, fall back to REST
      let state: EntityState | undefined;
      if (stateCacheReady && stateCache.has(monitor.entity_id)) {
        state = stateCache.get(monitor.entity_id);
      } else {
        state = await haGet(`/api/states/${monitor.entity_id}`) as EntityState;
      }

      if (state && evaluateCondition(state.state, monitor.operator, monitor.condition)) {
        alerts.push(`${monitor.message}\n(${monitor.entity_id} is "${state.state}")`);
      }
    } catch {
      // Skip — HA might be unreachable
    }
  }

  return alerts;
}

function evaluateCondition(actual: string, operator: string, expected: string): boolean {
  switch (operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return parseFloat(actual) > parseFloat(expected);
    case "lt": return parseFloat(actual) < parseFloat(expected);
    case "gte": return parseFloat(actual) >= parseFloat(expected);
    case "lte": return parseFloat(actual) <= parseFloat(expected);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatEntityState(s: EntityState): string {
  const friendly = (s.attributes.friendly_name as string) ?? "";
  const name = friendly ? ` (${friendly})` : "";
  const lines = [`${s.entity_id}${name}: ${s.state}`];

  // Show key attributes
  const skip = new Set(["friendly_name", "icon", "entity_picture", "supported_features", "attribution"]);
  const attrs = Object.entries(s.attributes).filter(([k]) => !skip.has(k));
  if (attrs.length > 0) {
    for (const [key, value] of attrs.slice(0, 15)) {
      const val = typeof value === "object" ? JSON.stringify(value) : String(value);
      lines.push(`  ${key}: ${val}`);
    }
    if (attrs.length > 15) lines.push(`  ... and ${attrs.length - 15} more attributes`);
  }

  lines.push(`  Last changed: ${new Date(s.last_changed).toLocaleString()}`);
  return lines.join("\n");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
