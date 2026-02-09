import { Bot, InputFile } from "grammy";
import { config } from "../config.js";
import { runAgent } from "../agent/core.js";
import { submitTask, setNotifier } from "../tasks/runner.js";
import { setSchedulerNotifier } from "../tasks/scheduler.js";
import { setWorkerNotifier } from "../tasks/worker.js";
import { recordUserInteraction } from "../tasks/escalation.js";
import { memory } from "../agent/memory.js";
import { events } from "../dashboard/events.js";

let bot: Bot | null = null;
let running = false;

function isOwner(fromId: number | undefined): boolean {
  if (!fromId) return false;
  return String(fromId) === config.owner.userId;
}

export function createBot(): Bot {
  bot = new Bot(config.telegram.botToken);

  // Wire up notifiers so background tasks and scheduler can message users
  const sendMessage = async (chatId: number, message: string): Promise<void> => {
    if (!bot) return;
    const chunks = splitMessage(message, 4000);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk);
    }
  };
  setNotifier(sendMessage);
  setSchedulerNotifier(sendMessage);
  setWorkerNotifier(sendMessage);

  // Owner check — ignore messages from non-owners
  bot.use(async (ctx, next) => {
    if (!isOwner(ctx.from?.id)) {
      console.log(`[security] Ignoring message from non-owner: ${ctx.from?.id}`);
      return; // Silently ignore
    }
    await next();
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

    const task = await submitTask(userId, chatId, description);
    await ctx.reply(
      `On it. I'll text you when I'm done.\n\nTask ID: ${task.id.slice(0, 8)}`
    );
  });

  // /approve command — approve a pending A2A request
  bot.command("approve", async (ctx) => {
    const id = ctx.match?.trim();
    if (!id) {
      await ctx.reply("Usage: /approve <request-id>");
      return;
    }
    try {
      const { resolveApproval } = await import("../a2a/approvals.js");
      const result = await resolveApproval(id, "approved");
      if (!result) {
        await ctx.reply(`Request "${id}" not found or already resolved.`);
        return;
      }
      await ctx.reply(`Approved ${result.type} from "${result.peerName}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${msg}`);
    }
  });

  // /reject command — reject a pending A2A request
  bot.command("reject", async (ctx) => {
    const id = ctx.match?.trim();
    if (!id) {
      await ctx.reply("Usage: /reject <request-id>");
      return;
    }
    try {
      const { resolveApproval } = await import("../a2a/approvals.js");
      const result = await resolveApproval(id, "rejected");
      if (!result) {
        await ctx.reply(`Request "${id}" not found or already resolved.`);
        return;
      }
      await ctx.reply(`Rejected ${result.type} from "${result.peerName}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${msg}`);
    }
  });

  // /trust command — approve AND set peer to Trusted tier
  bot.command("trust", async (ctx) => {
    const id = ctx.match?.trim();
    if (!id) {
      await ctx.reply("Usage: /trust <request-id>");
      return;
    }
    try {
      const { resolveApproval } = await import("../a2a/approvals.js");
      const { setTrustTier } = await import("../a2a/registry.js");
      const result = await resolveApproval(id, "approved");
      if (!result) {
        await ctx.reply(`Request "${id}" not found or already resolved.`);
        return;
      }
      await setTrustTier(result.peerId, "trusted");
      await ctx.reply(`Approved and trusted "${result.peerName}" — all future requests auto-approved.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${msg}`);
    }
  });

  // /status command — check on running tasks
  bot.command("status", async (ctx) => {
    const { getTasksForUser } = await import("../tasks/runner.js");
    const userId = String(ctx.from?.id ?? "unknown");
    const tasks = await getTasksForUser(userId);

    if (tasks.length === 0) {
      await ctx.reply("No tasks running. Send me something to do!");
      return;
    }

    const lines = tasks.slice(-5).map((t) => {
      const icon = t.status === "completed" ? "+" : t.status === "active" ? "~" : t.status === "failed" ? "x" : "-";
      return `[${icon}] ${t.description.slice(0, 60)} (${t.status})`;
    });

    await ctx.reply(`Recent tasks:\n\n${lines.join("\n")}`);
  });

  // Regular messages — direct conversation
  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const text = ctx.message.text;
    recordUserInteraction(userId);

    // Save chatId to profile so scheduler/proactive messages can reach the user
    const profile = await memory.loadProfile(userId);
    if (profile && profile.chatId !== ctx.chat.id) {
      profile.chatId = ctx.chat.id;
      await memory.saveProfile(profile);
    }

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

  // Voice messages — transcribe, process, reply with text + voice
  bot.on("message:voice", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    recordUserInteraction(userId);

    // Save chatId (same as text handler)
    const profile = await memory.loadProfile(userId);
    if (profile && profile.chatId !== ctx.chat.id) {
      profile.chatId = ctx.chat.id;
      await memory.saveProfile(profile);
    }

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);
    await ctx.replyWithChatAction("typing");

    try {
      const { transcribeVoice, synthesizeSpeech, isTranscriptionAvailable } =
        await import("../skills/voice.js");

      if (!isTranscriptionAvailable()) {
        clearInterval(typingInterval);
        await ctx.reply(
          "I can't process voice messages yet — I need an OpenAI API key for transcription. " +
          "Set OPENAI_API_KEY in .env (or set LLM_PROVIDER=openai to reuse LLM_API_KEY)."
        );
        return;
      }

      // Download voice file from Telegram
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const resp = await fetch(url);
      const oggBuffer = Buffer.from(await resp.arrayBuffer());

      // Transcribe
      const transcript = await transcribeVoice(oggBuffer);
      console.log(`[voice] Transcribed: "${transcript.slice(0, 100)}..."`);

      // Run through agent (same as text)
      const response = await runAgent(userId, transcript);
      clearInterval(typingInterval);

      // Always send text reply
      const chunks = splitMessage(response.text, 4000);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }

      // Also send voice reply (best-effort)
      try {
        const voiceBuffer = await synthesizeSpeech(response.text);
        await ctx.replyWithVoice(new InputFile(voiceBuffer, "response.ogg"));
      } catch (ttsErr) {
        console.error("[voice] TTS failed:", ttsErr);
        // Non-fatal — text reply already sent
      }
    } catch (err) {
      clearInterval(typingInterval);
      console.error("Voice agent error:", err);
      await ctx.reply("Had trouble with that voice message. Try again or send text instead.");
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
