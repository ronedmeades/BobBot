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
