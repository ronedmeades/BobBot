# Two-Brain Cost Mode System — Implementation Plan

**Status:** TODO — Ready to implement
**Created:** 2026-02-17
**Estimated savings:** 70-90% (~$20/day → $2-5/day)

## Context

Bob currently sends every request (direct chat, background tasks, automated checks) to Claude Opus 4.6 at $15/$75 per million tokens — costing ~$20/day. Most of those requests are simple (reminders, weather, note lookups, background research) and don't need the most powerful model. By routing simple/background work to a cheap secondary model (Gemini Flash at $0.30/$2.50, or a local Ollama model for free), we can cut costs 70-90% while keeping Claude for tasks that actually need it.

Bob already has multi-provider infrastructure (`src/providers/` with Anthropic, OpenAI, Gemini), but it's single-provider-at-startup. This plan makes it dual-provider with a runtime-switchable cost mode.

## Design

**Two modes, switchable via `set_cost_mode` tool mid-conversation:**

| Mode | Direct Chat | Background Tasks (worker) | A2A |
|------|------------|--------------------------|-----|
| **performance** | Primary model | Primary model | Primary model |
| **optimized** | Primary model | Secondary model | Secondary model |

**Ollama support:** The OpenAI provider gets a `baseUrl` parameter. Ollama's OpenAI-compatible API at `localhost:11434/v1` slots right in — no new provider needed.

## Pricing Reference

| Model | Input/1M | Output/1M | vs Opus 4.6 |
|-------|----------|-----------|-------------|
| Claude Opus 4.6 (current) | $15.00 | $75.00 | 1x |
| Claude Sonnet 4 | $3.00 | $15.00 | 5x cheaper |
| Claude Haiku 4.5 | $1.00 | $5.00 | 15x cheaper |
| Gemini 2.5 Flash | $0.30 | $2.50 | 30x cheaper |
| GPT-4o-mini | $0.15 | $0.60 | 100x cheaper |
| Ollama (local) | $0 | $0 | free |

## Local Model Options (for Ollama)

| Model | VRAM | Tool Calling | Notes |
|-------|------|-------------|-------|
| Qwen3-30B-A3B (MoE) | ~6-8 GB | Excellent | Best bang for buck — 30B quality, only 3B active |
| Qwen3-8B | ~5-6 GB | Excellent | Sweet spot for small GPUs |
| Mistral 7B | ~5 GB | Good | Native function calling |

## Files to Modify (11 files, implementation order)

### 1. `src/providers/types.ts` — Add LLMConfig interface

Add exported `LLMConfig` with optional `baseUrl`:

```typescript
export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}
```

This replaces the local `LLMConfig` interface currently in `factory.ts:6-10`.

### 2. `src/providers/openai.ts` — Accept baseUrl for Ollama

Change constructor (line 17-18) to accept optional `baseUrl`:

```typescript
constructor(apiKey: string, baseUrl?: string) {
  this.client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
}
```

### 3. `src/providers/factory.ts` — Map cache for multi-provider

Replace singleton cache (`let cached` / `let cachedKey`) with a `Map<string, LLMProvider>`. Import `LLMConfig` from `types.ts` instead of defining locally. Include `baseUrl` in cache key. Pass `baseUrl` to `OpenAIProvider` constructor.

### 4. `src/config.ts` — Add secondary LLM config

New env vars: `SECONDARY_PROVIDER`, `SECONDARY_API_KEY`, `SECONDARY_MODEL`, `SECONDARY_BASE_URL`, `DEFAULT_COST_MODE`.

Add to config object:
- `config.secondaryLlm: LLMConfig | null` — parsed from SECONDARY_* env vars, null if not configured
- `config.costMode.default: "performance" | "optimized"` — from DEFAULT_COST_MODE, defaults to "performance"

Add validation warning in `validateConfig()` if `DEFAULT_COST_MODE=optimized` but no secondary configured.

Import `LLMConfig` from `providers/types.ts`. Apply `satisfies LLMConfig` to both `config.llm` and `config.secondaryLlm`.

### 5. `src/agent/core.ts` — Routing logic (the main change)

**5a. Add `resolveProvider()` function** (new, near line 170):

```typescript
export type CostMode = "performance" | "optimized";

function resolveProvider(
  source: AgentSource,
  costMode: CostMode
): { provider: LLMProvider; llmConfig: LLMConfig } {
  if (costMode === "performance" || !config.secondaryLlm) {
    return { provider: getProvider(config.llm), llmConfig: config.llm };
  }
  // Optimized: worker + a2a → secondary, direct chat → primary
  if (source === "worker" || source === "a2a") {
    return { provider: getProvider(config.secondaryLlm), llmConfig: config.secondaryLlm };
  }
  return { provider: getProvider(config.llm), llmConfig: config.llm };
}
```

**5b. Update `runAgentInner()`:**
- Read `costMode` from `profile?.preferences?.costMode ?? config.costMode.default`
- Call `resolveProvider(source, costMode)` to get `activeProvider` and `llmConfig`
- Replace `provider.chat(...)` call (line 383) to use `activeProvider` and `llmConfig.model`
- Keep the module-level `const provider = getProvider(config.llm)` as a fallback / default reference

