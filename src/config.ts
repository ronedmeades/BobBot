import "dotenv/config";
import type { DiscoveryMode, TrustTier } from "./a2a/types.js";
import type { LLMConfig } from "./providers/types.js";

export type CostMode = "primary" | "balanced";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
};

const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();

export const config = {
  llm: {
    provider,
    apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? DEFAULT_MODELS[provider] ?? "claude-opus-4-6",
  } satisfies LLMConfig,
  /** Secondary LLM for balanced mode. Getter reads process.env live so set_env_var hot-reload works. */
  get secondaryLlm(): LLMConfig | null {
    const p = process.env.SECONDARY_PROVIDER?.toLowerCase();
    const k = process.env.SECONDARY_API_KEY;
    if (!p || !k) return null;
    return {
      provider: p,
      apiKey: k,
      model: process.env.SECONDARY_MODEL ?? DEFAULT_MODELS[p] ?? "",
      baseUrl: process.env.SECONDARY_BASE_URL || undefined,
    };
  },
  costMode: {
    get default(): CostMode {
      const mode = process.env.DEFAULT_COST_MODE?.toLowerCase();
      if (mode === "balanced") return "balanced";
      return "primary";
    },
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  },
  owner: {
    userId: process.env.OWNER_USER_ID || "owner",
    name: process.env.OWNER_NAME ?? "Owner",
    notes: process.env.OWNER_NOTES ?? "",
    timezone: process.env.OWNER_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  dashboard: {
    apiToken: process.env.BOB_API_TOKEN ?? "",
  },
  agent: {
    name: "Bob",
    maxToolRounds: 20,
  },
  homeAssistant: {
    url: process.env.HA_URL ?? "http://localhost:8123",
    token: process.env.HA_TOKEN ?? "",
  },
  a2a: {
    enabled: !!process.env.A2A_ENABLED,
    discoveryMode: (process.env.A2A_DISCOVERY_MODE ?? "handshake") as DiscoveryMode,
    publicUrl: process.env.A2A_PUBLIC_URL ?? "",
    agentName: process.env.A2A_AGENT_NAME ?? (process.env.OWNER_NAME ? `${process.env.OWNER_NAME}'s Bob` : "Bob"),
    defaultTrustTier: (process.env.A2A_DEFAULT_TRUST ?? "manual") as TrustTier,
    approvalTimeoutMin: Number(process.env.A2A_APPROVAL_TIMEOUT_MIN) || 30,
    maxRequestBodyBytes: 1_048_576, // 1MB
  },
};

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
    console.log("No TELEGRAM_BOT_TOKEN set — Telegram disabled. Chat via the dashboard instead.");
    console.log("Ask Bob to help you set up Telegram when you're ready.\n");
  }
  if (!config.dashboard.apiToken) {
    console.log("WARNING: No BOB_API_TOKEN set — dashboard API is unauthenticated!");
    console.log("Set BOB_API_TOKEN in .env to secure the dashboard.\n");
  }
  if (config.costMode.default === "balanced" && !config.secondaryLlm) {
    console.log("WARNING: DEFAULT_COST_MODE=balanced but no SECONDARY_PROVIDER configured.");
    console.log("Balanced mode needs SECONDARY_PROVIDER + SECONDARY_API_KEY. Falling back to primary mode.\n");
  }
  if (config.secondaryLlm) {
    console.log(`Cost mode: secondary provider available (${config.secondaryLlm.provider}/${config.secondaryLlm.model})`);
  }
  if (config.a2a.enabled) {
    if (!config.a2a.publicUrl) {
      console.log("WARNING: A2A enabled but no A2A_PUBLIC_URL set — other Bobs won't know how to reach you.");
      console.log("Set A2A_PUBLIC_URL in .env (e.g. http://192.168.1.50:3000).\n");
    }
    console.log(`A2A: ${config.a2a.discoveryMode} mode, agent name: "${config.a2a.agentName}"`);
  }
}
