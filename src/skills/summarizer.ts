import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { config } from "../config.js";
import { getProvider } from "../providers/factory.js";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const summarizerToolDefinitions: ToolDefinition[] = [
  {
    name: "summarize_document",
    description:
      "Summarize the contents of a local file. Supports .txt, .md, .csv, .json, and other text files. " +
      "Returns a concise summary in the requested style.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the file to summarize",
        },
        style: {
          type: "string",
          enum: ["brief", "detailed", "bullets"],
          description:
            "Summary style: 'brief' (1-2 sentences), 'detailed' (2-3 paragraphs), 'bullets' (bullet point list). Default: brief.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "summarize_url",
    description:
      "Fetch a URL and summarize its content. Works with web pages, API responses, and text content. " +
      "Returns a concise summary in the requested style.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch and summarize",
        },
        style: {
          type: "string",
          enum: ["brief", "detailed", "bullets"],
          description:
            "Summary style: 'brief' (1-2 sentences), 'detailed' (2-3 paragraphs), 'bullets' (bullet point list). Default: brief.",
        },
      },
      required: ["url"],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_INPUT_CHARS = 50_000;

function getStylePrompt(style: string): string {
  switch (style) {
    case "detailed":
      return "Provide a detailed summary in 2-3 paragraphs covering the main points, key details, and conclusions.";
    case "bullets":
      return "Provide a summary as a bullet point list. Each bullet should capture one key point or finding.";
    default:
      return "Provide a brief summary in 1-2 sentences capturing the essential point.";
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text;
  return text.slice(0, MAX_INPUT_CHARS) + "\n\n...[truncated — content exceeds 50k characters]";
}

function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const textExts = [
    ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".log",
    ".ts", ".js", ".py", ".java", ".c", ".cpp", ".h", ".go",
    ".rs", ".rb", ".php", ".sql", ".sh", ".bat", ".ps1",
  ];
  return textExts.includes(ext);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleSummarizeDocument(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const filePath = resolve(input.path as string);
  const style = (input.style as string) ?? "brief";

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return { success: false, output: `Cannot read file: ${filePath}` };
  }

  if (!content.trim()) {
    return { success: false, output: "File is empty." };
  }

  if (!isTextFile(filePath)) {
    return {
      success: false,
      output: `Unsupported file type: ${extname(filePath)}. Supported: text, markdown, CSV, JSON, code files.`,
    };
  }

  const provider = getProvider(config.llm);
  const stylePrompt = getStylePrompt(style);

  try {
    const response = await provider.chat({
      model: config.llm.model,
      maxTokens: 2048,
      system:
        "You are a precise document summarizer. Summarize the content provided by the user. " +
        "Focus on the most important information. Do not add opinions or information not present in the document.",
      tools: [],
      messages: [
        {
          role: "user",
          content: `${stylePrompt}\n\nDocument content:\n\n${truncate(content)}`,
        },
      ],
    });

    const textBlocks = response.content.filter((b) => b.type === "text");
    const summary = textBlocks.map((b) => b.text).join("\n") || "(no response)";

    return { success: true, output: summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Summarization failed: ${msg}` };
  }
}

export async function handleSummarizeUrl(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const url = input.url as string;
  const style = (input.style as string) ?? "brief";

  let content: string;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, output: `HTTP ${response.status}: ${response.statusText}` };
    }
    content = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to fetch URL: ${msg}` };
  }

  if (!content.trim()) {
    return { success: false, output: "URL returned empty content." };
  }

  const provider = getProvider(config.llm);
  const stylePrompt = getStylePrompt(style);

  try {
    const llmResponse = await provider.chat({
      model: config.llm.model,
      maxTokens: 2048,
      system:
        "You are a precise content summarizer. Summarize the web page content provided by the user. " +
        "If the content is HTML, focus on the meaningful text content, ignoring navigation, ads, and boilerplate. " +
        "Do not add opinions or information not present in the content.",
      tools: [],
      messages: [
        {
          role: "user",
          content: `${stylePrompt}\n\nContent from ${url}:\n\n${truncate(content)}`,
        },
      ],
    });

    const textBlocks = llmResponse.content.filter((b) => b.type === "text");
    const summary = textBlocks.map((b) => b.text).join("\n") || "(no response)";

    return { success: true, output: summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Summarization failed: ${msg}` };
  }
}
