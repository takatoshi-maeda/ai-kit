import OpenAI from "openai";
import type {
  LLMChatInput,
  LLMMessage,
  LLMResult,
  LLMUsage,
  ContentPart,
} from "../../types/llm.js";
import type { LLMToolCall } from "../../types/tool.js";
import type { LLMStreamEvent } from "../../types/stream-events.js";
import type { ModelCapabilities } from "../../types/model.js";
import type { LLMClient, PerplexityClientOptions } from "../client.js";
import { withRetry } from "../retry.js";
import { LLMApiError, RateLimitError } from "../../errors.js";

const PERPLEXITY_BASE_URL = "https://api.perplexity.ai";

export class PerplexityClient implements LLMClient {
  readonly provider = "perplexity" as const;
  readonly model: string;
  readonly capabilities: ModelCapabilities;

  private readonly client: OpenAI;
  private readonly options: PerplexityClientOptions;

  constructor(options: PerplexityClientOptions) {
    this.options = options;
    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl ?? PERPLEXITY_BASE_URL,
      timeout: options.requestTimeout,
    });
    this.capabilities = {
      supportsReasoning: false,
      supportsToolCalls: false,
      supportsStreaming: true,
      supportsImages: false,
      contextWindowSize: 128_000,
    };
  }

  async invoke(input: LLMChatInput): Promise<LLMResult> {
    const params = this.buildParams(input);
    const retryCount = this.options.retryCount ?? 0;

    const response = await withRetry(
      () =>
        this.client.chat.completions.create(params) as Promise<OpenAI.Chat.ChatCompletion>,
      { maxRetries: retryCount },
    ).catch((error) => {
      throw this.mapError(error);
    });

    return this.mapResponse(response);
  }

  async *stream(input: LLMChatInput): AsyncIterable<LLMStreamEvent> {
    const params = { ...this.buildParams(input), stream: true as const };

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(params);
    } catch (error) {
      throw this.mapError(error);
    }

    let fullText = "";
    let responseId: string | undefined;

    try {
      for await (const chunk of stream) {
        if (!responseId && chunk.id) {
          responseId = chunk.id;
          yield { type: "response.created", responseId };
        }

        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          fullText += delta.content;
          yield { type: "text.delta", delta: delta.content };
        }
      }

      yield { type: "text.done", text: fullText };

      // Build a synthetic completed result
      const result: LLMResult = {
        type: "message",
        content: fullText || null,
        toolCalls: [],
        usage: emptyUsage(),
        responseId: responseId ?? null,
        finishReason: "stop",
      };
      yield { type: "response.completed", result };
    } catch (error) {
      yield { type: "error", error: this.mapError(error) };
    }
  }

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  private buildParams(
    input: LLMChatInput,
  ): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    const messages = this.convertMessages(input);

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages,
      temperature: this.options.temperature ?? undefined,
      max_tokens: this.options.maxTokens ?? undefined,
      top_p: this.options.topP ?? undefined,
    };

    return params;
  }

  private convertMessages(
    input: LLMChatInput,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    // Prepend instructions as system message
    if (input.instructions) {
      messages.push({ role: "system", content: input.instructions });
    }

    for (const msg of input.messages) {
      switch (msg.role) {
        case "system":
          messages.push({
            role: "system",
            content: typeof msg.content === "string" ? msg.content : this.flattenContent(msg.content),
          });
          break;
        case "user":
          messages.push({
            role: "user",
            content: typeof msg.content === "string" ? msg.content : this.flattenContent(msg.content),
          });
          break;
        case "assistant":
          messages.push({
            role: "assistant",
            content: typeof msg.content === "string" ? msg.content : this.flattenContent(msg.content),
          });
          break;
        // Skip tool messages - Perplexity doesn't support tools
      }
    }

    return messages;
  }

  private flattenContent(parts: ContentPart[]): string {
    return parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
  }

  private mapResponse(response: OpenAI.Chat.ChatCompletion): LLMResult {
    const choice = response.choices[0];
    const textContent = choice?.message?.content ?? null;

    let finishReason: LLMResult["finishReason"] = "stop";
    if (choice?.finish_reason === "length") {
      finishReason = "length";
    } else if (choice?.finish_reason === "content_filter") {
      finishReason = "content_filter";
    }

    return {
      type: "message",
      content: textContent,
      toolCalls: [],
      usage: this.mapUsage(response.usage),
      responseId: response.id,
      finishReason,
    };
  }

  private mapUsage(usage?: OpenAI.CompletionUsage): LLMUsage {
    if (!usage) return emptyUsage();

    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cachedInputTokens: 0,
      totalTokens: usage.total_tokens,
      inputCost: 0,
      outputCost: 0,
      cacheCost: 0,
      totalCost: 0,
    };
  }

  private mapError(error: unknown): Error {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 429) {
        return new RateLimitError(error.message, {
          provider: "perplexity",
          statusCode: error.status,
        });
      }
      return new LLMApiError(error.message, {
        provider: "perplexity",
        statusCode: error.status,
      });
    }
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
}

function emptyUsage(): LLMUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
  };
}
