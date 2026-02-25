import { describe, it, expect, vi } from "vitest";
import { detectUnusedActions, getPersonalityPrompt, PERSONALITY_PRESETS, isSimpleTask, isCodingTask, isStatusCheck, resolveProvider } from "../../src/agent/core.js";

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

  describe("write_file detection", () => {
    it("detects 'file updated' without tool use", () => {
      const result = detectUnusedActions("File updated with the new entry.", []);
      expect(result).toEqual({ claim: "writing/updating a file", tool: "write_file" });
    });

    it("detects 'updated the timesheet' variant", () => {
      const result = detectUnusedActions("I've updated the timesheet for today.", []);
      expect(result).toEqual({ claim: "writing/updating a file", tool: "write_file" });
    });

    it("detects 'saved the file' variant", () => {
      const result = detectUnusedActions("Saved the file with your changes.", []);
      expect(result).toEqual({ claim: "writing/updating a file", tool: "write_file" });
    });

    it("detects 'appended to the file' variant", () => {
      const result = detectUnusedActions("I've appended to the file.", []);
      expect(result).toEqual({ claim: "writing/updating a file", tool: "write_file" });
    });

    it("returns null when write_file was actually used", () => {
      expect(detectUnusedActions("File updated!", ["write_file"])).toBeNull();
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

describe("getPersonalityPrompt", () => {
  it("returns default text when no preset given", () => {
    const result = getPersonalityPrompt();
    expect(result).toBe(PERSONALITY_PRESETS["default"]);
  });

  it("returns default text for undefined", () => {
    expect(getPersonalityPrompt(undefined)).toBe(PERSONALITY_PRESETS["default"]);
  });

  it("returns tars preset", () => {
    const result = getPersonalityPrompt("tars");
    expect(result).toBe(PERSONALITY_PRESETS["tars"]);
    expect(result).toContain("75%");
    expect(result).toContain("TARS");
  });

  it("returns professional preset", () => {
    const result = getPersonalityPrompt("professional");
    expect(result).toBe(PERSONALITY_PRESETS["professional"]);
    expect(result).toContain("No jokes");
  });

  it("returns minimal preset", () => {
    const result = getPersonalityPrompt("minimal");
    expect(result).toBe(PERSONALITY_PRESETS["minimal"]);
    expect(result).toContain("bare facts");
  });

  it("falls back to default for unknown preset", () => {
    expect(getPersonalityPrompt("unknown")).toBe(PERSONALITY_PRESETS["default"]);
    expect(getPersonalityPrompt("sherlock")).toBe(PERSONALITY_PRESETS["default"]);
  });

  it("has exactly 4 presets", () => {
    expect(Object.keys(PERSONALITY_PRESETS)).toEqual(["default", "tars", "professional", "minimal"]);
  });
});

describe("isSimpleTask", () => {
  it("detects URL fetching as simple", () => {
    expect(isSimpleTask("fetch the page at example.com")).toBe(true);
  });

  it("detects weather check as simple", () => {
    expect(isSimpleTask("check weather in London")).toBe(true);
  });

  it("detects file reading as simple", () => {
    expect(isSimpleTask("read file config.json")).toBe(true);
  });

  it("detects download as simple", () => {
    expect(isSimpleTask("download the report from the URL")).toBe(true);
  });

  it("rejects long descriptions as complex", () => {
    const longDesc = "Research the top 10 competitors in the AI agent space, analyze their pricing models, feature sets, and target audiences. Compare with our approach and prepare a detailed report with recommendations for positioning and feature priorities.";
    expect(isSimpleTask(longDesc)).toBe(false);
  });

  it("rejects generic research tasks as complex", () => {
    expect(isSimpleTask("research AI agent frameworks and compare them")).toBe(false);
  });

  it("rejects multi-step tasks as complex", () => {
    expect(isSimpleTask("check my ebay orders and email the summary")).toBe(false);
  });

  it("rejects analysis tasks as complex", () => {
    expect(isSimpleTask("analyze my expenses for this month")).toBe(false);
  });
});

describe("isCodingTask", () => {
  it("detects 'write code' as coding", () => {
    expect(isCodingTask("write code for a new backup feature")).toBe(true);
  });

  it("detects 'fix the bug' as coding", () => {
    expect(isCodingTask("fix the bug in the login handler")).toBe(true);
  });

  it("detects 'refactor' as coding", () => {
    expect(isCodingTask("refactor the provider factory")).toBe(true);
  });

  it("detects 'implement' as coding", () => {
    expect(isCodingTask("implement the new calendar sync feature")).toBe(true);
  });

  it("detects TypeScript file references as coding", () => {
    expect(isCodingTask("edit the file src/config.ts and fix the getter")).toBe(true);
  });

  it("detects 'create a skill' as coding", () => {
    expect(isCodingTask("create a skill for tracking packages")).toBe(true);
  });

  it("detects 'write a function' as coding", () => {
    expect(isCodingTask("write a function to parse dates")).toBe(true);
  });

  it("detects 'debug' as coding", () => {
    expect(isCodingTask("debug why the scheduler isn't firing")).toBe(true);
  });

  it("detects 'unit test' as coding", () => {
    expect(isCodingTask("write a unit test for the parser")).toBe(true);
  });

  it("does not detect weather checks as coding", () => {
    expect(isCodingTask("check the weather in London")).toBe(false);
  });

  it("does not detect email tasks as coding", () => {
    expect(isCodingTask("send an email to Dave about the meeting")).toBe(false);
  });

  it("does not detect reminders as coding", () => {
    expect(isCodingTask("remind me to call the dentist tomorrow")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isCodingTask("Write Code for the API")).toBe(true);
    expect(isCodingTask("REFACTOR the module")).toBe(true);
  });
});

describe("resolveProvider", () => {
  it("primary mode always returns primary provider", () => {
    const result = resolveProvider("worker", "primary", "fetch a page");
    expect(result.isSecondary).toBe(false);
  });

  it("primary mode returns primary for chat", () => {
    const result = resolveProvider("telegram", "primary");
    expect(result.isSecondary).toBe(false);
  });

  it("balanced mode returns primary for chat", () => {
    const result = resolveProvider("telegram", "balanced");
    expect(result.isSecondary).toBe(false);
  });

  it("balanced mode returns primary for a2a", () => {
    const result = resolveProvider("a2a", "balanced");
    expect(result.isSecondary).toBe(false);
  });

  it("balanced mode returns primary for dashboard", () => {
    const result = resolveProvider("dashboard", "balanced");
    expect(result.isSecondary).toBe(false);
  });

  it("balanced mode returns primary for complex worker tasks", () => {
    const result = resolveProvider("worker", "balanced", "research AI frameworks and write a comparison report");
    expect(result.isSecondary).toBe(false);
  });

  it("balanced mode falls back to primary when no secondary configured", () => {
    // When no SECONDARY_PROVIDER is set, config.secondaryLlm returns null
    // resolveProvider should gracefully return primary
    const result = resolveProvider("worker", "balanced", "fetch the page");
    // This will be primary if no secondary is configured in env (which is the test case)
    expect(result.provider).toBeDefined();
    expect(result.llmConfig).toBeDefined();
  });

  it("returns isCoding=false for non-code tasks", () => {
    const result = resolveProvider("telegram", "primary", "check the weather");
    expect(result.isCoding).toBe(false);
  });

  it("returns isCoding=false when coding brain not configured", () => {
    // Without CODING_LLM_API_KEY set, coding brain should not activate
    const result = resolveProvider("dashboard", "primary", "write code for a new feature");
    expect(result.isCoding).toBe(false);
  });
});

describe("isStatusCheck", () => {
  it("detects 'what are you doing'", () => {
    expect(isStatusCheck("what are you doing")).toBe(true);
  });

  it("detects 'what are you doing?' with punctuation", () => {
    expect(isStatusCheck("what are you doing?")).toBe(true);
  });

  it("detects 'status' exactly", () => {
    expect(isStatusCheck("status")).toBe(true);
    expect(isStatusCheck("status?")).toBe(true);
  });

  it("detects 'any progress'", () => {
    expect(isStatusCheck("any progress?")).toBe(true);
  });

  it("detects 'sitrep'", () => {
    expect(isStatusCheck("sitrep")).toBe(true);
  });

  it("detects 'how far along'", () => {
    expect(isStatusCheck("how far along are you")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isStatusCheck("What Are You Doing?")).toBe(true);
    expect(isStatusCheck("STATUS")).toBe(true);
  });

  it("rejects long messages that happen to contain status patterns", () => {
    expect(isStatusCheck("I need you to check the status of the eBay listing and update the price to $25")).toBe(false);
  });

  it("rejects unrelated short messages", () => {
    expect(isStatusCheck("hello")).toBe(false);
    expect(isStatusCheck("what's the weather")).toBe(false);
    expect(isStatusCheck("help me with this")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isStatusCheck("")).toBe(false);
  });

  it("detects 'update me'", () => {
    expect(isStatusCheck("update me")).toBe(true);
  });

  it("detects 'where are you at'", () => {
    expect(isStatusCheck("where are you at with that")).toBe(true);
  });
});
