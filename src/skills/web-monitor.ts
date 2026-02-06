import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { events } from "../dashboard/events.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Types ---

interface WatchEntry {
  id: string;
  type: "url" | "keyword";
  target: string;
  label?: string;
  lastHash: string | null;
  lastContent: string | null;
  lastChecked: string | null;
  changeCount: number;
  enabled: boolean;
  createdAt: string;
  /** For keyword watches: sources to search */
  sources?: string[];
}

interface WatchesFile {
  version: number;
  watches: WatchEntry[];
}

// --- Persistence ---

const MEMORY_DIR = resolve("memory");
const WATCHES_FILE = join(MEMORY_DIR, "web-watches.json");

async function loadWatches(): Promise<WatchesFile> {
  try {
    const raw = await readFile(WATCHES_FILE, "utf-8");
    return JSON.parse(raw) as WatchesFile;
  } catch {
    return { version: 1, watches: [] };
  }
}

async function saveWatches(data: WatchesFile): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
  await writeFile(WATCHES_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// --- Helpers ---

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "BobBot/1.0 (web-monitor)",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    // Strip HTML tags for cleaner comparison
    return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function searchHackerNews(keyword: string): Promise<string[]> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=5`;
  const response = await fetch(url);
  if (!response.ok) return [];
  const data = (await response.json()) as {
    hits: Array<{ title: string; url: string; objectID: string; created_at: string }>;
  };
  return data.hits.map(
    (h) => `[HN] ${h.title} — ${h.url || `https://news.ycombinator.com/item?id=${h.objectID}`}`
  );
}

async function searchReddit(keyword: string): Promise<string[]> {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&limit=5`;
  const response = await fetch(url, {
    headers: { "User-Agent": "BobBot/1.0 (web-monitor)" },
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    data: { children: Array<{ data: { title: string; permalink: string; subreddit: string } }> };
  };
  return data.data.children.map(
    (c) => `[r/${c.data.subreddit}] ${c.data.title} — https://reddit.com${c.data.permalink}`
  );
}

// --- Tool Definitions ---

export const webMonitorToolDefinitions: Anthropic.Tool[] = [
  {
    name: "watch_url",
    description:
      "Watch a URL for content changes. Bob will periodically fetch the page and alert you when the content changes. " +
      "Good for monitoring product pages, documentation, status pages, job postings, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to monitor for changes",
        },
        label: {
          type: "string",
          description: "Optional friendly label (e.g. 'Claude API pricing page')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "watch_keywords",
    description:
      "Watch for mentions of keywords across the web. Searches Hacker News and Reddit for new mentions. " +
      "Good for monitoring brand mentions, tech announcements, competitor activity, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        keywords: {
          type: "string",
          description: "Keywords or phrase to monitor (e.g. 'Claude API', 'FHIR R4')",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Sources to search: 'hackernews', 'reddit' (default: both)",
        },
        label: {
          type: "string",
          description: "Optional friendly label for this watch",
        },
      },
      required: ["keywords"],
    },
  },
  {
    name: "list_watches",
    description: "List all active web monitors/watches with their status and change history.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "remove_watch",
    description: "Remove a web monitor/watch by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The watch ID to remove",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "check_watches_now",
    description:
      "Manually trigger all web monitors to check for changes right now, regardless of their schedule. " +
      "Returns a summary of what changed.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Tool Handlers ---

export async function handleWatchUrl(input: Record<string, unknown>): Promise<ToolResult> {
  const url = input.url as string;
  const label = input.label as string | undefined;

  if (!url) {
    return { success: false, output: "URL is required." };
  }

  const data = await loadWatches();

  // Check for duplicate
  const existing = data.watches.find((w) => w.type === "url" && w.target === url);
  if (existing) {
    return {
      success: false,
      output: `Already watching this URL (id: ${existing.id}). Remove it first to re-add.`,
    };
  }

  // Fetch initial content to establish baseline
  let initialHash: string | null = null;
  let initialContent: string | null = null;
  try {
    const content = await fetchPage(url);
    initialHash = hashContent(content);
    initialContent = content.slice(0, 500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: `Could not fetch the URL to establish a baseline: ${msg}`,
    };
  }

  const watch: WatchEntry = {
    id: generateId(),
    type: "url",
    target: url,
    label,
    lastHash: initialHash,
    lastContent: initialContent,
    lastChecked: new Date().toISOString(),
    changeCount: 0,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  data.watches.push(watch);
  await saveWatches(data);

  const displayLabel = label ? ` (${label})` : "";
  return {
    success: true,
    output:
      `Now watching${displayLabel}: ${url}\n` +
      `Watch ID: ${watch.id}\n` +
      `Baseline hash: ${initialHash}\n` +
      `I'll alert you when the content changes.`,
  };
}

export async function handleWatchKeywords(input: Record<string, unknown>): Promise<ToolResult> {
  const keywords = input.keywords as string;
  const sources = (input.sources as string[]) ?? ["hackernews", "reddit"];
  const label = input.label as string | undefined;

  if (!keywords) {
    return { success: false, output: "Keywords are required." };
  }

  const data = await loadWatches();

  // Fetch initial results for baseline
  const results: string[] = [];
  if (sources.includes("hackernews")) {
    results.push(...(await searchHackerNews(keywords)));
  }
  if (sources.includes("reddit")) {
    results.push(...(await searchReddit(keywords)));
  }

  const initialContent = results.join("\n");
  const initialHash = hashContent(initialContent);

  const watch: WatchEntry = {
    id: generateId(),
    type: "keyword",
    target: keywords,
    label,
    sources,
    lastHash: initialHash,
    lastContent: initialContent.slice(0, 1000),
    lastChecked: new Date().toISOString(),
    changeCount: 0,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  data.watches.push(watch);
  await saveWatches(data);

  const displayLabel = label ? ` (${label})` : "";
  return {
    success: true,
    output:
      `Now monitoring keywords${displayLabel}: "${keywords}"\n` +
      `Watch ID: ${watch.id}\n` +
      `Sources: ${sources.join(", ")}\n` +
      `Found ${results.length} existing mention(s) as baseline.\n` +
      `I'll alert you when new mentions appear.`,
  };
}

export async function handleListWatches(): Promise<ToolResult> {
  const data = await loadWatches();

  if (data.watches.length === 0) {
    return { success: true, output: "No active web monitors." };
  }

  const lines: string[] = [];
  for (const w of data.watches) {
    const status = w.enabled ? "ACTIVE" : "PAUSED";
    const typeLabel = w.type === "url" ? `URL: ${w.target}` : `Keywords: "${w.target}"`;
    const labelStr = w.label ? ` (${w.label})` : "";
    const lastChecked = w.lastChecked ? new Date(w.lastChecked).toLocaleString() : "never";

    lines.push(
      `[${status}] ${w.id}${labelStr}\n` +
        `  ${typeLabel}\n` +
        `  Last checked: ${lastChecked} | Changes detected: ${w.changeCount}`
    );
  }

  return {
    success: true,
    output: `Web monitors (${data.watches.length}):\n\n${lines.join("\n\n")}`,
  };
}

export async function handleRemoveWatch(input: Record<string, unknown>): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) {
    return { success: false, output: "Watch ID is required." };
  }

  const data = await loadWatches();
  const index = data.watches.findIndex((w) => w.id === id);
  if (index === -1) {
    return { success: false, output: `No watch found with ID "${id}".` };
  }

  const removed = data.watches.splice(index, 1)[0];
  await saveWatches(data);

  return {
    success: true,
    output: `Removed watch "${removed.label || removed.target}" (${removed.id}).`,
  };
}

export async function handleCheckWatchesNow(): Promise<ToolResult> {
  const changes = await checkAllWatches();
  if (changes.length === 0) {
    return { success: true, output: "All monitors checked — no changes detected." };
  }
  return {
    success: true,
    output: `Changes detected:\n\n${changes.join("\n\n")}`,
  };
}

// --- Check Loop ---

/**
 * Check all watches for changes. Called by the scheduler.
 * Returns a list of change descriptions.
 */
export async function checkAllWatches(): Promise<string[]> {
  const data = await loadWatches();
  const changes: string[] = [];
  let modified = false;

  for (const watch of data.watches) {
    if (!watch.enabled) continue;

    try {
      let currentContent: string;

      if (watch.type === "url") {
        currentContent = await fetchPage(watch.target);
      } else {
        // Keyword watch
        const results: string[] = [];
        const sources = watch.sources ?? ["hackernews", "reddit"];
        if (sources.includes("hackernews")) {
          results.push(...(await searchHackerNews(watch.target)));
        }
        if (sources.includes("reddit")) {
          results.push(...(await searchReddit(watch.target)));
        }
        currentContent = results.join("\n");
      }

      const currentHash = hashContent(currentContent);

      if (watch.lastHash && currentHash !== watch.lastHash) {
        watch.changeCount++;
        modified = true;

        const label = watch.label || watch.target;
        const changeMsg =
          watch.type === "url"
            ? `URL change detected for "${label}" (${watch.target})`
            : `New mentions found for "${label}" keywords:\n${currentContent.slice(0, 500)}`;

        changes.push(changeMsg);

        events.emitEvent("task:update", {
          taskId: `watch-${watch.id}`,
          status: "completed",
          description: changeMsg,
        });
      }

      watch.lastHash = currentHash;
      watch.lastContent = currentContent.slice(0, 1000);
      watch.lastChecked = new Date().toISOString();
      modified = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[web-monitor] Error checking watch ${watch.id}: ${msg}`);
    }
  }

  if (modified) {
    await saveWatches(data);
  }

  return changes;
}
