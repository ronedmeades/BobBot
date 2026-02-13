import { describe, it, expect } from "vitest";
import { detectUnusedActions } from "../../src/agent/core.js";

describe("detectUnusedActions", () => {
  describe("returns null for clean responses", () => {
    it("returns null for text with no action claims", () => {
      expect(detectUnusedActions("Here's what I found about that topic.", [])).toBeNull();
    });

    it("returns null for empty text", () => {
      expect(detectUnusedActions("", [])).toBeNull();
    });

    it("returns null with empty usedTools array and clean text", () => {
      expect(detectUnusedActions("Sure, I can help with that.", [])).toBeNull();
    });
  });

  describe("call_owner detection", () => {
    it("detects 'calling you now' without tool use", () => {
      const result = detectUnusedActions("Calling you now!", []);
      expect(result).toEqual({ claim: "making a phone call", tool: "call_owner" });
    });

    it("detects 'dialing' variant", () => {
      const result = detectUnusedActions("Dialing your number...", []);
      expect(result).toEqual({ claim: "making a phone call", tool: "call_owner" });
    });

    it("returns null when call_owner was actually used", () => {
      expect(detectUnusedActions("Calling you now!", ["call_owner"])).toBeNull();
    });
  });

  describe("send_sms detection", () => {
    it("detects 'sms sent' without tool use", () => {
      const result = detectUnusedActions("SMS sent to your phone.", []);
      expect(result).toEqual({ claim: "sending an SMS", tool: "send_sms" });
    });

    it("detects 'texting you' variant", () => {
      const result = detectUnusedActions("Texting you the details now.", []);
      expect(result).toEqual({ claim: "sending an SMS", tool: "send_sms" });
    });

    it("returns null when send_sms was actually used", () => {
      expect(detectUnusedActions("SMS sent!", ["send_sms"])).toBeNull();
    });
  });

  describe("add_event detection", () => {
    it("detects 'added to your calendar' without tool use", () => {
      const result = detectUnusedActions("Added to your calendar!", []);
      expect(result).toEqual({ claim: "adding a calendar event", tool: "add_event" });
    });

    it("detects 'event created' variant", () => {
      const result = detectUnusedActions("Event created for tomorrow.", []);
      expect(result).toEqual({ claim: "adding a calendar event", tool: "add_event" });
    });

    it("returns null when add_event was actually used", () => {
      expect(detectUnusedActions("Added to your calendar!", ["add_event"])).toBeNull();
    });
  });

  describe("set_reminder detection", () => {
    it("detects 'reminder set' without tool use", () => {
      const result = detectUnusedActions("Reminder set for 3pm.", []);
      expect(result).toEqual({ claim: "setting a reminder", tool: "set_reminder" });
    });

    it("detects 'i'll remind you' variant", () => {
      const result = detectUnusedActions("I'll remind you tomorrow morning.", []);
      expect(result).toEqual({ claim: "setting a reminder", tool: "set_reminder" });
    });

    it("returns null when set_reminder was actually used", () => {
      expect(detectUnusedActions("Reminder set!", ["set_reminder"])).toBeNull();
    });
  });

  describe("send_email detection", () => {
    it("detects 'email sent' without tool use", () => {
      const result = detectUnusedActions("Email sent to Dave.", []);
      expect(result).toEqual({ claim: "sending an email", tool: "send_email" });
    });

    it("detects 'emailed' variant", () => {
      const result = detectUnusedActions("I emailed the report.", []);
      expect(result).toEqual({ claim: "sending an email", tool: "send_email" });
    });

    it("returns null when send_email was actually used", () => {
      expect(detectUnusedActions("Email sent!", ["send_email"])).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("is case insensitive", () => {
      const result = detectUnusedActions("CALLING YOU NOW!", []);
      expect(result).toEqual({ claim: "making a phone call", tool: "call_owner" });
    });

    it("returns first match when multiple claims exist", () => {
      const result = detectUnusedActions("Calling you now! Also SMS sent!", []);
      expect(result).not.toBeNull();
      expect(result!.tool).toBe("call_owner"); // first checked
    });
  });
});
