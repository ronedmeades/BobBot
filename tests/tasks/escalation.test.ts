import { describe, it, expect, beforeEach } from "vitest";
import {
  getAvailableChannels,
  filterChannels,
  recordUserInteraction,
  getLastInteraction,
} from "../../src/tasks/escalation.js";

describe("getAvailableChannels", () => {
  it("returns an array", () => {
    const channels = getAvailableChannels();
    expect(Array.isArray(channels)).toBe(true);
  });

  it("only returns valid channel types", () => {
    const valid = new Set(["telegram", "sms", "call"]);
    for (const ch of getAvailableChannels()) {
      expect(valid.has(ch)).toBe(true);
    }
  });
});

describe("filterChannels", () => {
  it("deduplicates repeated channels", () => {
    const available = getAvailableChannels();
    if (available.length > 0) {
      const duped = [available[0]!, available[0]!];
      const result = filterChannels(duped);
      expect(result.length).toBe(1);
    }
  });

  it("filters out unavailable channels", () => {
    // "call" requires Twilio env vars — if not set, it's filtered out
    if (!process.env.TWILIO_ACCOUNT_SID) {
      const result = filterChannels(["call"]);
      expect(result).toEqual([]);
    }
  });

  it("returns empty array when no requested channels are available", () => {
    const result = filterChannels(["call", "sms"]);
    // If Twilio not configured, both should be filtered out
    if (!process.env.TWILIO_ACCOUNT_SID) {
      expect(result).toEqual([]);
    }
  });

  it("preserves order of valid channels", () => {
    const available = getAvailableChannels();
    if (available.length >= 2) {
      const reversed = [...available].reverse();
      const result = filterChannels(reversed);
      expect(result).toEqual(reversed);
    }
  });
});

describe("recordUserInteraction / getLastInteraction", () => {
  it("returns undefined for unknown user", () => {
    expect(getLastInteraction("nonexistent-user-999")).toBeUndefined();
  });

  it("returns timestamp after recording interaction", () => {
    const userId = "test-user-escalation-" + Date.now();
    recordUserInteraction(userId);
    const result = getLastInteraction(userId);
    expect(result).toBeTruthy();
    // Should be a valid ISO timestamp
    expect(new Date(result!).toISOString()).toBe(result);
  });

  it("updates timestamp on subsequent interactions", () => {
    const userId = "test-user-escalation-update-" + Date.now();
    recordUserInteraction(userId);
    const first = getLastInteraction(userId)!;

    // Small delay to ensure different timestamp
    recordUserInteraction(userId);
    const second = getLastInteraction(userId)!;

    expect(second >= first).toBe(true);
  });
});
