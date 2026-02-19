import type { LLMProvider, LLMConfig } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";

const cache = new Map<string, LLMProvider>();

/**
 * Create (or return cached) LLM provider based on config.
 * Supports multiple concurrent providers via Map-based cache.
 */
export function getProvider(llm: LLMConfig): LLMProvider {
  const key = `${llm.provider}:${llm.apiKey}:${llm.model}:${llm.baseUrl ?? ""}`;
  const existing = cache.get(key);
  if (existing) return existing;

  let provider: LLMProvider;
  switch (llm.provider) {
    case "anthropic":
      provider = new AnthropicProvider(llm.apiKey);
      break;
    case "openai":
      provider = new OpenAIProvider(llm.apiKey, llm.baseUrl);
      break;
    case "gemini":
      provider = new GeminiProvider(llm.apiKey);
      break;
    default:
      throw new Error(
        `Unknown LLM provider: "${llm.provider}". Supported: anthropic, openai, gemini`
      );
  }

  cache.set(key, provider);
  return provider;
}
