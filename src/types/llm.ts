import type { ZodType } from "zod";
import type { LLMToolCall } from "./tool.js";
import type { ToolDefinition } from "./tool.js";

export type ImageSource =
  | { type: "base64"; mediaType: string; data: string }
  | { type: "url"; url: string };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | { type: "audio"; data: string; format: string };

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  toolCallId?: string;
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_schema"; schema: ZodType; name?: string };

export interface LLMChatInput {
  messages: LLMMessage[];
  instructions?: string;
  tools?: ToolDefinition[];
  toolChoice?: "none" | "auto" | "required";
  parallelToolCalls?: boolean;
  responseFormat?: ResponseFormat;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  totalCost: number;
}

export interface LLMResult {
  type: "message" | "tool_use";
  content: string | null;
  toolCalls: LLMToolCall[];
  usage: LLMUsage;
  responseId: string | null;
  finishReason: "stop" | "tool_use" | "length" | "content_filter";
}
