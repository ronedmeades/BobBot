import { Bot } from "grammy";
import { config } from "../config.js";
import { runAgent } from "../agent/core.js";
import { submitTask, setNotifier } from "../tasks/runner.js";
import { events } from "../dashboard/events.js";

let bot: Bot | null = null;
let running = false;

export function createBot(): Bot {
  bot = new Bot(config.telegram.botToken);

  // Wire up the notifier so background tasks can message the user
  setNotifier(async (chatId: number, message: string) => {
    if (!bot) return;
    const chunks = splitMessage(message, 4000);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk);
    }
  });

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hey! I'm Bob, your AI agent. Send me a message and I'll get to work.\n\n" +
      "For quick questions, just type normally.\n" +
      "For bigger tasks, start with /task and I'll work on it in the background and text you when I'm done."
    );
  });

  // /task command — runs autonomously in the background
  bot.command("task", async (ctx) => {
    const description = ctx.match;
    if (!description) {
      await ctx.reply("Tell me what to do! Example:\n/task explore https://api.example.com and tell me what endpoints are available");
      return;
    }

    const userId = String(ctx.from?.id ?? "unknown");
    const chatId = ctx.chat.id;

    const task = submitTask(userId, chatId, description);
    await ctx.reply(
      `On it. I'll text you when I'm done.\n\nTask ID: ${task.id.slice(0, 8)}`
    );
  });

  // /status command — check on running tasks
  bot.command("status", async (ctx) => {
    const { getTasksForUser } = await import("../tasks/runner.js");
    const userId = String(ctx.from?.id ?? "unknown");
    const tasks = getTasksForUser(userId);

    if (tasks.length === 0) {
      await ctx.reply("No tasks running. Send me something to do!");
      return;
    }

    const lines = tasks.slice(-5).map((t) => {
      const icon = t.status === "completed" ? "+" : t.status === "running" ? "~" : t.status === "failed" ? "x" : "-";
      return `[${icon}] ${t.description.slice(0, 60)} (${t.status})`;
    });

    await ctx.reply(`Recent tasks:\n\n${lines.join("\n")}`);
  });

  // Regular messages — direct conversation
  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const text = ctx.message.text;

    // Keep typing indicator alive every 4 seconds until the agent is done
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);
    await ctx.replyWithChatAction("typing");

    try {
      const response = await runAgent(userId, text);
      clearInterval(typingInterval);

      const chunks = splitMessage(response.text, 4000);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } catch (err) {
      clearInterval(typingInterval);
      console.error("Agent error:", err);
      await ctx.reply("Something went wrong on my end. Give me a sec and try again.");
    }
  });

  return bot;
}

export async function startBot(): Promise<void> {
  if (!bot) {
    createBot();
  }
  if (running) return;

  running = true;
  events.emitEvent("bot:status", { running: true });
  console.log("Telegram bot started");
  await bot!.start();
}

export function stopBot(): void {
  if (!running || !bot) return;
  bot.stop();
  running = false;
  events.emitEvent("bot:status", { running: false });
  console.log("Telegram bot stopped");
}

export function isBotRunning(): boolean {
  return running;
}

export function getBot(): Bot | null {
  return bot;
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Fall back to splitting at a space
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt === -1) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
