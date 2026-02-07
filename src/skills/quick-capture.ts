import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Capture {
  id: string;
  content: string;
  type: string; // "text" | "link" | "idea" | "todo" | "snippet"
  tags: string[];
  source?: string;
  captured_at: string;
}

interface CaptureStore {
  version: number;
  captures: Capture[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const CAPTURES_PATH = resolve("memory/captures.json");

async function loadCaptures(): Promise<CaptureStore> {
  try {
    const raw = await readFile(CAPTURES_PATH, "utf-8");
    return JSON.parse(raw) as CaptureStore;
  } catch {
    return { version: 1, captures: [] };
  }
}

async function saveCaptures(data: CaptureStore): Promise<void> {
  await mkdir(dirname(CAPTURES_PATH), { recursive: true });
  await writeFile(CAPTURES_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const quickCaptureToolDefinitions: ToolDefinition[] = [
  {
    name: "capture",
    description:
      "Quickly capture a piece of information — a thought, link, idea, todo, or code snippet. " +
      "Saved to persistent local storage with optional tags and source for later retrieval.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The content to capture (text, URL, idea, code, etc.)",
        },
        type: {
          type: "string",
          enum: ["text", "link", "idea", "todo", "snippet"],
          description: "Type of capture (default: 'text')",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization (e.g. ['work', 'urgent'])",
        },
        source: {
          type: "string",
          description: "Optional source — where this came from (URL, person, book, etc.)",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "list_captures",
    description:
      "List saved captures, optionally filtered by type or tag. " +
      "Results are sorted by most recent first.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["text", "link", "idea", "todo", "snippet"],
          description: "Filter by capture type",
        },
        tag: {
          type: "string",
          description: "Filter by tag (captures that include this tag)",
        },
        limit: {
          type: "number",
          description: "Max number of captures to return (default: 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "search_captures",
    description:
      "Search captures with a fuzzy text query. Splits query into terms and scores " +
      "captures by how many terms match in content, tags, and source. Returns top results.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query — multiple words are matched independently",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "delete_capture",
    description: "Permanently delete a capture by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The capture ID to delete",
        },
      },
      required: ["id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleCapture(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const content = input.content as string;
  if (!content) {
    return { success: false, output: "Content is required." };
  }

  const captureType = (input.type as string) ?? "text";
  const tags = (input.tags as string[]) ?? [];
  const source = input.source as string | undefined;

  const data = await loadCaptures();

  const capture: Capture = {
    id: randomUUID(),
    content,
    type: captureType,
    tags,
    captured_at: new Date().toISOString(),
  };

  if (source) capture.source = source;

  data.captures.push(capture);
  await saveCaptures(data);

  const tagsStr = tags.length > 0 ? `\nTags: ${tags.join(", ")}` : "";
  const sourceStr = source ? `\nSource: ${source}` : "";
  const preview =
    content.length > 80 ? content.slice(0, 80) + "..." : content;

  return {
    success: true,
    output:
      `Captured [${captureType}]: "${preview}"${tagsStr}${sourceStr}\n` +
      `ID: ${capture.id}`,
  };
}

export async function handleListCaptures(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const data = await loadCaptures();
  const filterType = input.type as string | undefined;
  const filterTag = input.tag as string | undefined;
  const limit = (input.limit as number) ?? 20;

  let filtered = data.captures;

  if (filterType) {
    filtered = filtered.filter((c) => c.type === filterType);
  }
  if (filterTag) {
    const tagLower = filterTag.toLowerCase();
    filtered = filtered.filter((c) =>
      c.tags.some((t) => t.toLowerCase() === tagLower)
    );
  }

  // Sort by most recent first
  filtered.sort(
    (a, b) =>
      new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
  );

  // Apply limit
  filtered = filtered.slice(0, limit);

  if (filtered.length === 0) {
    const total = data.captures.length;
    if (total === 0) {
      return {
        success: true,
        output: "No captures yet. Use the capture tool to save something.",
      };
    }
    return {
      success: true,
      output: `No captures match the filter. (${total} total captures exist.)`,
    };
  }

  const lines = filtered.map((c) => {
    const preview =
      c.content.length > 100 ? c.content.slice(0, 100) + "..." : c.content;
    const tagsStr = c.tags.length > 0 ? ` [${c.tags.join(", ")}]` : "";
    const sourceStr = c.source ? `\n  Source: ${c.source}` : "";
    const date = new Date(c.captured_at).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      `[${c.type}] ${preview}${tagsStr}\n` +
      `  ${date} | ID: ${c.id}${sourceStr}`
    );
  });

  const totalNote =
    data.captures.length > filtered.length
      ? ` (showing ${filtered.length} of ${data.captures.length} total)`
      : "";

  return {
    success: true,
    output: `Captures${totalNote}:\n\n${lines.join("\n\n")}`,
  };
}

export async function handleSearchCaptures(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const query = input.query as string;
  if (!query) {
    return { success: false, output: "Query is required." };
  }

  const data = await loadCaptures();

  if (data.captures.length === 0) {
    return {
      success: true,
      output: "No captures to search. Use the capture tool to save something first.",
    };
  }

  // Split query into lowercase terms
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) {
    return { success: false, output: "Query must contain at least one search term." };
  }

  // Score each capture by how many terms match
  const scored = data.captures.map((c) => {
    const searchable = [
      c.content.toLowerCase(),
      c.tags.join(" ").toLowerCase(),
      (c.source ?? "").toLowerCase(),
    ].join(" ");

    let score = 0;
    for (const term of terms) {
      if (searchable.includes(term)) {
        score++;
      }
    }

    return { capture: c, score };
  });

  // Filter to matches only, sort by score descending then most recent
  const results = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (
        new Date(b.capture.captured_at).getTime() -
        new Date(a.capture.captured_at).getTime()
      );
    })
    .slice(0, 20);

  if (results.length === 0) {
    return {
      success: true,
      output: `No captures match "${query}". (${data.captures.length} captures searched.)`,
    };
  }

  const lines = results.map((r) => {
    const c = r.capture;
    const preview =
      c.content.length > 100 ? c.content.slice(0, 100) + "..." : c.content;
    const tagsStr = c.tags.length > 0 ? ` [${c.tags.join(", ")}]` : "";
    const sourceStr = c.source ? `\n  Source: ${c.source}` : "";
    const date = new Date(c.captured_at).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    return (
      `[${c.type}] ${preview}${tagsStr} (score: ${r.score}/${terms.length})\n` +
      `  ${date} | ID: ${c.id}${sourceStr}`
    );
  });

  return {
    success: true,
    output: `Search results for "${query}" (${results.length} match${results.length !== 1 ? "es" : ""}):\n\n${lines.join("\n\n")}`,
  };
}

export async function handleDeleteCapture(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) {
    return { success: false, output: "Capture ID is required." };
  }

  const data = await loadCaptures();
  const index = data.captures.findIndex((c) => c.id === id);

  if (index === -1) {
    return { success: false, output: `No capture found with ID "${id}".` };
  }

  const removed = data.captures.splice(index, 1)[0];
  await saveCaptures(data);

  const preview =
    removed.content.length > 60
      ? removed.content.slice(0, 60) + "..."
      : removed.content;

  return {
    success: true,
    output: `Deleted capture [${removed.type}]: "${preview}"`,
  };
}
