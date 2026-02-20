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
// Platform specs
// ---------------------------------------------------------------------------

type Platform = "linkedin" | "facebook" | "instagram" | "twitter";

const ALL_PLATFORMS: Platform[] = ["linkedin", "facebook", "instagram", "twitter"];

interface PlatformSpec {
  label: string;
  charLimit: number;
  hashtagCount: string;
  hashtagStyle: string;
  toneGuidance: string;
  formatNotes: string;
}

const PLATFORM_SPECS: Record<Platform, PlatformSpec> = {
  linkedin: {
    label: "LinkedIn",
    charLimit: 3000,
    hashtagCount: "3-5",
    hashtagStyle: "professional, industry-specific, placed at the end of the post",
    toneGuidance: "Professional and thought-leadership oriented. Write as a knowledgeable industry insider sharing valuable insight.",
    formatNotes:
      "Start with a strong opening hook (1 short line that grabs attention). " +
      "Use short paragraphs (1-2 sentences each). Add line breaks between paragraphs for readability. " +
      "Focus on the value/insight/lesson. End with a call-to-action or question to drive engagement. " +
      "Place hashtags on a separate final line.",
  },
  facebook: {
    label: "Facebook",
    charLimit: 63206,
    hashtagCount: "3-5",
    hashtagStyle: "broad, conversational, inline or at the end",
    toneGuidance: "Conversational and engaging. Write like you're talking to friends who share your interests.",
    formatNotes:
      "Start with a hook — a question, surprising fact, or relatable statement. " +
      "Keep it medium length (3-6 sentences ideal). Use emojis sparingly but naturally. " +
      "End with a question or call-to-action to encourage comments. " +
      "Hashtags can be inline or at the end, keep them casual.",
  },
  instagram: {
    label: "Instagram",
    charLimit: 2200,
    hashtagCount: "20-30",
    hashtagStyle: "mix of broad reach and niche tags, placed in a block at the end separated by line breaks",
    toneGuidance: "Authentic and visual-first. The caption should complement an image, not replace it.",
    formatNotes:
      "First line is crucial — it shows in the feed preview before 'more'. Make it count. " +
      "Use line breaks and short paragraphs. Emojis are welcome and expected. " +
      "Include a call-to-action (save this, share with a friend, drop a comment). " +
      "Add hashtags in a separate block after 3+ line breaks. Mix popular and niche hashtags.",
  },
  twitter: {
    label: "Twitter/X",
    charLimit: 280,
    hashtagCount: "1-3",
    hashtagStyle: "integrated naturally into the text, trending-style",
    toneGuidance: "Punchy and concise. Every word must earn its place. Be clever, direct, or provocative.",
    formatNotes:
      "MUST be 280 characters or fewer — this is a hard limit. " +
      "No fluff, no filler. Front-load the most important/interesting part. " +
      "Hashtags count toward the character limit — use 1-3 max, integrated into the text. " +
      "If linking to something, leave ~25 chars for a URL placeholder [link]. " +
      "A thread hook ('A thread on...') is acceptable if the message is complex.",
  },
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const socialMediaToolDefinitions: ToolDefinition[] = [
  {
    name: "generate_social_post",
    description:
      "Generate platform-optimized social media posts from a message and optional image. " +
      "Produces tailored copy for each platform (LinkedIn, Facebook, Instagram, Twitter/X) " +
      "with appropriate tone, length, hashtags, and formatting conventions. " +
      "If an image is provided, the post will reference the visual content.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description:
            "The core message, tagline, or description of what to promote. " +
            "This is the raw content that will be adapted for each platform.",
        },
        image_path: {
          type: "string",
          description:
            "Optional path to an image to include with the post. " +
            "The image will be analyzed and the post copy will reference its visual content.",
        },
        platforms: {
          type: "array",
          items: {
            type: "string",
            enum: ["linkedin", "facebook", "instagram", "twitter"],
          },
          description:
            "Which platforms to generate posts for. Default: all four (linkedin, facebook, instagram, twitter).",
        },
        tone: {
          type: "string",
          enum: ["professional", "casual", "enthusiastic", "technical", "storytelling"],
          description: "Overall tone for the posts. Default: professional.",
        },
        context: {
          type: "string",
          description:
            "Optional extra context about the product, project, audience, or campaign. " +
            "E.g. 'B2B SaaS targeting healthcare CTOs' or 'launching next week, building hype'.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "suggest_social_hashtags",
    description:
      "Generate relevant hashtags for a topic, tailored to each platform's conventions. " +
      "LinkedIn: 3-5 professional/industry tags. Instagram: 20-30 mixed reach tags. " +
      "Twitter: 1-3 trending-style tags. Facebook: 3-5 broad conversational tags.",
    input_schema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          description: "What the post is about (e.g. 'AI personal agents', 'medical records software').",
        },
        platform: {
          type: "string",
          enum: ["linkedin", "facebook", "instagram", "twitter"],
          description: "Generate hashtags for a specific platform only. If omitted, generates for all four.",
        },
        count: {
          type: "number",
          description: "Override the default number of hashtags per platform.",
        },
      },
      required: ["topic"],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMediaType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/jpeg";
  }
}

