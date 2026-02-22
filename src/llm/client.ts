import type { LLMChatInput, LLMResult } from "../types/llm.js";
import type { ModelCapabilities } from "../types/model.js";
import type { LLMStreamEvent } from "../types/stream-events.js";

export type LLMProvider = "openai" | "anthropic" | "google" | "perplexity";

export interface LLMClient {
  readonly model: string;
  readonly provider: LLMProvider;
  readonly capabilities: ModelCapabilities;
  invoke(input: LLMChatInput): Promise<LLMResult>;
  stream(input: LLMChatInput): AsyncIterable<LLMStreamEvent>;
  estimateTokens(content: string): number;
}

export interface LLMClientOptionsBase {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  requestTimeout?: number;
  retryCount?: number;
}

export interface OpenAIClientOptions extends LLMClientOptionsBase {
  provider: "openai";
  organization?: string;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningSummary?: "auto" | "concise" | "detailed";
}

export interface AnthropicClientOptions extends LLMClientOptionsBase {
  provider: "anthropic";
  thinking?: { budgetTokens: number };
}

export interface GoogleClientOptions extends LLMClientOptionsBase {
  provider: "google";
  topK?: number;
  thinkingBudget?: number;
  safetySettings?: GoogleSafetySettings[];
}

export interface GoogleSafetySettings {
  category: string;
  threshold: string;
}

export interface PerplexityClientOptions extends LLMClientOptionsBase {
  provider: "perplexity";
  searchDomainFilter?: string[];
  searchRecency?: "day" | "week" | "month" | "year";
}

export type LLMClientOptions =
  | OpenAIClientOptions
  | AnthropicClientOptions
  | GoogleClientOptions
  | PerplexityClientOptions;