**5c. Update `buildSystemPrompt()`:**
- Add cost mode info line after the existing `Your model:` line (line 80):
  `Cost mode: ${mode} (${description})`

**5d. Console log** when routing to secondary model.

### 6. `src/agent/tools.ts` — Add `set_cost_mode` tool definition

Follow exact `set_personality` pattern (lines 217-230). Add to `builtinTools` array:

```typescript
{
  name: "set_cost_mode",
  description:
    "Switch Bob's cost optimization mode. " +
    "'performance' uses the primary model for everything (max quality). " +
    "'optimized' routes background tasks to a cheaper secondary model while keeping the primary for direct chat. " +
    "Requires SECONDARY_PROVIDER to be configured for optimized mode.",
  input_schema: {
    type: "object" as const,
    properties: {
      mode: {
        type: "string",
        enum: ["performance", "optimized"],
        description: "The cost mode to use",
      },
    },
    required: ["mode"],
  },
}
```

### 7. `src/agent/tool-loader.ts` — Add to core tools

Add `"set_cost_mode"` to `CORE_TOOL_NAMES` set (line 28-44), next to `"set_personality"`.

### 8. `src/agent/tool-executor.ts` — Add handler

New case after `set_personality` (line 302), same pattern:
- Validate mode against `["performance", "optimized"]`
- If `"optimized"` and no `config.secondaryLlm`, return error with setup instructions
- Load profile, set `profile.preferences.costMode = mode`, save
- Return success with description of what each mode routes where

### 9. `src/skills/env-manager.ts` — Allowlist new keys

Add to `ALLOWED_KEYS` set (line 14-63):
```
"SECONDARY_PROVIDER", "SECONDARY_API_KEY", "SECONDARY_MODEL",
"SECONDARY_BASE_URL", "DEFAULT_COST_MODE"
```

Add `cost_mode` category to the `categories` object (line 209-228):
```typescript
cost_mode: {
  keys: ["SECONDARY_PROVIDER", "SECONDARY_API_KEY", "SECONDARY_MODEL", "SECONDARY_BASE_URL", "DEFAULT_COST_MODE"],
  hint: "Secondary model for cost optimization. Use with Ollama (SECONDARY_BASE_URL=http://localhost:11434/v1) or cloud APIs.",
},
```

Add `"cost_mode"` to the `list_env_keys` tool definition enum (line 109).

### 10. `src/dashboard/server.ts` — Expose in status API

Add `secondaryModel` and `costMode` to `/api/status` response (line 123-130):
```typescript
secondaryProvider: config.secondaryLlm?.provider ?? null,
secondaryModel: config.secondaryLlm?.model ?? null,
```

### 11. `.env.example` — Document new env vars

Add a new section after the A2A section:

```ini
# Cost Mode — Two-brain routing
# Switch between performance (all primary) and optimized (background→secondary)
# Switchable at runtime via chat: "Bob, switch to optimized mode"
# DEFAULT_COST_MODE=performance
# SECONDARY_PROVIDER=gemini        # gemini, openai, or anthropic
# SECONDARY_API_KEY=               # API key for secondary provider
# SECONDARY_MODEL=                 # Model name (defaults to provider default)
# SECONDARY_BASE_URL=              # For Ollama: http://localhost:11434/v1
```

## Ollama Configuration Example

```ini
SECONDARY_PROVIDER=openai
SECONDARY_API_KEY=ollama
SECONDARY_MODEL=qwen3:8b
SECONDARY_BASE_URL=http://localhost:11434/v1
```

Ollama ignores API keys but the OpenAI SDK requires a non-empty string, so `ollama` works as a placeholder.

## Backward Compatibility

- No `SECONDARY_*` env vars set → `config.secondaryLlm` is `null` → `resolveProvider()` always returns primary → zero behavior change
- `set_cost_mode optimized` without secondary configured → returns clear error message
- Profile has `costMode=optimized` but secondary env vars later removed → `resolveProvider()` checks for null and falls back to primary
- Existing `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` behavior unchanged

## Out of Scope (Phase 2)

- Auto-routing simple direct chat messages to secondary (use category count as complexity signal)
- Per-tool LLM routing (skills like summarizer.ts that make their own LLM calls)
- Cost tracking dashboard (per-request cost in SQLite)
- Model-specific maxTokens configuration

## Verification

1. `pnpm build` — confirm no type errors
2. `pnpm test` — all 172 existing tests pass
3. Add tests to `tests/config.test.ts` — `secondaryLlm` null when unconfigured, `costMode.default` defaults
4. Add tests to `tests/agent/core.test.ts` — `resolveProvider()` routing logic (4-5 tests)
5. Manual: start Bob with no SECONDARY_* vars → verify normal behavior
6. Manual: set `SECONDARY_PROVIDER=gemini` + key → switch to optimized → verify worker uses Gemini (console log)
7. Manual: verify `set_cost_mode` tool works via dashboard/Telegram
