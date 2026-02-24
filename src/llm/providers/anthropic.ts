import Anthropic from "@anthropic-ai/sdk";
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
import type { LLMClient, AnthropicClientOptions } from "../client.js";
import { withRetry } from "../retry.js";
import { toolToJsonSchema } from "../tool/define.js";
import {
  LLMApiError,
  RateLimitError,
  ContextLengthExceededError,
} from "../../errors.js";
import type { ToolDefinition } from "../../types/tool.js";

export class AnthropicClient implements LLMClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  readonly capabilities: ModelCapabilities;

  private readonly client: Anthropic;
  private readonly options: AnthropicClientOptions;

  constructor(options: AnthropicClientOptions) {
    this.options = options;
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      timeout: options.requestTimeout,
    });
    this.capabilities = {
      supportsReasoning: true,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsImages: true,
      contextWindowSize: 200_000,
    };
  }

  async invoke(input: LLMChatInput): Promise<LLMResult> {
    const params = this.buildParams(input);
    const retryCount = this.options.retryCount ?? 0;

    const response = await withRetry(
      () => this.client.messages.create(params),
      { maxRetries: retryCount },
    ).catch((error) => {
      throw this.mapError(error);
    });

    return this.mapResponse(response as Anthropic.Message);
  }

  async *stream(input: LLMChatInput): AsyncIterable<LLMStreamEvent> {
    const params = this.buildParams(input);

    let stream: ReturnType<typeof this.client.messages.stream>;
    try {
      stream = this.client.messages.stream(params);
    } catch (error) {
      throw this.mapError(error);
    }

    type ActiveBlock = {
      type: "text" | "tool_use" | "thinking";
      toolCallId?: string;
      name?: string;
      textBuffer: string;
      argsBuffer: string;
      thinkingBuffer: string;
    };

    // Track active content blocks for streaming
    const activeBlocks = new Map<number, ActiveBlock>();

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            yield { type: "response.created", responseId: event.message.id };
            break;

          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              activeBlocks.set(event.index, {
                type: "tool_use",
                toolCallId: block.id,
                name: block.name,
                textBuffer: "",
                argsBuffer: "",
                thinkingBuffer: "",
              });
            } else if (block.type === "thinking") {
              activeBlocks.set(event.index, {
                type: "thinking",
                textBuffer: "",
                argsBuffer: "",
                thinkingBuffer: "",
              });
            } else {
              activeBlocks.set(event.index, {
                type: "text",
                textBuffer: "",
                argsBuffer: "",
                thinkingBuffer: "",
              });
            }
            break;
          }

          case "content_block_delta": {
            const blockInfo = activeBlocks.get(event.index);
            if (event.delta.type === "text_delta") {
              if (blockInfo?.type === "text") {
                blockInfo.textBuffer += event.delta.text;
              }
              yield { type: "text.delta", delta: event.delta.text };
            } else if (event.delta.type === "input_json_delta" && blockInfo) {
              if (blockInfo.type === "tool_use") {
                blockInfo.argsBuffer += event.delta.partial_json;
              }
              yield {
                type: "tool_call.arguments.delta",
                toolCallId: blockInfo.toolCallId ?? "",
                name: blockInfo.name ?? "",
                delta: event.delta.partial_json,
              };
            } else if (event.delta.type === "thinking_delta") {
              if (blockInfo?.type === "thinking") {
                blockInfo.thinkingBuffer += event.delta.thinking;
              }
              yield { type: "reasoning.delta", delta: event.delta.thinking };
            }
            break;
          }

          case "content_block_stop": {
            const stoppedBlock = activeBlocks.get(event.index);
            if (!stoppedBlock) {
              break;
            }

            if (stoppedBlock.type === "text" && stoppedBlock.textBuffer) {
              yield { type: "text.done", text: stoppedBlock.textBuffer };
            }

            if (stoppedBlock.type === "thinking" && stoppedBlock.thinkingBuffer) {
              yield { type: "reasoning.done", text: stoppedBlock.thinkingBuffer };
            }

            if (stoppedBlock.type === "tool_use") {
              let args: Record<string, unknown> = {};
              if (stoppedBlock.argsBuffer.trim()) {
                try {
                  args = JSON.parse(stoppedBlock.argsBuffer);
                } catch {
                  // Keep empty object for malformed partial JSON
                }
              }
              yield {
                type: "tool_call.arguments.done",
                toolCallId: stoppedBlock.toolCallId ?? "",
                name: stoppedBlock.name ?? "",
                arguments: args,
              };
            }
            activeBlocks.delete(event.index);
            break;
          }

          case "message_delta": {
            // Usage update at end
            break;
          }

          case "message_stop":
            break;
        }
      }

      // Get final message for result
      const finalMessage = await stream.finalMessage();
      const result = this.mapResponse(finalMessage);
      yield { type: "usage", usage: result.usage };
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
  ): Anthropic.MessageCreateParams {
    const { systemMessages, chatMessages } = this.separateSystemMessages(
      input.messages,
    );

    const messages = this.convertMessages(chatMessages);
    const tools = input.tools?.map((t) => this.convertTool(t));

    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      messages,
      max_tokens: this.options.maxTokens ?? 4096,
    };

    // System prompt
    const systemParts: string[] = [];
    if (input.instructions) systemParts.push(input.instructions);
    for (const sm of systemMessages) {
      systemParts.push(
        typeof sm.content === "string" ? sm.content : sm.content.map((p) => (p.type === "text" ? p.text : "")).join(""),
      );
    }
    if (systemParts.length > 0) {
      params.system = systemParts.join("\n\n");
    }

    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    if (input.toolChoice) {
      params.tool_choice = this.convertToolChoice(input.toolChoice);
    }

    if (this.options.temperature !== undefined) {
      params.temperature = this.options.temperature;
    }

    if (this.options.topP !== undefined) {
      params.top_p = this.options.topP;
    }

    if (this.options.thinking) {
      params.thinking = {
        type: "enabled",
        budget_tokens: this.options.thinking.budgetTokens,
      };
    }

    return params;
  }

  private convertMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
    const converted: Anthropic.MessageParam[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "tool") {
        converted.push(this.convertMessage(msg));
        continue;
      }

      const toolRun: LLMMessage[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        toolRun.push(messages[j]);
        j++;
      }

      let assistant = converted[converted.length - 1];
      if (!assistant || assistant.role !== "assistant") {
        assistant = { role: "assistant", content: [] };
        converted.push(assistant);
      }

      if (typeof assistant.content === "string") {
        assistant.content = [{ type: "text", text: assistant.content }];
      }

      const assistantBlocks = assistant.content as Anthropic.ContentBlockParam[];
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

      for (const toolMsg of toolRun) {
        const toolUseId = toolMsg.toolCallId ?? "";
        const toolName = toolMsg.name ?? "tool";
        const alreadyExists = assistantBlocks.some(
          (b) => b.type === "tool_use" && b.id === toolUseId,
        );

        if (!alreadyExists && toolUseId) {
          assistantBlocks.push({
            type: "tool_use",
            id: toolUseId,
            name: toolName,
            input: {},
          });
        }

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: typeof toolMsg.content === "string"
            ? toolMsg.content
            : JSON.stringify(toolMsg.content),
        });
      }

      converted.push({
        role: "user",
        content: toolResultBlocks,
      });

      i = j - 1;
    }

    return converted;
  }

  private separateSystemMessages(
    messages: LLMMessage[],
  ): { systemMessages: LLMMessage[]; chatMessages: LLMMessage[] } {
    const systemMessages: LLMMessage[] = [];
    const chatMessages: LLMMessage[] = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systemMessages.push(msg);
      } else {
        chatMessages.push(msg);
      }
    }
    return { systemMessages, chatMessages };
  }

  private convertMessage(
    msg: LLMMessage,
  ): Anthropic.MessageParam {
    if (msg.role === "tool") {
      throw new Error("Tool messages must be converted via convertMessages");
    }

    const role = msg.role === "user" ? "user" : "assistant";

    if (typeof msg.content === "string") {
      return { role, content: msg.content };
    }

    return {
      role,
      content: msg.content.map((p) => this.convertContentPart(p)),
    };
  }

  private convertContentPart(
    part: ContentPart,
  ): Anthropic.ContentBlockParam {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        if (part.source.type === "url") {
          return {
            type: "image",
            source: { type: "url", url: part.source.url },
          };
        }
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: part.source.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: part.source.data,
          },
        };
      case "audio":
        // Anthropic doesn't natively support audio, send as text
        return { type: "text", text: `[Audio: ${part.format}]` };
    }
  }

  private convertTool(tool: ToolDefinition): Anthropic.Messages.Tool {
    const schema = toolToJsonSchema(tool);
    return {
      name: schema.name,
      description: schema.description,
      input_schema: {
        type: "object" as const,
        ...(schema.parameters as Record<string, unknown>),
      },
    };
  }

  private convertToolChoice(
    choice: LLMChatInput["toolChoice"],
  ): Anthropic.Messages.ToolChoice {
    switch (choice) {
      case "none":
        return { type: "none" };
      case "auto":
        return { type: "auto" };
      case "required":
        return { type: "any" };
      default:
        return { type: "auto" };
    }
  }

  private mapResponse(response: Anthropic.Message): LLMResult {
    const toolCalls: LLMToolCall[] = [];
    let textContent = "";

    for (const block of response.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
      // Ignore thinking/redacted_thinking blocks for result
    }

    const hasToolCalls = toolCalls.length > 0;
    const usage = this.mapUsage(response.usage);

    let finishReason: LLMResult["finishReason"] = "stop";
    switch (response.stop_reason) {
      case "tool_use":
        finishReason = "tool_use";
        break;
      case "max_tokens":
        finishReason = "length";
        break;
      case "end_turn":
      case "stop_sequence":
        finishReason = "stop";
        break;
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

  private mapUsage(usage: Anthropic.Usage): LLMUsage {
    const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      inputCost: 0,
      outputCost: 0,
      cacheCost: 0,
      totalCost: 0,
    };
  }

  private mapError(error: unknown): Error {
    if (error instanceof Anthropic.APIError) {
      if (error.status === 429) {
        const retryAfter = error.headers?.["retry-after"];
        return new RateLimitError(error.message, {
          provider: "anthropic",
          statusCode: error.status,
          retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
        });
      }
      if (error.message?.includes("context_length")) {
        return new ContextLengthExceededError(error.message, {
          provider: "anthropic",
          statusCode: error.status,
        });
      }
      return new LLMApiError(error.message, {
        provider: "anthropic",
        statusCode: error.status,
      });
    }
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
}
