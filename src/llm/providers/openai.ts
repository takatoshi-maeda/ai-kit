import OpenAI from "openai";
import type {
  LLMChatInput,
  LLMMessage,
  LLMResult,
  LLMUsage,
  ContentPart,
  ResponseFormat,
} from "../../types/llm.js";
import {
  isFunctionToolDefinition,
  isProviderNativeTool,
  type AgentTool,
  type LLMToolCall,
  type ProviderNativeTool,
} from "../../types/tool.js";
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

type ResponseInput = OpenAI.Responses.ResponseCreateParamsNonStreaming["input"];
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
const OPENAI_APPLY_PATCH_DEBUG_ENV = "CODEFLEET_DEBUG_OPENAI_APPLY_PATCH";
const OPENAI_STREAM_DEBUG_ENV = "CODEFLEET_DEBUG_OPENAI_STREAM";

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
    const pseudoToolCallFilter = new PseudoToolCallTextFilter();

    try {
      for await (const event of stream) {
        debugOpenAIStreamEvent("received", event);
        const rawEvent = event as {
          type: string;
          item_id?: unknown;
          item?: unknown;
          delta?: unknown;
        };

        // The OpenAI SDK type union can lag provider event rollout. Normalize
        // raw apply_patch artifact events here while keeping the existing typed
        // switch for stable event variants.
        if (
          rawEvent.type === "response.output_item.added" &&
          isApplyPatchOutputItem(rawEvent.item)
        ) {
          const itemId = normalizeResponseOutputItemId(rawEvent.item, rawEvent.item_id);
          if (itemId) {
            yield {
              type: "output_item.added",
              itemId,
              item: this.normalizeApplyPatchArtifactItem(rawEvent.item),
              contentType: "artifact",
            };
          }
          continue;
        }

        if (rawEvent.type === "response.apply_patch_call_operation_diff.delta") {
          const itemId = normalizeResponseOutputItemId(undefined, rawEvent.item_id);
          if (itemId && typeof rawEvent.delta === "string") {
            yield {
              type: "artifact.delta",
              itemId,
              delta: rawEvent.delta,
            };
          }
          continue;
        }

        if (
          rawEvent.type === "response.output_item.done" &&
          isApplyPatchOutputItem(rawEvent.item)
        ) {
          const itemId = normalizeResponseOutputItemId(rawEvent.item, rawEvent.item_id);
          if (itemId) {
            yield {
              type: "output_item.done",
              itemId,
              item: this.normalizeApplyPatchArtifactItem(rawEvent.item),
              contentType: "artifact",
            };
          }
          continue;
        }

        switch (event.type) {
          case "response.created":
            responseId = event.response.id;
            yield { type: "response.created", responseId: event.response.id };
            break;

          case "response.output_text.delta": {
            const visibleDelta = pseudoToolCallFilter.consumeDelta(event.delta);
            if (visibleDelta.length > 0) {
              fullText += visibleDelta;
              yield { type: "text.delta", delta: visibleDelta };
            }
            break;
          }

          case "response.output_text.done": {
            const visibleText = sanitizeVisibleAssistantText(event.text);
            if (visibleText.length > 0) {
              yield { type: "text.done", text: visibleText };
            }
            break;
          }

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
        const providerRawItems = this.getProviderRawInputItems(msg);
        if (providerRawItems.length > 0) {
          items.push(...providerRawItems);
          continue;
        }

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

  private getProviderRawInputItems(message: LLMMessage): ResponseInputItem[] {
    const inputItems = message.extra?.providerRaw?.inputItems;
    if (message.extra?.providerRaw?.provider !== "openai" || !Array.isArray(inputItems)) {
      return [];
    }
    return inputItems as ResponseInputItem[];
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

  private convertTool(tool: AgentTool): OpenAI.Responses.Tool {
    if (isFunctionToolDefinition(tool)) {
      const schema = toolToJsonSchema(tool);
      return {
        type: "function",
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
        strict: false,
      };
    }

    return this.convertProviderNativeTool(tool);
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
      const itemType = (item as { type: string }).type;
      if (itemType === "message") {
        const messageItem = item as OpenAI.Responses.ResponseOutputMessage;
        for (const part of messageItem.content) {
          if (part.type === "output_text") {
            textContent += sanitizeVisibleAssistantText(part.text);
          }
        }
      } else if (itemType === "function_call") {
        toolCalls.push(this.mapFunctionToolCall(item as OpenAI.Responses.ResponseFunctionToolCall));
      } else if (itemType === "shell_call" || itemType === "local_shell_call") {
        toolCalls.push(this.mapShellToolCall(item));
      } else if (itemType === "apply_patch_call") {
        toolCalls.push(this.mapApplyPatchToolCall(item));
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

  private convertProviderNativeTool(
    tool: ProviderNativeTool,
  ): OpenAI.Responses.Tool {
    if (tool.type === "shell") {
      return ({
        type: "shell",
        environment: { type: "local" },
      } as unknown) as OpenAI.Responses.Tool;
    }

    return ({
      type: "apply_patch",
    } as unknown) as OpenAI.Responses.Tool;
  }

  private mapFunctionToolCall(
    item: OpenAI.Responses.ResponseFunctionToolCall,
  ): LLMToolCall {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(item.arguments);
    } catch {
      // leave as empty object
    }
    return {
      id: item.call_id,
      name: item.name,
      arguments: args,
      executionKind: "user_function",
      provider: "openai",
      extra: {
        providerRaw: {
          provider: "openai",
          outputItems: [item],
        },
      },
    };
  }

  private mapShellToolCall(item: OpenAI.Responses.ResponseOutputItem): LLMToolCall {
    const shellItem = item as OpenAI.Responses.ResponseOutputItem & {
      call_id?: string;
      id?: string;
      action?: Record<string, unknown>;
    };
    return {
      id: shellItem.call_id ?? shellItem.id ?? crypto.randomUUID(),
      name: "shell",
      arguments: shellItem.action ?? {},
      executionKind: "provider_native",
      provider: "openai",
      extra: {
        providerRaw: {
          provider: "openai",
          outputItems: [item],
        },
      },
    };
  }

  private mapApplyPatchToolCall(
    item: OpenAI.Responses.ResponseOutputItem,
  ): LLMToolCall {
    const patchItem = item as OpenAI.Responses.ResponseOutputItem & {
      call_id?: string;
      id?: string;
      arguments?: string;
      operation?: unknown;
      input?: Array<{ content?: unknown[] }>;
    };
    const firstContent =
      Array.isArray(patchItem.input) &&
        Array.isArray(patchItem.input[0]?.content)
        ? patchItem.input[0].content[0]
        : undefined;
    const operation = this.parseApplyPatchOperation(
      patchItem.arguments ?? patchItem.operation ?? firstContent ?? patchItem.input,
    );
    debugOpenAIApplyPatch("mapApplyPatchToolCall", {
      itemId: patchItem.call_id ?? patchItem.id ?? null,
      rawItem: item,
      selectedValue: patchItem.arguments ?? patchItem.operation ?? firstContent ?? patchItem.input ?? null,
      parsedOperation: operation,
    });
    return {
      id: patchItem.call_id ?? patchItem.id ?? crypto.randomUUID(),
      name: "apply_patch",
      arguments: operation,
      executionKind: "provider_native",
      provider: "openai",
      extra: {
        providerRaw: {
          provider: "openai",
          outputItems: [item],
        },
      },
    };
  }

  private parseApplyPatchOperation(value: unknown): Record<string, unknown> {
    // OpenAI apply_patch payloads vary across runtimes. Normalize both raw patch
    // strings and JSON-encoded operation payloads before the native runtime sees them.
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        if (value.includes("*** Begin Patch")) {
          return { patch: value };
        }
      }
      return {};
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "text" in value &&
      typeof (value as { text?: unknown }).text === "string"
    ) {
      return this.parseApplyPatchOperation((value as { text: string }).text);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsed = this.parseApplyPatchOperation(entry);
        if (Object.keys(parsed).length > 0) {
          return parsed;
        }
      }
      return {};
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "content" in value &&
      Array.isArray((value as { content?: unknown[] }).content)
    ) {
      return this.parseApplyPatchOperation((value as { content: unknown[] }).content);
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "input" in value
    ) {
      const parsed = this.parseApplyPatchOperation((value as { input?: unknown }).input);
      if (Object.keys(parsed).length > 0) {
        return parsed;
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private normalizeApplyPatchArtifactItem(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object") {
      return {};
    }
    const item = value as {
      operation?: unknown;
      arguments?: unknown;
      input?: unknown;
    };
    return this.parseApplyPatchOperation(
      item.operation ?? item.arguments ?? item.input ?? value,
    );
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

function debugOpenAIApplyPatch(stage: string, payload: Record<string, unknown>): void {
  const envValue = process.env[OPENAI_APPLY_PATCH_DEBUG_ENV]?.trim().toLowerCase();
  if (envValue !== "1" && envValue !== "true") {
    return;
  }
  console.error(
    `[ai-kit:openai:apply_patch] stage=${stage} payload=${safeSerializeForDebug(payload)}`,
  );
}

function debugOpenAIStreamEvent(stage: string, payload: unknown): void {
  const envValue = process.env[OPENAI_STREAM_DEBUG_ENV]?.trim().toLowerCase();
  if (envValue !== "1" && envValue !== "true") {
    return;
  }
  console.error(
    `[ai-kit:openai:stream] stage=${stage} payload=${safeSerializeForDebug(payload)}`,
  );
}

function safeSerializeForDebug(value: unknown): string {
  try {
    return JSON.stringify(value, createDebugReplacer());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ serializationError: message });
  }
}

function createDebugReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "string" && value.length > 2_000) {
      return `${value.slice(0, 2_000)}...[truncated ${value.length - 2_000} chars]`;
    }
    if (value && typeof value === "object") {
      if (seen.has(value as object)) {
        return "[circular]";
      }
      seen.add(value as object);
    }
    return value;
  };
}

