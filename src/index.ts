import { config, validateConfig } from "./config.js";
import { createBot, startBot, stopBot } from "./bot/telegram.js";
import { memory } from "./agent/memory.js";
import { initTools } from "./agent/tools.js";
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

  // Create and start Telegram bot
  createBot();

  // Graceful shutdown
  const stop = () => {
    console.log("\nShutting down Bob...");
    stopBot();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Bob is online. Model: ${config.anthropic.model}`);
  console.log("Waiting for Telegram messages...");

  events.emitEvent("bot:status", { running: true });
  await startBot();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
