import { config, validateConfig } from "./config.js";
import { createBot, startBot, stopBot } from "./bot/telegram.js";
import { memory } from "./agent/memory.js";
import { initTools } from "./agent/tools.js";
import { startScheduler, stopScheduler } from "./tasks/scheduler.js";
import { initTaskQueue } from "./tasks/queue.js";
import { startWorker, stopWorker, setWorkerNotifier } from "./tasks/worker.js";
import { initEscalation } from "./tasks/escalation.js";
import { initMarketplaceAdapters } from "./marketplace/registry.js";
import { startDashboard } from "./dashboard/server.js";
import { events } from "./dashboard/events.js";

async function main(): Promise<void> {
  console.log("Starting Bob...");

  validateConfig();
  await memory.init();
  await memory.initOwnerContext(config.owner.name);

  // Initialize SQLite database (before tools, so dual-write is ready)
  const { initDb } = await import("./db/database.js");
  await initDb();

  // Import existing JSON data into SQLite on first run
  const { importExistingData, importPhase3Data } = await import("./db/import.js");
  await importExistingData();
  await importPhase3Data();

  await initTools();

  // Initialize knowledge plugins (Anthropic format, keyword-indexed)
  const { initPlugins } = await import("./agent/plugin-loader.js");
  await initPlugins();

  // Seed owner's profile if it doesn't exist yet
  const ownerId = config.owner.userId;
  const existing = await memory.loadProfile(ownerId);
  if (!existing) {
    await memory.saveProfile({
      userId: ownerId,
      name: config.owner.name,
      chatId: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      preferences: {},
      notes: config.owner.notes,
    });
    console.log(`Seeded profile for ${config.owner.name}`);
  }

  // Start dashboard HTTP server
  startDashboard();

  // Initialize persistent task queue + escalation engine + marketplace + background worker
  await initTaskQueue();
  await initEscalation();
  await initMarketplaceAdapters();

  // Initialize MCP clients (connects to configured servers)
  const { initMcpClients } = await import("./mcp/client.js");
  await initMcpClients();

  // Initialize A2A (Agent-to-Agent) if enabled
  if (config.a2a.enabled) {
    const { initPeerRegistry } = await import("./a2a/registry.js");
    const { initAudit } = await import("./a2a/audit.js");
    const { initApprovals } = await import("./a2a/approvals.js");
    const { initA2ATasks } = await import("./a2a/tasks.js");
    const { initApprovalHandlers } = await import("./a2a/server.js");

    await initPeerRegistry();
    await initAudit();
    await initApprovals();
    await initA2ATasks();
    initApprovalHandlers();

    const url = config.a2a.publicUrl || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`;
    console.log(`A2A: ${config.a2a.discoveryMode} mode | ${url}/.well-known/agent.json`);
  }

  startWorker();

  // Start scheduler (auto-backup, scheduled tasks, web monitors)
  await startScheduler();

  // Graceful shutdown
  const stop = () => {
    console.log("\nShutting down Bob...");
    stopWorker();
    stopScheduler();
    import("./mcp/client.js").then((m) => m.shutdownMcpClients()).catch(() => {});
    import("./skills/home-assistant.js").then((m) => m.shutdownHomeAssistant()).catch(() => {});
    import("./db/database.js").then((m) => m.closeDb()).catch(() => {});
    stopBot();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Bob is online. Provider: ${config.llm.provider}, Model: ${config.llm.model}`);

  // Start Telegram bot if configured, otherwise dashboard-only mode
  if (config.telegram.botToken) {
    createBot();

    // Wire A2A approval notifier to Telegram
    if (config.a2a.enabled) {
      const { getBot } = await import("./bot/telegram.js");
      const { setApprovalNotifier } = await import("./a2a/approvals.js");
      const tgBot = getBot();
      if (tgBot) {
        setApprovalNotifier(async (chatId: number, message: string) => {
          await tgBot.api.sendMessage(chatId, message);
        });
      }
    }

    events.emitEvent("bot:status", { running: true });
    console.log("Telegram connected. Waiting for messages...");
    await startBot();
  } else {
    console.log("Chat with Bob at http://localhost:3000");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
