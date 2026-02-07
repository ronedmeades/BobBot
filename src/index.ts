import { config, validateConfig } from "./config.js";
import { createBot, startBot, stopBot } from "./bot/telegram.js";
import { memory } from "./agent/memory.js";
import { initTools } from "./agent/tools.js";
import { startScheduler, stopScheduler } from "./tasks/scheduler.js";
import { initTaskQueue } from "./tasks/queue.js";
import { startWorker, stopWorker, setWorkerNotifier } from "./tasks/worker.js";
import { initEscalation } from "./tasks/escalation.js";
import { startDashboard } from "./dashboard/server.js";
import { events } from "./dashboard/events.js";

async function main(): Promise<void> {
  console.log("Starting Bob...");

  validateConfig();
  await memory.init();
  await initTools();

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

  // Initialize persistent task queue + escalation engine + background worker
  await initTaskQueue();
  await initEscalation();
  startWorker();

  // Start scheduler (auto-backup, scheduled tasks, web monitors)
  await startScheduler();

  // Graceful shutdown
  const stop = () => {
    console.log("\nShutting down Bob...");
    stopWorker();
    stopScheduler();
    stopBot();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Bob is online. Provider: ${config.llm.provider}, Model: ${config.llm.model}`);

  // Start Telegram bot if configured, otherwise dashboard-only mode
  if (config.telegram.botToken) {
    createBot();
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
