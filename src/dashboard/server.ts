import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { events, type BobEvent } from "./events.js";
import { runAgent } from "../agent/core.js";
import { getTasksForUser } from "../tasks/runner.js";
import { getTask, createTask, cancelTask, getAllTasks } from "../tasks/queue.js";
import { getCurrentTaskId } from "../tasks/worker.js";
import { getIsBusy, getActiveContext } from "../tasks/busy-state.js";
import { memory } from "../agent/memory.js";
import { startBot, stopBot, isBotRunning } from "../bot/telegram.js";
import { recordUserInteraction } from "../tasks/escalation.js";
import { config as appConfig } from "../config.js";

const OWNER_USER_ID = config.owner.userId;
const API_TOKEN = config.dashboard.apiToken;
const startTime = Date.now();

/**
 * Check Authorization: Bearer <token> header.
 * Returns true if authorized, false if rejected (and response already sent).
 */
function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_TOKEN) return true; // No token configured — allow (with console warning at startup)

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== API_TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized — set your API token" }));
    return false;
  }
  return true;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // A2A routes — checked BEFORE dashboard auth (different auth mechanism)
  if (appConfig.a2a.enabled) {
    const a2aPaths = ["/.well-known/agent.json", "/a2a/ping", "/a2a/handshake", "/a2a"];
    if (a2aPaths.some((p) => url === p || url.startsWith(p + "?"))) {
      const { handleA2ARequest } = await import("../a2a/server.js");
      const handled = await handleA2ARequest(req, res);
      if (handled) return;
    }
  }

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // GET / — serve dashboard HTML
  if (method === "GET" && url === "/") {
    // Try multiple paths: relative to this file (works in both src/ and dist/), then CWD
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(thisDir, "public", "index.html"),           // src/dashboard/public/ (dev mode)
      resolve("src", "dashboard", "public", "index.html"), // from CWD (compiled mode)
    ];

    let served = false;
    for (const htmlPath of candidates) {
      try {
        let html = await readFile(htmlPath, "utf-8");
        // Inject the API token server-side so the dashboard auto-authenticates
        if (API_TOKEN) {
          html = html.replace(
            "let apiToken = localStorage.getItem('bob_api_token') || '';",
            `let apiToken = ${JSON.stringify(API_TOKEN)};`,
          );
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        served = true;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!served) {
      error(res, "Dashboard HTML not found", 500);
    }
    return;
  }

  // Auth check for all /api/* routes (except SSE which handles its own auth via query param)
  if (url.startsWith("/api/") && !url.startsWith("/api/events")) {
    if (!checkAuth(req, res)) return;
  }

  // GET /api/status
  if (method === "GET" && url === "/api/status") {
    const secondary = config.secondaryLlm;
    json(res, {
      name: config.agent.name,
      provider: config.llm.provider,
      model: config.llm.model,
      secondaryProvider: secondary?.provider ?? null,
      secondaryModel: secondary?.model ?? null,
      costMode: config.costMode.default,
      telegramConfigured: !!config.telegram.botToken,
      botRunning: isBotRunning(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
    return;
  }

  // GET /api/tasks
  if (method === "GET" && url === "/api/tasks") {
    const tasks = await getTasksForUser(OWNER_USER_ID);
    json(res, tasks);
    return;
  }

  // GET /api/tasks/:id
  const taskIdMatch = url.match(/^\/api\/tasks\/([a-f0-9-]+)$/);
  if (method === "GET" && taskIdMatch) {
    const task = await getTask(taskIdMatch[1]);
    if (!task) {
      error(res, "Task not found", 404);
      return;
    }
    json(res, task);
    return;
  }

  // POST /api/tasks — create a background task
  if (method === "POST" && url === "/api/tasks") {
    try {
      const body = JSON.parse(await readBody(req)) as { description?: string; priority?: string };
      if (!body.description) {
        error(res, "Missing 'description' field");
        return;
      }
      const task = await createTask({
        userId: OWNER_USER_ID,
        description: body.description,
        priority: (body.priority as "low" | "normal" | "high" | "urgent") ?? "normal",
        createdBy: "dashboard",
      });
      json(res, task, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(res, msg, 500);
    }
    return;
  }

  // POST /api/tasks/:id/cancel
  const cancelMatch = url.match(/^\/api\/tasks\/([a-f0-9-]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    const task = await cancelTask(cancelMatch[1]);
    if (!task) {
      error(res, "Task not found", 404);
      return;
    }
    json(res, task);
    return;
  }

  // GET /api/worker/status
  if (method === "GET" && url === "/api/worker/status") {
    json(res, {
      busy: getIsBusy(),
      context: getActiveContext(),
      currentTaskId: getCurrentTaskId(),
    });
    return;
  }

  // GET /api/history
  if (method === "GET" && url === "/api/history") {
    const history = await memory.loadHistory(OWNER_USER_ID);
    json(res, history.slice(-20));
    return;
  }

  // GET /api/events — SSE stream (auth via query param since EventSource can't set headers)
  const eventsMatch = url.startsWith("/api/events");
  if (method === "GET" && eventsMatch) {
    // Check token from query param: /api/events?token=xxx
    if (API_TOKEN) {
      const reqUrl = new URL(url, `http://${req.headers.host ?? "localhost"}`);
      const qToken = reqUrl.searchParams.get("token");
      if (qToken !== API_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send recent events as initial burst
    const recent = events.getRecentEvents();
    for (const event of recent) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Stream new events
    const onEvent = (event: BobEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    events.on("event", onEvent);

    // Keep-alive ping every 15 seconds
    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    req.on("close", () => {
      events.off("event", onEvent);
      clearInterval(keepAlive);
    });
    return;
  }

  // POST /api/chat
  if (method === "POST" && url === "/api/chat") {
    try {
      const body = JSON.parse(await readBody(req)) as { message?: string };
      const message = body.message;
      if (!message || typeof message !== "string") {
        error(res, "Missing 'message' field");
        return;
      }

      recordUserInteraction(OWNER_USER_ID);
      const response = await runAgent(OWNER_USER_ID, message, "dashboard");
      json(res, { text: response.text, toolsUsed: response.toolsUsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(res, msg, 500);
    }
    return;
  }

  // POST /api/bot/start
  if (method === "POST" && url === "/api/bot/start") {
    if (!config.telegram.botToken) {
      error(res, "Telegram not configured. Add TELEGRAM_BOT_TOKEN to .env and restart Bob.");
      return;
    }
    if (isBotRunning()) {
      json(res, { status: "already_running" });
      return;
    }
    // Start bot in background (don't await — bot.start() blocks)
    startBot().catch((err) => {
      console.error("Failed to start bot:", err);
    });
    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 500));
    json(res, { status: "started" });
    return;
  }

  // POST /api/bot/stop
  if (method === "POST" && url === "/api/bot/stop") {
    if (!isBotRunning()) {
      json(res, { status: "already_stopped" });
      return;
    }
    stopBot();
    json(res, { status: "stopped" });
    return;
  }

  // GET /api/image?path=... — serve a local image file for inline chat display
  if (method === "GET" && url.startsWith("/api/image")) {
    const reqUrl = new URL(url, `http://${req.headers.host ?? "localhost"}`);

    // Auth: check header OR query param (img tags can't set headers)
    if (API_TOKEN) {
      const auth = req.headers.authorization;
      const qToken = reqUrl.searchParams.get("token");
      if ((!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== API_TOKEN) && qToken !== API_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const imagePath = reqUrl.searchParams.get("path");
    if (!imagePath) {
      error(res, "Missing 'path' parameter");
      return;
    }

    const resolved = resolve(imagePath);
    const ext = extname(resolved).toLowerCase();
    const ALLOWED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      error(res, "Not an allowed image type", 403);
      return;
    }

    try {
      const data = await readFile(resolved);
      const mimeMap: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
      };
      res.writeHead(200, {
        "Content-Type": mimeMap[ext] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(data);
    } catch {
      error(res, "Image not found", 404);
    }
    return;
  }

  // A2A dashboard API routes (behind dashboard auth)
  if (appConfig.a2a.enabled && url.startsWith("/api/a2a")) {
    if (!checkAuth(req, res)) return;

    const { getDashboardPeers, getDashboardApprovals, dashboardResolveApproval } =
      await import("../a2a/server.js");
    const { getAuditLog } = await import("../a2a/audit.js");

    if (method === "GET" && url === "/api/a2a/peers") {
      json(res, await getDashboardPeers());
      return;
    }
    if (method === "GET" && url === "/api/a2a/audit") {
      json(res, await getAuditLog());
      return;
    }
    if (method === "GET" && url === "/api/a2a/approvals") {
      json(res, await getDashboardApprovals());
      return;
    }

    const approveMatch = url.match(/^\/api\/a2a\/approvals\/([^/]+)\/(approve|reject)$/);
    if (method === "POST" && approveMatch) {
      const [, reqId, decision] = approveMatch;
      const result = await dashboardResolveApproval(
        reqId,
        decision === "approve" ? "approved" : "rejected"
      );
      if (!result) {
        error(res, "Approval not found or already resolved", 404);
        return;
      }
      json(res, result);
      return;
    }
  }

  // 404
  error(res, "Not found", 404);
}

export function startDashboard(port?: number): void {
  const p = port ?? (Number(process.env.DASHBOARD_PORT) || 3000);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Dashboard error:", err);
      if (!res.headersSent) {
        error(res, "Internal server error", 500);
      }
    });
  });

  server.listen(p, () => {
    console.log(`Dashboard: http://localhost:${p}`);
  });
}