function sanitizeVisibleAssistantText(text: string): string {
  return text.replace(/\s*\[tool_call:[\s\S]*?\)\]/g, "");
}

class PseudoToolCallTextFilter {
  private buffer = "";
  private suppressing = false;

  consumeDelta(delta: string): string {
    this.buffer += delta;
    let visible = "";

    while (this.buffer.length > 0) {
      if (this.suppressing) {
        const endIndex = this.buffer.indexOf(")]");
        if (endIndex === -1) {
          return visible;
        }
        this.buffer = this.buffer.slice(endIndex + 2);
        this.suppressing = false;
        continue;
      }

      const markerIndex = this.buffer.indexOf("[tool_call:");
      if (markerIndex === -1) {
        const safeFlushLength = Math.max(0, this.buffer.length - "[tool_call:".length);
        if (safeFlushLength === 0) {
          return visible;
        }
        visible += this.buffer.slice(0, safeFlushLength);
        this.buffer = this.buffer.slice(safeFlushLength);
        return visible;
      }

      visible += this.buffer.slice(0, markerIndex);
      this.buffer = this.buffer.slice(markerIndex);
      this.suppressing = true;
    }

    return visible;
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

function isApplyPatchOutputItem(item: unknown): item is OpenAI.Responses.ResponseOutputItem & {
  type: "apply_patch_call";
  id?: string;
  call_id?: string;
} {
  return (
    !!item &&
    typeof item === "object" &&
    (item as { type?: unknown }).type === "apply_patch_call"
  );
}

function normalizeResponseOutputItemId(
  item: unknown,
  fallbackItemId?: unknown,
): string | undefined {
  if (typeof fallbackItemId === "string" && fallbackItemId.length > 0) {
    return fallbackItemId;
  }
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const outputItem = item as { id?: unknown; call_id?: unknown };
  if (typeof outputItem.id === "string" && outputItem.id.length > 0) {
    return outputItem.id;
  }
  if (typeof outputItem.call_id === "string" && outputItem.call_id.length > 0) {
    return outputItem.call_id;
  }
  return undefined;
}
