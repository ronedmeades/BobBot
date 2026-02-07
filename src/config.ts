import "dotenv/config";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
};

const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();

export const config = {
  llm: {
    provider,
    apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? DEFAULT_MODELS[provider] ?? "claude-sonnet-4-5-20250929",
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
  if (!config.llm.apiKey) {
    const hints: Record<string, string> = {
      anthropic: "Set ANTHROPIC_API_KEY (or LLM_API_KEY) in .env — get one at console.anthropic.com",
      openai: "Set LLM_API_KEY in .env — get one at platform.openai.com/api-keys",
      gemini: "Set LLM_API_KEY in .env — get one at aistudio.google.com/apikey",
    };
    throw new Error(
      `No API key for provider "${config.llm.provider}". ${hints[config.llm.provider] ?? "Set LLM_API_KEY in .env"}`
    );
  }
  if (!config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Set it in .env");
  }
  if (!config.owner.userId) {
    throw new Error("OWNER_USER_ID is required. Set it in .env (your Telegram user ID)");
  }
}
