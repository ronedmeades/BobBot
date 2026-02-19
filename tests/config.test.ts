import { describe, it, expect } from "vitest";
import { config, validateConfig } from "../src/config.js";

describe("config", () => {
  it("has default model for anthropic", () => {
    // Default provider is anthropic if LLM_PROVIDER not set
    expect(config.llm.model).toBeTruthy();
  });

  it("has agent name set to Bob", () => {
    expect(config.agent.name).toBe("Bob");
  });

  it("has maxToolRounds set to 20", () => {
    expect(config.agent.maxToolRounds).toBe(20);
  });

  it("has owner userId defaulting to 'owner' if not set", () => {
    // Either set from env or defaults
    expect(config.owner.userId).toBeTruthy();
  });

  it("has a2a disabled by default", () => {
    // A2A_ENABLED must be explicitly set
    if (!process.env.A2A_ENABLED) {
      expect(config.a2a.enabled).toBe(false);
    }
  });

  it("has a2a discoveryMode defaulting to handshake", () => {
    if (!process.env.A2A_DISCOVERY_MODE) {
      expect(config.a2a.discoveryMode).toBe("handshake");
    }
  });
});

describe("validateConfig", () => {
  it("does not throw when API key is present", () => {
    // config.llm.apiKey is loaded from .env which should exist in dev
    if (config.llm.apiKey) {
      expect(() => validateConfig()).not.toThrow();
    }
  });
});

describe("cost mode config", () => {
  it("secondaryLlm is null when SECONDARY_PROVIDER is not set", () => {
    if (!process.env.SECONDARY_PROVIDER) {
      expect(config.secondaryLlm).toBeNull();
    }
  });

  it("costMode.default defaults to primary", () => {
    if (!process.env.DEFAULT_COST_MODE) {
      expect(config.costMode.default).toBe("primary");
    }
  });

  it("secondaryLlm is a getter that reads process.env live", () => {
    // Save original values
    const origProvider = process.env.SECONDARY_PROVIDER;
    const origKey = process.env.SECONDARY_API_KEY;

    try {
      // Set env vars
      process.env.SECONDARY_PROVIDER = "gemini";
      process.env.SECONDARY_API_KEY = "test-key";

      const result = config.secondaryLlm;
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("gemini");
      expect(result!.apiKey).toBe("test-key");

      // Clear and verify it returns null
      delete process.env.SECONDARY_PROVIDER;
      delete process.env.SECONDARY_API_KEY;
      expect(config.secondaryLlm).toBeNull();
    } finally {
      // Restore original values
      if (origProvider) process.env.SECONDARY_PROVIDER = origProvider;
      else delete process.env.SECONDARY_PROVIDER;
      if (origKey) process.env.SECONDARY_API_KEY = origKey;
      else delete process.env.SECONDARY_API_KEY;
    }
  });
});
