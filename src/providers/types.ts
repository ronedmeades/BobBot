/**
 * Provider-agnostic LLM interfaces.
 *
 * ToolDefinition intentionally matches `Anthropic.Tool` shape so existing
 * skill files can be used without modification (TypeScript structural typing).
 */

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Message content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ToolCallContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextContent | ImageContent | ToolCallContent | ToolResultContent;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

// ---------------------------------------------------------------------------
// Provider response
// ---------------------------------------------------------------------------

export interface ResponseTextBlock {
  type: "text";
  text: string;
}

export interface ResponseToolCall {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ResponseBlock = ResponseTextBlock | ResponseToolCall;

export interface ProviderResponse {
  content: ResponseBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

// ---------------------------------------------------------------------------
// Chat & vision options
// ---------------------------------------------------------------------------

export interface ChatOptions {
  model: string;
  maxTokens: number;
  system: string;
  tools: ToolDefinition[];
  messages: Message[];
}

export interface VisionOptions {
  model: string;
  maxTokens: number;
  imageBase64: string;
  mediaType: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// LLM config (used by factory + config)
// ---------------------------------------------------------------------------

export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// LLM provider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  readonly name: string;
  chat(options: ChatOptions): Promise<ProviderResponse>;
  vision(options: VisionOptions): Promise<string>;
}
