import {
  GoogleGenerativeAI,
  type Content,
  type Part,
  type FunctionDeclarationsTool,
  type FunctionDeclaration,
  type GenerateContentResult,
} from "@google/generative-ai";
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

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async chat(options: ChatOptions): Promise<ProviderResponse> {
    // Convert tool definitions to Gemini format
    const functionDeclarations: FunctionDeclaration[] = options.tools.map(
      (t) => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema as unknown as FunctionDeclaration["parameters"],
      })
    );

    const tools: FunctionDeclarationsTool[] = [{ functionDeclarations }];

    const model = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction: options.system,
      tools,
      generationConfig: {
        maxOutputTokens: options.maxTokens,
      },
    });

    // Convert messages to Gemini Content format
    const contents: Content[] = [];

    for (const msg of options.messages) {
      const role = msg.role === "assistant" ? "model" : "user";

      if (typeof msg.content === "string") {
        contents.push({ role, parts: [{ text: msg.content }] });
      } else {
        const parts: Part[] = [];

        for (const block of msg.content) {
          switch (block.type) {
            case "text":
              parts.push({ text: block.text });
              break;

            case "image":
              parts.push({
                inlineData: {
                  mimeType: block.source.media_type,
                  data: block.source.data,
                },
              });
              break;

            case "tool_use":
              // Assistant's function call — Gemini uses functionCall part
              parts.push({
                functionCall: {
                  name: block.name,
                  args: block.input,
                },
              });
              break;

            case "tool_result":
              // Tool results use functionResponse — must be on "function" role
              // We'll handle role separately below
              parts.push({
                functionResponse: {
                  name: findToolName(options.messages, block.tool_use_id),
                  response: { result: block.content },
                },
              });
              break;
          }
        }

        // Gemini expects function responses with role "function"
        const hasFunctionResponse = msg.content.some(
          (b) => b.type === "tool_result"
        );
        contents.push({
          role: hasFunctionResponse ? "function" : role,
          parts,
        });
      }
    }

    // Gemini SDK doesn't natively support AbortSignal — race with signal
    const contentRequest = model.generateContent({ contents });
    const result = options.signal
      ? await Promise.race([
          contentRequest,
          new Promise<never>((_, reject) => {
            if (options.signal!.aborted) reject(new DOMException("Aborted", "AbortError"));
            options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          }),
        ])
      : await contentRequest;
    const response = result.response;

    const content: ResponseBlock[] = [];
    const candidate = response.candidates?.[0];

    if (!candidate) {
      return {
        content: [{ type: "text", text: "(no response)" }],
        stopReason: "end_turn",
      };
    }

    let hasToolCalls = false;
    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        content.push({ type: "text", text: part.text });
      }
      if (part.functionCall) {
        hasToolCalls = true;
        content.push({
          type: "tool_use",
          // Gemini doesn't use IDs for tool calls — generate one
          id: `gemini_${part.functionCall.name}_${Date.now()}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "(no response)" });
    }

    const stopReason = hasToolCalls
      ? "tool_use"
      : candidate.finishReason === "MAX_TOKENS"
        ? "max_tokens"
        : "end_turn";

    return { content, stopReason };
  }

  async vision(options: VisionOptions): Promise<VisionResponse> {
    const model = this.client.getGenerativeModel({
      model: options.model,
      generationConfig: {
        maxOutputTokens: options.maxTokens,
      },
    });

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: options.mediaType,
                data: options.imageBase64,
              },
            },
            { text: options.prompt },
          ],
        },
      ],
    });

    const text = result.response.text() || "(no response)";
    const candidate = result.response.candidates?.[0];
    const truncated = candidate?.finishReason === "MAX_TOKENS";
    return { text, truncated };
  }
}

/**
 * Look up the tool name for a given tool_use_id by scanning previous messages.
 * Gemini requires the function name (not an ID) for functionResponse.
 */
function findToolName(messages: Message[], toolUseId: string): string {
  for (const msg of messages) {
    if (typeof msg.content !== "string") {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return block.name;
        }
      }
    }
  }
  return "unknown";
}
