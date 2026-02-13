import { describe, it, expect, vi } from "vitest";

// Mock heavy imports to avoid loading all skill modules
vi.mock("../../src/agent/tools.js", () => ({
  toolDefinitions: [
    { name: "get_weather", description: "Weather", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "translate_text", description: "Translate", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "run_command", description: "Run command", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "read_file", description: "Read file", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "list_events", description: "List events", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "search_contacts", description: "Search contacts", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "ha_toggle", description: "Toggle HA", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "discover_agent", description: "Discover", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "send_email", description: "Send email", input_schema: { type: "object", properties: {}, required: [] } },
  ],
}));

vi.mock("../../src/mcp/client.js", () => ({
  isMcpTool: (name: string) => name.startsWith("mcp_custom_"),
}));

import { isPublicTool, getSafeToolNames } from "../../src/a2a/public-skills.js";

describe("isPublicTool", () => {
  describe("BLOCKED tools", () => {
    it("blocks run_command at any trust tier", () => {
      expect(isPublicTool("run_command", "trusted")).toBe(false);
      expect(isPublicTool("run_command", "manual")).toBe(false);
    });

    it("blocks read_file at trusted tier", () => {
      expect(isPublicTool("read_file", "trusted")).toBe(false);
    });

    it("blocks send_email at any tier", () => {
      expect(isPublicTool("send_email", "trusted")).toBe(false);
    });

    it("blocks ha_toggle (Home Assistant) at any tier", () => {
      expect(isPublicTool("ha_toggle", "trusted")).toBe(false);
    });

    it("blocks discover_agent (prevents A2A recursion)", () => {
      expect(isPublicTool("discover_agent", "trusted")).toBe(false);
    });
  });

  describe("DATA tools", () => {
    it("blocks list_events at manual tier", () => {
      expect(isPublicTool("list_events", "manual")).toBe(false);
    });

    it("allows list_events at trusted tier", () => {
      expect(isPublicTool("list_events", "trusted")).toBe(true);
    });

    it("blocks search_contacts at budget-capped tier", () => {
      expect(isPublicTool("search_contacts", "budget-capped")).toBe(false);
    });

    it("allows search_contacts at trusted tier", () => {
      expect(isPublicTool("search_contacts", "trusted")).toBe(true);
    });
  });

  describe("SAFE tools", () => {
    it("allows get_weather at manual tier", () => {
      expect(isPublicTool("get_weather", "manual")).toBe(true);
    });

    it("allows get_weather at trusted tier", () => {
      expect(isPublicTool("get_weather", "trusted")).toBe(true);
    });

    it("allows translate_text at budget-capped tier", () => {
      expect(isPublicTool("translate_text", "budget-capped")).toBe(true);
    });
  });

  describe("blocked trust tier", () => {
    it("blocks everything for blocked peers", () => {
      expect(isPublicTool("get_weather", "blocked")).toBe(false);
      expect(isPublicTool("translate_text", "blocked")).toBe(false);
    });
  });

  describe("MCP tools", () => {
    it("blocks MCP tools even at trusted tier", () => {
      expect(isPublicTool("mcp_custom_sometool", "trusted")).toBe(false);
    });
  });
});

describe("getSafeToolNames", () => {
  it("returns an array of strings", () => {
    const names = getSafeToolNames();
    expect(Array.isArray(names)).toBe(true);
    for (const name of names) {
      expect(typeof name).toBe("string");
    }
  });

  it("includes SAFE tools", () => {
    const names = getSafeToolNames();
    expect(names).toContain("get_weather");
    expect(names).toContain("translate_text");
  });

  it("excludes BLOCKED tools", () => {
    const names = getSafeToolNames();
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("send_email");
  });

  it("excludes DATA tools", () => {
    const names = getSafeToolNames();
    expect(names).not.toContain("list_events");
    expect(names).not.toContain("search_contacts");
  });
});
