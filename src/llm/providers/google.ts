import { GoogleGenAI } from "@google/genai";
import type * as genai from "@google/genai";
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
import type { LLMClient, GoogleClientOptions } from "../client.js";
import { withRetry } from "../retry.js";
import { toolToJsonSchema } from "../tool/define.js";
import {
  LLMApiError,
  RateLimitError,
  ContextLengthExceededError,
} from "../../errors.js";
import type { ToolDefinition } from "../../types/tool.js";

export class GoogleClient implements LLMClient {
  readonly provider = "google" as const;
  readonly model: string;
  readonly capabilities: ModelCapabilities;

  private readonly client: GoogleGenAI;
  private readonly options: GoogleClientOptions;

  constructor(options: GoogleClientOptions) {
    this.options = options;
    this.model = options.model;
    this.client = new GoogleGenAI({
      apiKey: options.apiKey,
    });
    this.capabilities = {
      supportsReasoning: true,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsImages: true,
      contextWindowSize: 1_000_000,
    };
  }

  async invoke(input: LLMChatInput): Promise<LLMResult> {
    const params = this.buildParams(input);
    const retryCount = this.options.retryCount ?? 0;

    const response = await withRetry(
      () => this.client.models.generateContent(params),
      { maxRetries: retryCount },
    ).catch((error) => {
      throw this.mapError(error);
    });

    return this.mapResponse(response);
  }

  async *stream(input: LLMChatInput): AsyncIterable<LLMStreamEvent> {
    const params = this.buildParams(input);

    let streamGen: AsyncGenerator<genai.GenerateContentResponse>;
    try {
      streamGen = await this.client.models.generateContentStream(params);
    } catch (error) {
      throw this.mapError(error);
    }

    let responseId: string | undefined;
    let fullText = "";

    try {
      for await (const chunk of streamGen) {
        if (!responseId && chunk.responseId) {
          responseId = chunk.responseId;
          yield { type: "response.created", responseId };
        }

        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;

        for (const part of candidate.content.parts) {
          if (part.text !== undefined) {
            if (part.thought) {
              yield { type: "reasoning.delta", delta: part.text };
            } else {
              fullText += part.text;
              yield { type: "text.delta", delta: part.text };
            }
          } else if (part.functionCall) {
            yield {
              type: "tool_call.arguments.done",
              toolCallId: part.functionCall.id ?? part.functionCall.name ?? "",
              name: part.functionCall.name ?? "",
              arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
            };
          }
        }
      }

      // Build final result from accumulated data
      // Re-invoke for complete response to get usage metadata
      // Actually we can just return what we have
      yield { type: "text.done", text: fullText };

    } catch (error) {
      yield { type: "error", error: this.mapError(error) };
    }
  }

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  private buildParams(
    input: LLMChatInput,
  ): genai.GenerateContentParameters {
    const contents = this.convertMessages(input.messages);

    const config: genai.GenerateContentConfig = {};

    if (input.instructions) {
      config.systemInstruction = input.instructions;
    }

    if (this.options.temperature !== undefined) {
      config.temperature = this.options.temperature;
    }

    if (this.options.maxTokens !== undefined) {
      config.maxOutputTokens = this.options.maxTokens;
    }

    if (this.options.topP !== undefined) {
      config.topP = this.options.topP;
    }

    if (this.options.topK !== undefined) {
      config.topK = this.options.topK;
    }

    if (this.options.thinkingBudget !== undefined) {
      config.thinkingConfig = { includeThoughts: true };
    }

    if (this.options.safetySettings) {
      config.safetySettings = this.options.safetySettings.map((s) => ({
        category: s.category as genai.HarmCategory,
        threshold: s.threshold as genai.HarmBlockThreshold,
      }));
    }

    if (input.tools && input.tools.length > 0) {
      config.tools = [
        {
          functionDeclarations: input.tools.map((t) =>
            this.convertTool(t),
          ),
        },
      ];
    }

    if (input.toolChoice) {
      config.toolConfig = {
        functionCallingConfig: {
          mode: this.convertToolChoice(input.toolChoice),
        },
      };
    }

    if (input.responseFormat && input.responseFormat.type === "json_schema") {
      config.responseMimeType = "application/json";
      const { zodToJsonSchema } = require("zod-to-json-schema") as typeof import("zod-to-json-schema");
      const schema = zodToJsonSchema(input.responseFormat.schema, { $refStrategy: "none" }) as Record<string, unknown>;
      const { $schema, ...rest } = schema;
      config.responseSchema = rest as genai.Schema;
    }

    return {
      model: this.model,
      contents,
      config,
    };
  }

