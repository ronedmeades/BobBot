import "dotenv/config";
import type { DiscoveryMode, TrustTier } from "./a2a/types.js";
import type { LLMConfig } from "./providers/types.js";

export type CostMode = "primary" | "balanced";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-4o-mini",
  gemini: "gemini-3.1-pro-preview",
};

function getPrimaryProvider(): string {
  return (process.env.PRIMARY_LLM_PROVIDER ?? "anthropic").toLowerCase();
}

export const config = {
  llm: {
    get provider(): string {
      return getPrimaryProvider();
    },
    get apiKey(): string {
      return process.env.PRIMARY_LLM_API_KEY ?? "";
    },
    get model(): string {
      const provider = getPrimaryProvider();
      return process.env.PRIMARY_LLM_MODEL ?? DEFAULT_MODELS[provider] ?? "claude-opus-4-6";
    },
    get baseUrl(): string | undefined {
      return undefined;
    },
  } satisfies LLMConfig,
  /** Secondary LLM for balanced mode. Getter reads process.env live so set_env_var hot-reload works. */
  get secondaryLlm(): LLMConfig | null {
    const p = process.env.SECONDARY_LLM_PROVIDER?.toLowerCase();
    const k = process.env.SECONDARY_LLM_API_KEY;
    if (!p || !k) return null;
    return {
      provider: p,
      apiKey: k,
      model: process.env.SECONDARY_LLM_MODEL ?? DEFAULT_MODELS[p] ?? "",
      baseUrl: process.env.SECONDARY_LLM_BASE_URL || undefined,
    };
  },
  /** Coding brain — dedicated model for code tasks. Defaults to Claude Opus 4.6. Getter reads process.env live. */
  get codingLlm(): LLMConfig | null {
    const k = process.env.CODING_LLM_API_KEY;
    if (!k) return null;
    const p = (process.env.CODING_LLM_PROVIDER ?? "anthropic").toLowerCase();
    return {
      provider: p,
      apiKey: k,
      model: process.env.CODING_LLM_MODEL ?? "claude-opus-4-6",
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
    get botToken(): string {
      return process.env.TELEGRAM_BOT_TOKEN ?? "";
    },
  },
  owner: {
    get userId(): string {
      return process.env.OWNER_USER_ID || "owner";
    },
    get name(): string {
      return process.env.OWNER_NAME ?? "Owner";
    },
    get notes(): string {
      return process.env.OWNER_NOTES ?? "";
    },
    get timezone(): string {
      return process.env.OWNER_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    },
  },
  dashboard: {
    get apiToken(): string {
      return process.env.BOB_API_TOKEN ?? "";
    },
  },
  agent: {
    name: "Bob",
    maxToolRounds: 20,
  },
  homeAssistant: {
    get url(): string {
      return process.env.HA_URL ?? "http://localhost:8123";
    },
    get token(): string {
      return process.env.HA_TOKEN ?? "";
    },
  },
  a2a: {
    get enabled(): boolean {
      return !!process.env.A2A_ENABLED;
    },
    get discoveryMode(): DiscoveryMode {
      return (process.env.A2A_DISCOVERY_MODE ?? "handshake") as DiscoveryMode;
    },
    get publicUrl(): string {
      return process.env.A2A_PUBLIC_URL ?? "";
    },
    get agentName(): string {
      return process.env.A2A_AGENT_NAME ?? (process.env.OWNER_NAME ? `${process.env.OWNER_NAME}'s Bob` : "Bob");
    },
    get defaultTrustTier(): TrustTier {
      return (process.env.A2A_DEFAULT_TRUST ?? "manual") as TrustTier;
    },
    get approvalTimeoutMin(): number {
      return Number(process.env.A2A_APPROVAL_TIMEOUT_MIN) || 30;
    },
    maxRequestBodyBytes: 1_048_576, // 1MB
  },
};

export function validateConfig(): void {
  if (!config.llm.apiKey) {
    const hints: Record<string, string> = {
      anthropic: "Set PRIMARY_LLM_API_KEY in .env — get one at console.anthropic.com",
      openai: "Set PRIMARY_LLM_API_KEY in .env — get one at platform.openai.com/api-keys",
      gemini: "Set PRIMARY_LLM_API_KEY in .env — get one at aistudio.google.com/apikey",
    };
    throw new Error(
      `No API key for provider "${config.llm.provider}". ${hints[config.llm.provider] ?? "Set PRIMARY_LLM_API_KEY in .env"}`
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
    console.log("WARNING: DEFAULT_COST_MODE=balanced but no SECONDARY_LLM_PROVIDER configured.");
    console.log("Balanced mode needs SECONDARY_LLM_PROVIDER + SECONDARY_LLM_API_KEY. Falling back to primary mode.\n");
  }
  if (config.secondaryLlm) {
    console.log(`Cost mode: secondary provider available (${config.secondaryLlm.provider}/${config.secondaryLlm.model})`);
  }
  if (config.codingLlm) {
    console.log(`Coding brain: ${config.codingLlm.provider}/${config.codingLlm.model} (code tasks routed here)`);
  }
  if (config.a2a.enabled) {
    if (!config.a2a.publicUrl) {
      console.log("WARNING: A2A enabled but no A2A_PUBLIC_URL set — other Bobs won't know how to reach you.");
      console.log("Set A2A_PUBLIC_URL in .env (e.g. http://192.168.1.50:3000).\n");
    }
    console.log(`A2A: ${config.a2a.discoveryMode} mode, agent name: "${config.a2a.agentName}"`);
  }
}
