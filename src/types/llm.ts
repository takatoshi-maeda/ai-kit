import type { ZodType } from "zod";
import type { AgentTool, LLMToolCall, ProviderRawTransport, ToolExecutionKind } from "./tool.js";

export type ImageSource =
  | { type: "base64"; mediaType: string; data: string }
  | { type: "url"; url: string };

export type FileSource =
  | { type: "asset-ref"; assetRef: string }
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };

export type FileContentPart = {
  type: "file";
  file: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    source: FileSource;
  };
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | FileContentPart
  | { type: "audio"; data: string; format: string };

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  toolCallId?: string;
  extra?: {
    tool?: {
      call: {
        id: string;
        name: string;
        executionKind: ToolExecutionKind;
        provider?: "openai";
        arguments: Record<string, unknown>;
        extra?: Record<string, unknown>;
      };
      result?: {
        content: string;
        isError?: boolean;
        extra?: Record<string, unknown>;
      };
    };
    providerRaw?: ProviderRawTransport;
    [key: string]: unknown;
  };
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_schema"; schema: ZodType; name?: string };

export interface LLMChatInput {
  messages: LLMMessage[];
  instructions?: string;
  tools?: AgentTool[];
  toolChoice?: "none" | "auto" | "required";
  parallelToolCalls?: boolean;
  responseFormat?: ResponseFormat;
  previousResponseId?: string;
}

export interface LLMCallOptions {
  signal?: AbortSignal;
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
