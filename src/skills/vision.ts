import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { config } from "../config.js";
import { getProvider } from "../providers/factory.js";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

function getMediaType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/jpeg";
  }
}

// --- Tool Definitions ---

export const visionToolDefinitions: ToolDefinition[] = [
  {
    name: "analyze_image",
    description:
      "Analyze a local image using AI vision capabilities. Can describe, extract text, identify objects, or answer questions about any image.",
    input_schema: {
      type: "object" as const,
      properties: {
        image_path: {
          type: "string",
          description: "Local path to the image file",
        },
        prompt: {
          type: "string",
          description: "What to analyze or describe about the image (e.g. 'Describe this poster', 'Extract all text', 'What style of art is this?')",
        },
      },
      required: ["image_path", "prompt"],
    },
  },
  {
    name: "analyze_poster_for_listing",
    description:
      "Analyze a poster image and generate eBay listing content. Returns structured JSON with title (max 80 chars), HTML description, and item specifics (Artist, Size, Type, Style, Subject, Era, Original/Reproduction).",
    input_schema: {
      type: "object" as const,
      properties: {
        image_path: {
          type: "string",
          description: "Local path to the poster image",
        },
        additional_info: {
          type: "string",
          description: "Optional extra context (e.g. 'reproduction, 24x36 inches, glossy cardstock')",
        },
      },
      required: ["image_path"],
    },
  },
];

// --- Tool Handlers ---

export async function handleAnalyzeImage(input: Record<string, unknown>): Promise<ToolResult> {
  const imagePath = resolve(input.image_path as string);
  const prompt = input.prompt as string;

  const imageBuffer = await readFile(imagePath);
  const base64 = imageBuffer.toString("base64");
  const mediaType = getMediaType(imagePath);

  const provider = getProvider(config.llm);
  const result = await provider.vision({
    model: config.llm.model,
    maxTokens: 2048,
    imageBase64: base64,
    mediaType,
    prompt,
  });

  let output = result.text || "(no response)";
  if (result.truncated) output += '\n\n...\n\n*Long response, type "continue" to continue.*';
  return { success: true, output };
}

export async function handleAnalyzePosterForListing(input: Record<string, unknown>): Promise<ToolResult> {
  const imagePath = resolve(input.image_path as string);
  const additionalInfo = (input.additional_info as string) ?? "";

  const imageBuffer = await readFile(imagePath);
  const base64 = imageBuffer.toString("base64");
  const mediaType = getMediaType(imagePath);

  const extraContext = additionalInfo ? `\n\nAdditional info provided by the seller: ${additionalInfo}` : "";

  const provider = getProvider(config.llm);
  const result = await provider.vision({
    model: config.llm.model,
    maxTokens: 2048,
    imageBase64: base64,
    mediaType,
    prompt: `You are an expert eBay listing writer for posters and art prints. Analyze this poster image and generate listing content.${extraContext}

Return ONLY valid JSON with this exact structure:
{
  "title": "eBay listing title, max 80 characters, keyword-rich for search",
  "description": "<div>HTML description, compelling listing copy, 2-3 paragraphs</div>",
  "item_specifics": {
    "Artist": "artist name or 'Unknown'",
    "Type": "Poster / Art Print / Lithograph / etc",
    "Style": "Art Deco / Pop Art / Minimalist / Vintage / etc",
    "Subject": "what the poster depicts",
    "Era": "estimated decade or period",
    "Original/Reproduction": "Original or Reproduction",
    "Size": "estimated dimensions if visible",
    "Features": "Unframed / Framed / Signed / Limited Edition / etc"
  }
}

Be specific and descriptive. The title should be optimized for eBay search (include key terms buyers would search for). The description should be compelling and professional.`,
  });

  let output = result.text || "(no response)";
  if (result.truncated) output += '\n\n...\n\n*Long response, type "continue" to continue.*';
  return { success: true, output };
}
