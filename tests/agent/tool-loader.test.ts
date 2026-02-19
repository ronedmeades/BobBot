import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies before importing the module under test
vi.mock("../../src/skills/local-loader.js", () => ({
  getLocalToolDefinitions: () => [],
}));
vi.mock("../../src/mcp/client.js", () => ({
  getMcpToolDefinitions: () => [],
}));
vi.mock("../../src/agent/plugin-loader.js", () => ({
  LOAD_KNOWLEDGE_DEF: { name: "load_knowledge", description: "mock", input_schema: { type: "object", properties: {}, required: [] } },
  LIST_KNOWLEDGE_DEF: { name: "list_knowledge", description: "mock", input_schema: { type: "object", properties: {}, required: [] } },
}));

import {
  selectToolsForMessage,
  getToolsForCategories,
  isValidCategory,
  buildCategorySystemPromptSection,
  countMatchedCategories,
  CORE_TOOL_NAMES,
  TOOL_CATEGORIES,
} from "../../src/agent/tool-loader.js";
import type { ToolDefinition } from "../../src/providers/types.js";

// Build a fake allDefs array with one tool per known name
function buildMockDefs(): ToolDefinition[] {
  const names = new Set<string>();
  for (const name of CORE_TOOL_NAMES) names.add(name);
  for (const cat of TOOL_CATEGORIES) {
    for (const name of cat.toolNames) names.add(name);
  }
  return Array.from(names).map((name) => ({
    name,
    description: `mock ${name}`,
    input_schema: { type: "object" as const, properties: {}, required: [] },
  }));
}

const allDefs = buildMockDefs();

describe("isValidCategory", () => {
  it("returns true for image", () => {
    expect(isValidCategory("image")).toBe(true);
  });

  it("returns true for commerce", () => {
    expect(isValidCategory("commerce")).toBe(true);
  });

  it("returns true for all defined categories", () => {
    for (const cat of TOOL_CATEGORIES) {
      expect(isValidCategory(cat.name)).toBe(true);
    }
  });

  it("returns false for nonexistent category", () => {
    expect(isValidCategory("nonexistent")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidCategory("")).toBe(false);
  });
});

describe("getToolsForCategories", () => {
  it("returns image tools for ['image']", () => {
    const result = getToolsForCategories(["image"], allDefs);
    const imageTools = TOOL_CATEGORIES.find((c) => c.name === "image")!.toolNames;
    for (const name of imageTools) {
      expect(result.some((d) => d.name === name)).toBe(true);
    }
  });

  it("returns combined tools for multiple categories", () => {
    const result = getToolsForCategories(["image", "phone"], allDefs);
    expect(result.some((d) => d.name === "batch_resize_images")).toBe(true);
    expect(result.some((d) => d.name === "call_owner")).toBe(true);
  });

  it("returns empty array for unknown category", () => {
    const result = getToolsForCategories(["fake"], allDefs);
    expect(result).toHaveLength(0);
  });

  it("ignores unknown categories in a mixed array", () => {
    const result = getToolsForCategories(["image", "fake"], allDefs);
    const imageTools = TOOL_CATEGORIES.find((c) => c.name === "image")!.toolNames;
    expect(result.length).toBe(imageTools.length);
  });

  it("returns empty for empty categories array", () => {
    const result = getToolsForCategories([], allDefs);
    expect(result).toHaveLength(0);
  });
});

describe("selectToolsForMessage", () => {
  it("always includes core tools for any message", () => {
    const result = selectToolsForMessage("hello there", allDefs);
    for (const name of CORE_TOOL_NAMES) {
      expect(result.some((d) => d.name === name)).toBe(true);
    }
  });

  it("includes load_tools meta-tool", () => {
    const result = selectToolsForMessage("hello", allDefs);
    expect(result.some((d) => d.name === "load_tools")).toBe(true);
  });

  it("includes load_knowledge meta-tool", () => {
    const result = selectToolsForMessage("hello", allDefs);
    expect(result.some((d) => d.name === "load_knowledge")).toBe(true);
  });

  it("includes list_knowledge meta-tool", () => {
    const result = selectToolsForMessage("hello", allDefs);
    expect(result.some((d) => d.name === "list_knowledge")).toBe(true);
  });

  it("activates image category for 'resize my image'", () => {
    const result = selectToolsForMessage("resize my image", allDefs);
    expect(result.some((d) => d.name === "batch_resize_images")).toBe(true);
  });

  it("activates commerce category for 'check my ebay listings'", () => {
    const result = selectToolsForMessage("check my ebay listings", allDefs);
    expect(result.some((d) => d.name === "get_seller_listings")).toBe(true);
  });

  it("activates reminders category for 'remind me tomorrow'", () => {
    const result = selectToolsForMessage("remind me tomorrow", allDefs);
    expect(result.some((d) => d.name === "set_reminder")).toBe(true);
  });

  it("activates phone category for 'call me'", () => {
    const result = selectToolsForMessage("call me please", allDefs);
    expect(result.some((d) => d.name === "call_owner")).toBe(true);
  });

  it("activates home category for 'turn on the lights'", () => {
    const result = selectToolsForMessage("turn on the lights", allDefs);
    expect(result.some((d) => d.name === "ha_toggle")).toBe(true);
  });

  it("returns only core + meta-tools for generic greeting", () => {
    const result = selectToolsForMessage("hello there", allDefs);
    // Should have core tools + 3 meta-tools, no category tools
    const coreCount = CORE_TOOL_NAMES.size;
    const metaCount = 3; // load_tools, load_knowledge, list_knowledge
    expect(result.length).toBe(coreCount + metaCount);
  });

  it("activates category when message contains exact tool name", () => {
    const result = selectToolsForMessage("use batch_resize_images on these", allDefs);
    expect(result.some((d) => d.name === "auto_crop")).toBe(true); // same category
  });

  it("handles multiple keyword matches across categories", () => {
    const result = selectToolsForMessage("resize the image and remind me to check ebay", allDefs);
    expect(result.some((d) => d.name === "batch_resize_images")).toBe(true);
    expect(result.some((d) => d.name === "set_reminder")).toBe(true);
    expect(result.some((d) => d.name === "get_seller_listings")).toBe(true);
  });
});

describe("countMatchedCategories", () => {
  it("returns 0 for a generic message", () => {
    expect(countMatchedCategories("hello there")).toBe(0);
  });

  it("returns 1 for a single-category message", () => {
    expect(countMatchedCategories("resize my image")).toBe(1);
  });

  it("returns 2+ for a multi-category message", () => {
    const count = countMatchedCategories("resize the image and remind me to check ebay");
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("returns 0 for simple fetch-like messages", () => {
    expect(countMatchedCategories("fetch this URL for me")).toBe(0);
  });
});

describe("CORE_TOOL_NAMES", () => {
  it("includes set_cost_mode", () => {
    expect(CORE_TOOL_NAMES.has("set_cost_mode")).toBe(true);
  });
});

describe("buildCategorySystemPromptSection", () => {
  it("returns string containing category names", () => {
    const result = buildCategorySystemPromptSection();
    for (const cat of TOOL_CATEGORIES) {
      expect(result).toContain(cat.name);
    }
  });

  it("includes tool counts per category", () => {
    const result = buildCategorySystemPromptSection();
    for (const cat of TOOL_CATEGORIES) {
      expect(result).toContain(`${cat.toolNames.length} tools`);
    }
  });
});
