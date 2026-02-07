import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { events, type BobEvent } from "./events.js";
import { runAgent } from "../agent/core.js";
import { getTasksForUser } from "../tasks/runner.js";
import { memory } from "../agent/memory.js";
import { startBot, stopBot, isBotRunning } from "../bot/telegram.js";

const OWNER_USER_ID = config.owner.userId;
const startTime = Date.now();

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

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
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
        const html = await readFile(htmlPath, "utf-8");
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

  // GET /api/status
  if (method === "GET" && url === "/api/status") {
    json(res, {
      name: config.agent.name,
      provider: config.llm.provider,
      model: config.llm.model,
      telegramConfigured: !!config.telegram.botToken,
      botRunning: isBotRunning(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
    return;
  }

  // GET /api/tasks
  if (method === "GET" && url === "/api/tasks") {
    const tasks = getTasksForUser(OWNER_USER_ID);
    json(res, tasks);
    return;
  }

  // GET /api/history
  if (method === "GET" && url === "/api/history") {
    const history = await memory.loadHistory(OWNER_USER_ID);
    json(res, history.slice(-20));
    return;
  }

  // GET /api/events — SSE stream
  if (method === "GET" && url === "/api/events") {
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
