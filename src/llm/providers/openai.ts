import OpenAI from "openai";
import type {
  LLMChatInput,
  LLMMessage,
  LLMResult,
  LLMUsage,
  ContentPart,
  ResponseFormat,
} from "../../types/llm.js";
import type { LLMToolCall } from "../../types/tool.js";
import type { LLMStreamEvent } from "../../types/stream-events.js";
import type { ModelCapabilities } from "../../types/model.js";
import type { LLMClient, OpenAIClientOptions } from "../client.js";
import { withRetry } from "../retry.js";
import { toolToJsonSchema } from "../tool/define.js";
import {
  LLMApiError,
  RateLimitError,
  ContextLengthExceededError,
} from "../../errors.js";
import type { ToolDefinition } from "../../types/tool.js";

type ResponseInput = OpenAI.Responses.ResponseCreateParamsNonStreaming["input"];
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

export class OpenAIClient implements LLMClient {
  readonly provider = "openai" as const;
  readonly model: string;
  readonly capabilities: ModelCapabilities;

  private readonly client: OpenAI;
  private readonly options: OpenAIClientOptions;

  constructor(options: OpenAIClientOptions) {
    this.options = options;
    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      organization: options.organization,
      timeout: options.requestTimeout,
    });
    this.capabilities = {
      supportsReasoning: true,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsImages: true,
      contextWindowSize: 128_000,
    };
  }

  async invoke(input: LLMChatInput): Promise<LLMResult> {
    const params = this.buildParams(input);
    const retryCount = this.options.retryCount ?? 0;

    const response = await withRetry(
      () => this.client.responses.create(params),
      { maxRetries: retryCount },
    ).catch((error) => {
      throw this.mapError(error);
    });

    return this.mapResponse(response);
  }

  async *stream(input: LLMChatInput): AsyncIterable<LLMStreamEvent> {
    const { stream: _unused, ...baseParams } = this.buildParams(input);

    let stream: ReturnType<typeof this.client.responses.stream>;
    try {
      stream = this.client.responses.stream(baseParams);
    } catch (error) {
      throw this.mapError(error);
    }

    let responseId: string | undefined;
    const toolCalls = new Map<string, { name: string; args: string }>();
    let fullText = "";
    let reasoningText = "";

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "response.created":
            responseId = event.response.id;
            yield { type: "response.created", responseId: event.response.id };
            break;

          case "response.output_text.delta":
            fullText += event.delta;
            yield { type: "text.delta", delta: event.delta };
            break;

          case "response.output_text.done":
            yield { type: "text.done", text: event.text };
            break;

          case "response.function_call_arguments.delta": {
            const existing = toolCalls.get(event.item_id);
            if (existing) {
              existing.args += event.delta;
            } else {
              toolCalls.set(event.item_id, { name: "", args: event.delta });
            }
            yield {
              type: "tool_call.arguments.delta",
              toolCallId: event.item_id,
              name: existing?.name ?? "",
              delta: event.delta,
            };
            break;
          }

          case "response.function_call_arguments.done": {
            const tc = toolCalls.get(event.item_id);
            const name = tc?.name ?? "";
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(event.arguments);
            } catch {
              // leave as empty object
            }
            yield {
              type: "tool_call.arguments.done",
              toolCallId: event.item_id,
              name,
              arguments: args,
            };
            break;
          }

          case "response.output_item.added": {
            if (event.item.type === "function_call") {
              const fc = event.item as OpenAI.Responses.ResponseFunctionToolCall;
              const itemId = fc.id ?? fc.call_id;
              toolCalls.set(itemId, { name: fc.name, args: "" });
            }
            break;
          }

          case "response.reasoning_summary_text.delta":
            reasoningText += event.delta;
            yield { type: "reasoning.delta", delta: event.delta };
            break;

          case "response.reasoning_summary_text.done":
            yield { type: "reasoning.done", text: event.text };
            break;

          case "response.completed": {
            const result = this.mapResponse(event.response);
            yield { type: "usage", usage: result.usage };
            yield { type: "response.completed", result };
            break;
          }

          case "response.failed": {
            const errMsg =
              event.response.error?.message ?? "Response failed";
            yield {
              type: "response.failed",
              error: new LLMApiError(errMsg, { provider: "openai" }),
            };
            break;
          }

          default:
            // Ignore events we don't map
            break;
        }
      }
    } catch (error) {
      yield { type: "error", error: this.mapError(error) };
    }
  }

  estimateTokens(content: string): number {
    // Rough estimate: ~4 chars per token for English
    return Math.ceil(content.length / 4);
  }

  private buildParams(
    input: LLMChatInput,
  ): OpenAI.Responses.ResponseCreateParamsNonStreaming {
    const inputItems = this.convertMessages(input.messages);
    const tools = input.tools?.map((t) => this.convertTool(t));

    const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: this.model,
      input: inputItems,
      stream: false,
    };

    if (input.instructions) {
      params.instructions = input.instructions;
    }

    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    if (input.toolChoice) {
      params.tool_choice = input.toolChoice;
    }

    if (input.parallelToolCalls !== undefined) {
      params.parallel_tool_calls = input.parallelToolCalls;
    }

    if (this.options.temperature !== undefined) {
      params.temperature = this.options.temperature;
    }

    if (this.options.maxTokens !== undefined) {
      params.max_output_tokens = this.options.maxTokens;
    }

    if (this.options.topP !== undefined) {
      params.top_p = this.options.topP;
    }

    if (this.options.reasoningEffort || this.options.reasoningSummary) {
      params.reasoning = {
        effort: this.options.reasoningEffort ?? undefined,
        summary: this.options.reasoningSummary ?? undefined,
      };
    }

    if (input.responseFormat) {
      params.text = this.convertResponseFormat(input.responseFormat);
    }

    return params;
  }

  private convertMessages(messages: LLMMessage[]): ResponseInput {
    const items: ResponseInputItem[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "tool") {
        const toolRun: LLMMessage[] = [];
        let j = i;
        while (j < messages.length && messages[j].role === "tool") {
          toolRun.push(messages[j]);
          j++;
        }

        // OpenAI Responses API requires matching function_call items
        // before function_call_output items in the same request input.
        for (const toolMsg of toolRun) {
          if (!toolMsg.toolCallId) continue;
          items.push({
            type: "function_call",
            call_id: toolMsg.toolCallId,
            name: toolMsg.name ?? "tool",
            arguments: "{}",
          });
        }

        for (const toolMsg of toolRun) {
          if (!toolMsg.toolCallId) continue;
          items.push({
            type: "function_call_output",
            call_id: toolMsg.toolCallId,
            output:
              typeof toolMsg.content === "string"
                ? toolMsg.content
                : JSON.stringify(toolMsg.content),
          });
        }

        i = j - 1;
        continue;
      }

      switch (msg.role) {
        case "system":
          items.push({
            type: "message",
            role: "developer",
            content:
              typeof msg.content === "string"
                ? msg.content
                : this.convertContentParts(msg.content),
          });
          break;

        case "user":
          items.push({
            type: "message",
            role: "user",
            content:
              typeof msg.content === "string"
                ? msg.content
                : this.convertContentParts(msg.content),
          });
          break;

        case "assistant":
          items.push({
            type: "message",
            role: "assistant",
            content:
              typeof msg.content === "string"
                ? msg.content
                : this.convertContentParts(msg.content),
          });
          break;

      }
    }

    return items;
  }

  private convertContentParts(
    parts: ContentPart[],
  ): OpenAI.Responses.ResponseInputContent[] {
    return parts.map((part): OpenAI.Responses.ResponseInputContent => {
      switch (part.type) {
        case "text":
          return { type: "input_text", text: part.text };
        case "image":
          if (part.source.type === "url") {
            return {
              type: "input_image",
              image_url: part.source.url,
              detail: "auto",
            };
          }
          return {
            type: "input_image",
            image_url: `data:${part.source.mediaType};base64,${part.source.data}`,
            detail: "auto",
          };
        case "audio":
          // Audio is handled at message-level input, not as content part
          return { type: "input_text", text: `[Audio: ${part.format}]` };
      }
    });
  }

  private convertTool(tool: ToolDefinition): OpenAI.Responses.FunctionTool {
    const schema = toolToJsonSchema(tool);
    return {
      type: "function",
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      strict: false,
    };
  }

  private convertResponseFormat(
    format: ResponseFormat,
  ): OpenAI.Responses.ResponseTextConfig {
    if (format.type === "text") {
      return { format: { type: "text" } };
    }

    const { zodToJsonSchema } = require("zod-to-json-schema") as typeof import("zod-to-json-schema");
    const schema = zodToJsonSchema(format.schema, { $refStrategy: "none" }) as Record<string, unknown>;
    const { $schema, ...rest } = schema;

    return {
      format: {
        type: "json_schema",
        name: format.name ?? "response",
        schema: rest,
        strict: true,
      },
    };
  }

  private mapResponse(response: OpenAI.Responses.Response): LLMResult {
    const toolCalls: LLMToolCall[] = [];
    let textContent = "";

    for (const item of response.output) {
      if (item.type === "message") {
        for (const part of item.content) {
          if (part.type === "output_text") {
            textContent += part.text;
          }
        }
      } else if (item.type === "function_call") {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(item.arguments);
        } catch {
          // leave as empty object
        }
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          arguments: args,
        });
      }
    }

    const hasToolCalls = toolCalls.length > 0;
    const usage = this.mapUsage(response.usage);

    let finishReason: LLMResult["finishReason"] = "stop";
    if (hasToolCalls) {
      finishReason = "tool_use";
    } else if (response.status === "incomplete") {
      finishReason = "length";
    }

    return {
      type: hasToolCalls ? "tool_use" : "message",
      content: textContent || null,
      toolCalls,
      usage,
      responseId: response.id,
      finishReason,
    };
  }

  private mapUsage(usage?: OpenAI.Responses.ResponseUsage): LLMUsage {
    if (!usage) {
      return emptyUsage();
    }

    const cachedInputTokens =
      usage.input_tokens_details?.cached_tokens ?? 0;

    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens,
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
        const retryAfter = error.headers?.["retry-after"];
        return new RateLimitError(error.message, {
          provider: "openai",
          statusCode: error.status,
          retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
        });
      }
      if (
        error.status === 400 &&
        error.message?.includes("context_length_exceeded")
      ) {
        return new ContextLengthExceededError(error.message, {
          provider: "openai",
          statusCode: error.status,
        });
      }
      return new LLMApiError(error.message, {
        provider: "openai",
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
