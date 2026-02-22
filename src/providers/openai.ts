import OpenAI from "openai";
import type {
  LLMProvider,
  ChatOptions,
  VisionOptions,
  ProviderResponse,
  VisionResponse,
  Message,
  ContentBlock,
  ResponseBlock,
  ToolDefinition,
} from "./types.js";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  }

  async chat(options: ChatOptions): Promise<ProviderResponse> {
    // Convert tool definitions: input_schema → function.parameters
    const tools: OpenAI.ChatCompletionTool[] = options.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as OpenAI.FunctionParameters,
      },
    }));

    // Build OpenAI messages: system prompt first, then conversation
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: options.system },
    ];

    for (const msg of options.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          messages.push({ role: "user", content: msg.content });
        } else {
          // Content array — could be tool results or mixed content
          const toolResults = msg.content.filter(
            (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
              b.type === "tool_result"
          );
          if (toolResults.length > 0) {
            // Anthropic sends tool results as a single user message with an array.
            // OpenAI expects separate `role: "tool"` messages for each result.
            for (const tr of toolResults) {
              messages.push({
                role: "tool",
                tool_call_id: tr.tool_use_id,
                content: tr.content,
              });
            }
          } else {
            // Regular multi-part user content (text + images)
            const parts: OpenAI.ChatCompletionContentPart[] = msg.content.map(
              (block) => {
                if (block.type === "text") {
                  return { type: "text" as const, text: block.text };
                }
                if (block.type === "image") {
                  return {
                    type: "image_url" as const,
                    image_url: {
                      url: `data:${block.source.media_type};base64,${block.source.data}`,
                    },
                  };
                }
                // Shouldn't reach here in user messages, but be safe
                return { type: "text" as const, text: JSON.stringify(block) };
              }
            );
            messages.push({ role: "user", content: parts });
          }
        }
      } else {
        // Assistant message
        if (typeof msg.content === "string") {
          messages.push({ role: "assistant", content: msg.content });
        } else {
          // Assistant message with tool calls
          const textParts = msg.content.filter(
            (b): b is Extract<ContentBlock, { type: "text" }> =>
              b.type === "text"
          );
          const toolCalls = msg.content.filter(
            (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
              b.type === "tool_use"
          );
          messages.push({
            role: "assistant",
            content: textParts.map((t) => t.text).join("\n") || null,
            tool_calls:
              toolCalls.length > 0
                ? toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function" as const,
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.input),
                    },
                  }))
                : undefined,
          });
        }
      }
    }

    const response = await this.client.chat.completions.create(
      {
        model: options.model,
        max_tokens: options.maxTokens,
        tools,
        messages,
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    const choice = response.choices[0];
    if (!choice) {
      return { content: [{ type: "text", text: "(no response)" }], stopReason: "end_turn" };
    }

    // Convert response back to our generic format
    const content: ResponseBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type === "function") {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
          });
        }
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "(no response)" });
    }

    const stopReason =
      choice.finish_reason === "tool_calls"
        ? "tool_use"
        : choice.finish_reason === "length"
          ? "max_tokens"
          : "end_turn";

    return { content, stopReason };
  }

  async vision(options: VisionOptions): Promise<VisionResponse> {
    const response = await this.client.chat.completions.create({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${options.mediaType};base64,${options.imageBase64}`,
              },
            },
            { type: "text", text: options.prompt },
          ],
        },
      ],
    });

    const text = response.choices[0]?.message.content ?? "(no response)";
    const truncated = response.choices[0]?.finish_reason === "length";
    return { text, truncated };
  }
}