function buildPostPrompt(platform: Platform, message: string, tone: string, context: string, hasImage: boolean): string {
  const spec = PLATFORM_SPECS[platform];

  return `You are an expert social media copywriter. Generate a ${spec.label} post.

CONTENT TO PROMOTE:
${message}
${context ? `\nADDITIONAL CONTEXT:\n${context}` : ""}
${hasImage ? "\nNote: This post will include an image. Reference the visual content naturally in your copy — describe what viewers will see or how it relates to the message." : ""}

TONE: ${tone}
${spec.toneGuidance}

FORMAT REQUIREMENTS:
- Character limit: ${spec.charLimit} characters maximum${platform === "twitter" ? " (HARD LIMIT — count carefully)" : ""}
- ${spec.formatNotes}

HASHTAG REQUIREMENTS:
- Include ${spec.hashtagCount} hashtags
- Style: ${spec.hashtagStyle}

OUTPUT:
Return ONLY the post text (including hashtags). No explanations, no labels, no metadata. Just the ready-to-post content.`;
}

function buildHashtagPrompt(topic: string, platform: Platform, count?: number): string {
  const spec = PLATFORM_SPECS[platform];
  const num = count ?? spec.hashtagCount;

  return `Generate ${num} hashtags for a ${spec.label} post about: "${topic}"

Hashtag style: ${spec.hashtagStyle}

Rules:
- Each hashtag must start with #
- No spaces within hashtags (use CamelCase for multi-word)
- Mix of popular/broad reach and niche/specific tags
- Relevant to the topic and appropriate for ${spec.label}

Return ONLY the hashtags, one per line. No explanations.`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleGenerateSocialPost(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const message = input.message as string;
  if (!message) {
    return { success: false, output: "message is required" };
  }

  const imagePath = input.image_path ? resolve(input.image_path as string) : null;
  const platforms = (input.platforms as Platform[] | undefined) ?? ALL_PLATFORMS;
  const tone = (input.tone as string) ?? "professional";
  const context = (input.context as string) ?? "";

  // Validate platforms
  for (const p of platforms) {
    if (!ALL_PLATFORMS.includes(p)) {
      return { success: false, output: `Unknown platform: "${p}". Valid: ${ALL_PLATFORMS.join(", ")}` };
    }
  }

  // Load image if provided
  let imageBase64: string | null = null;
  let mediaType = "image/jpeg";
  if (imagePath) {
    try {
      const imageBuffer = await readFile(imagePath);
      imageBase64 = imageBuffer.toString("base64");
      mediaType = getMediaType(imagePath);
    } catch {
      return { success: false, output: `Cannot read image: ${imagePath}` };
    }
  }

  const provider = getProvider(config.llm);
  const results: string[] = [];

  for (const platform of platforms) {
    const prompt = buildPostPrompt(platform, message, tone, context, !!imageBase64);
    const spec = PLATFORM_SPECS[platform];

    try {
      let postText: string;

      if (imageBase64) {
        // Use vision to analyze image + generate post
        const visionResult = await provider.vision({
          model: config.llm.model,
          maxTokens: 1024,
          imageBase64,
          mediaType,
          prompt,
        });
        postText = visionResult.text;
        if (visionResult.truncated) postText += '\n\n...\n\n*Long response, type "continue" to continue.*';
      } else {
        // Text-only generation via chat
        const response = await provider.chat({
          model: config.llm.model,
          maxTokens: 1024,
          system: "You are an expert social media copywriter. Return ONLY the post content, nothing else.",
          tools: [],
          messages: [{ role: "user", content: prompt }],
        });
        const textBlocks = response.content.filter((b) => b.type === "text");
        postText = textBlocks.map((b) => b.text).join("\n") || "(no response)";
        if (response.stopReason === "max_tokens") postText += '\n\n...\n\n*Long response, type "continue" to continue.*';
      }

      const charCount = postText.length;
      const limitNote = platform === "twitter" ? `/${spec.charLimit}` : "";

      results.push(
        `--- ${spec.label} ---\n${postText.trim()}\n\nCharacter count: ${charCount}${limitNote}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`--- ${spec.label} ---\nError generating post: ${msg}`);
    }
  }

  return {
    success: true,
    output: results.join("\n\n"),
  };
}

export async function handleSuggestSocialHashtags(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const topic = input.topic as string;
  if (!topic) {
    return { success: false, output: "topic is required" };
  }

  const singlePlatform = input.platform as Platform | undefined;
  const count = input.count as number | undefined;

  const platforms: Platform[] = singlePlatform ? [singlePlatform] : ALL_PLATFORMS;

  // Validate platform
  if (singlePlatform && !ALL_PLATFORMS.includes(singlePlatform)) {
    return { success: false, output: `Unknown platform: "${singlePlatform}". Valid: ${ALL_PLATFORMS.join(", ")}` };
  }

  const provider = getProvider(config.llm);
  const results: string[] = [];

  for (const platform of platforms) {
    const prompt = buildHashtagPrompt(topic, platform, count);
    const spec = PLATFORM_SPECS[platform];

    try {
      const response = await provider.chat({
        model: config.llm.model,
        maxTokens: 512,
        system: "You are a social media hashtag expert. Return only hashtags, one per line.",
        tools: [],
        messages: [{ role: "user", content: prompt }],
      });
      const textBlocks = response.content.filter((b) => b.type === "text");
      let hashtags = textBlocks.map((b) => b.text).join("\n") || "(no response)";
      if (response.stopReason === "max_tokens") {
        hashtags += '\n\n...\n\n*Long response, type "continue" to continue.*';
      }

      results.push(`--- ${spec.label} ---\n${hashtags.trim()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`--- ${spec.label} ---\nError: ${msg}`);
    }
  }

  return {
    success: true,
    output: results.join("\n\n"),
  };
}
