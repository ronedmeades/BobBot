import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  ChatOptions,
  VisionOptions,
  ProviderResponse,
  VisionResponse,
  Message,
  ContentBlock,
  ResponseBlock,
} from "./types.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(options: ChatOptions): Promise<ProviderResponse> {
    const messages = options.messages.map(
      (m): Anthropic.MessageParam => ({
        role: m.role,
        // Anthropic SDK accepts string | ContentBlock[] — our types match structurally
        content: m.content as Anthropic.MessageParam["content"],
      })
    );

    const response = await this.client.messages.create(
      {
        model: options.model,
        max_tokens: options.maxTokens,
        system: options.system,
        tools: options.tools as Anthropic.Tool[],
        messages,
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    const content: ResponseBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
      // Skip thinking blocks, redacted thinking, server tool use, etc.
    }

    const stopReason =
      response.stop_reason === "end_turn"
        ? "end_turn"
        : response.stop_reason === "tool_use"
          ? "tool_use"
          : "max_tokens";

    return { content, stopReason } satisfies ProviderResponse;
  }

  async vision(options: VisionOptions): Promise<VisionResponse> {
    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: options.mediaType,
                data: options.imageBase64,
              },
            } as Anthropic.ImageBlockParam,
            { type: "text", text: options.prompt },
          ],
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return { text, truncated: response.stop_reason === "max_tokens" };
  }
}
