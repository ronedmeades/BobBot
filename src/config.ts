import "dotenv/config";

export const config = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: "claude-sonnet-4-5-20250929" as const,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  },
  owner: {
    userId: process.env.OWNER_USER_ID ?? "",
    name: process.env.OWNER_NAME ?? "Owner",
    notes: process.env.OWNER_NOTES ?? "",
  },
  agent: {
    name: "Bob",
    maxToolRounds: 20,
  },
} as const;

export function validateConfig(): void {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required. Set it in .env");
  }
  if (!config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Set it in .env");
  }
  if (!config.owner.userId) {
    throw new Error("OWNER_USER_ID is required. Set it in .env (your Telegram user ID)");
  }
}
