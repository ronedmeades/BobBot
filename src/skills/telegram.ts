import type { ToolDefinition } from "../providers/types.js";
import { config } from "../config.js";
import { getBot } from "../bot/telegram.js";

interface ToolResult {
  success: boolean;
  output: string;
}

export const telegramToolDefinitions: ToolDefinition[] = [
  {
    name: "send_telegram_message",
    description:
      "Send a Telegram message to the configured owner chat immediately. " +
      "Use this when the user asks you to send/message/text them on Telegram right now. " +
      "Requires TELEGRAM_BOT_TOKEN and OWNER_USER_ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The Telegram message to send.",
        },
      },
      required: ["message"],
    },
  },
];

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter(Boolean);
}

export async function handleSendTelegramMessage(input: Record<string, unknown>): Promise<ToolResult> {
  const message = String(input.message ?? "").trim();
  if (!message) {
    return { success: false, output: "Message is required." };
  }

  if (!config.telegram.botToken) {
    return {
      success: false,
      output: "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and restart Bob.",
    };
  }

  const chatId = Number(config.owner.userId);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return {
      success: false,
      output: "OWNER_USER_ID is not a valid Telegram chat ID. Set it first and restart Bob.",
    };
  }

  const bot = getBot();
  if (!bot) {
    return {
      success: false,
      output: "Telegram bot is not running. Restart Bob and try again.",
    };
  }

  const chunks = splitMessage(message, 4000);
  for (const chunk of chunks) {
    await bot.api.sendMessage(chatId, chunk);
  }

  return {
    success: true,
    output: `Sent ${chunks.length} Telegram message${chunks.length === 1 ? "" : "s"} to the owner chat.`,
  };
}
