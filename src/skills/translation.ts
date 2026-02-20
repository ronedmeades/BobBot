import { config } from "../config.js";
import { getProvider } from "../providers/factory.js";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Tool Definitions ---

export const translationToolDefinitions: ToolDefinition[] = [
  {
    name: "translate_text",
    description:
      "Translate text from one language to another. Auto-detects the source language if not specified. Returns only the translated text.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The text to translate",
        },
        to: {
          type: "string",
          description: "Target language (e.g. 'Spanish', 'French', 'Japanese', 'zh-CN')",
        },
        from: {
          type: "string",
          description: "Source language (optional — auto-detected if omitted)",
        },
      },
      required: ["text", "to"],
    },
  },
  {
    name: "detect_language",
    description:
      "Detect the language of a given text. Returns the language name and confidence level.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The text to identify the language of",
        },
      },
      required: ["text"],
    },
  },
];

// --- Tool Handlers ---

export async function handleTranslateText(input: Record<string, unknown>): Promise<ToolResult> {
  const text = input.text as string;
  const to = input.to as string;
  const from = input.from as string | undefined;

  if (!text || !to) {
    return { success: false, output: "Both 'text' and 'to' parameters are required." };
  }

  const fromClause = from ? `from ${from} ` : "";
  const systemPrompt =
    `You are a professional translator. Translate the user's text ${fromClause}into ${to}. ` +
    `Return ONLY the translated text — no explanations, no notes, no original text. ` +
    `Preserve the original formatting (line breaks, punctuation, capitalization style).`;

  try {
    const provider = getProvider(config.llm);
    const response = await provider.chat({
      model: config.llm.model,
      maxTokens: 2048,
      system: systemPrompt,
      tools: [],
      messages: [{ role: "user", content: text }],
    });

    const textBlocks = response.content.filter((b) => b.type === "text");
    let result = textBlocks.map((b) => b.text).join("\n");

    if (!result) {
      return { success: false, output: "Translation returned empty result." };
    }

    if (response.stopReason === "max_tokens") {
      result += '\n\n...\n\n*Long response, type "continue" to continue.*';
    }

    return { success: true, output: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Translation failed: ${message}` };
  }
}

export async function handleDetectLanguage(input: Record<string, unknown>): Promise<ToolResult> {
  const text = input.text as string;

  if (!text) {
    return { success: false, output: "'text' parameter is required." };
  }

  const systemPrompt =
    "You are a language identification expert. Identify the language of the user's text. " +
    "Respond with ONLY a JSON object in this exact format: " +
    '{"language": "English", "confidence": "high"}. ' +
    'The confidence field should be "high", "medium", or "low". ' +
    "Do not include any other text or explanation.";

  try {
    const provider = getProvider(config.llm);
    const response = await provider.chat({
      model: config.llm.model,
      maxTokens: 2048,
      system: systemPrompt,
      tools: [],
      messages: [{ role: "user", content: text }],
    });

    const textBlocks = response.content.filter((b) => b.type === "text");
    let result = textBlocks.map((b) => b.text).join("\n");

    if (!result) {
      return { success: false, output: "Language detection returned empty result." };
    }

    if (response.stopReason === "max_tokens") {
      result += '\n\n...\n\n*Long response, type "continue" to continue.*';
    }

    return { success: true, output: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Language detection failed: ${message}` };
  }
}