  private convertMessages(
    messages: LLMMessage[],
  ): genai.Content[] {
    const contents: genai.Content[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        // System messages are handled via config.systemInstruction
        continue;
      }

      if (msg.role === "tool") {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                id: msg.toolCallId ?? undefined,
                name: msg.name ?? "",
                response: { result: typeof msg.content === "string" ? msg.content : msg.content },
              },
            },
          ],
        });
        continue;
      }

      const role = msg.role === "assistant" ? "model" : "user";
      const parts = this.convertContentToParts(msg.content);
      contents.push({ role, parts });
    }

    return contents;
  }

  private convertContentToParts(
    content: string | ContentPart[],
  ): genai.Part[] {
    if (typeof content === "string") {
      return [{ text: content }];
    }

    return content.map((part): genai.Part => {
      switch (part.type) {
        case "text":
          return { text: part.text };
        case "image":
          if (part.source.type === "base64") {
            return {
              inlineData: {
                data: part.source.data,
                mimeType: part.source.mediaType,
              },
            };
          }
          return {
            fileData: {
              fileUri: part.source.url,
              mimeType: "image/*",
            },
          };
        case "audio":
          return {
            inlineData: {
              data: part.data,
              mimeType: `audio/${part.format}`,
            },
          };
      }
    });
  }

  private convertTool(
    tool: ToolDefinition,
  ): genai.FunctionDeclaration {
    const schema = toolToJsonSchema(tool);
    return {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters as genai.Schema,
    };
  }

  private convertToolChoice(
    choice: LLMChatInput["toolChoice"],
  ): genai.FunctionCallingConfigMode {
    switch (choice) {
      case "none":
        return "NONE" as genai.FunctionCallingConfigMode;
      case "auto":
        return "AUTO" as genai.FunctionCallingConfigMode;
      case "required":
        return "ANY" as genai.FunctionCallingConfigMode;
      default:
        return "AUTO" as genai.FunctionCallingConfigMode;
    }
  }

  private mapResponse(
    response: genai.GenerateContentResponse,
  ): LLMResult {
    const toolCalls: LLMToolCall[] = [];
    let textContent = "";

    const candidate = response.candidates?.[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text !== undefined && !part.thought) {
          textContent += part.text;
        } else if (part.functionCall) {
          toolCalls.push({
            id: part.functionCall.id ?? part.functionCall.name ?? "",
            name: part.functionCall.name ?? "",
            arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    }

    const hasToolCalls = toolCalls.length > 0;
    const usage = this.mapUsage(response.usageMetadata);

    let finishReason: LLMResult["finishReason"] = "stop";
    if (hasToolCalls) {
      finishReason = "tool_use";
    } else if (candidate?.finishReason === "MAX_TOKENS") {
      finishReason = "length";
    } else if (candidate?.finishReason === "SAFETY") {
      finishReason = "content_filter";
    }

    return {
      type: hasToolCalls ? "tool_use" : "message",
      content: textContent || null,
      toolCalls,
      usage,
      responseId: response.responseId ?? null,
      finishReason,
    };
  }

  private mapUsage(
    usage?: genai.GenerateContentResponseUsageMetadata,
  ): LLMUsage {
    if (!usage) return emptyUsage();

    return {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      cachedInputTokens: usage.cachedContentTokenCount ?? 0,
      totalTokens: usage.totalTokenCount ?? 0,
      inputCost: 0,
      outputCost: 0,
      cacheCost: 0,
      totalCost: 0,
    };
  }

  private mapError(error: unknown): Error {
    if (error instanceof Error) {
      const statusCode = (error as { status?: number; statusCode?: number }).status ??
        (error as { statusCode?: number }).statusCode;

      if (statusCode === 429) {
        return new RateLimitError(error.message, {
          provider: "google",
          statusCode,
        });
      }
      if (error.message?.includes("context")) {
        return new ContextLengthExceededError(error.message, {
          provider: "google",
          statusCode,
        });
      }
      if (statusCode) {
        return new LLMApiError(error.message, {
          provider: "google",
          statusCode,
        });
      }
      return error;
    }
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
