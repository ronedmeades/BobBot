import type { LLMProvider } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";

interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
}

let cached: LLMProvider | null = null;
let cachedKey = "";

/**
 * Create (or return cached) LLM provider based on config.
 */
export function getProvider(llm: LLMConfig): LLMProvider {
  const key = `${llm.provider}:${llm.apiKey}:${llm.model}`;
  if (cached && cachedKey === key) return cached;

  switch (llm.provider) {
    case "anthropic":
      cached = new AnthropicProvider(llm.apiKey);
      break;
    case "openai":
      cached = new OpenAIProvider(llm.apiKey);
      break;
    case "gemini":
      cached = new GeminiProvider(llm.apiKey);
      break;
    default:
      throw new Error(
        `Unknown LLM provider: "${llm.provider}". Supported: anthropic, openai, gemini`
      );
  }

  cachedKey = key;
  return cached;
}
