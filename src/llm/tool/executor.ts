import { ToolExecutionError } from "../../errors.js";
import {
  isFunctionToolDefinition,
  type AgentTool,
  type ToolDefinition,
  type LLMToolCall,
  type LLMToolResult,
  type ToolExecutionOptions,
  type ToolResultEnvelope,
  type ToolResultOutputContent,
} from "../../types/tool.js";

export class ToolExecutor {
  private readonly toolMap: Map<string, ToolDefinition>;

  constructor(tools: AgentTool[]) {
    this.toolMap = new Map(
      tools.filter(isFunctionToolDefinition).map((t) => [t.name, t]),
    );
  }

  findTool(name: string): ToolDefinition | undefined {
    return this.toolMap.get(name);
  }

  async execute(
    toolCall: LLMToolCall,
    options?: ToolExecutionOptions,
  ): Promise<LLMToolResult> {
    const tool = this.toolMap.get(toolCall.name);
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        content: `Tool not found: ${toolCall.name}`,
        isError: true,
      };
    }

    try {
      const parsed = tool.parameters.parse(toolCall.arguments);
      const result = await tool.execute(parsed, options);
      const envelope = normalizeToolResultEnvelope(result);
      const content = envelope
        ? envelope.content ?? JSON.stringify(envelope.structuredContent ?? {})
        : typeof result === "string" ? result : JSON.stringify(result);
      return {
        toolCallId: toolCall.id,
        content,
        structuredContent: envelope?.structuredContent,
        outputContent: envelope?.outputContent,
        extra: {
          providerRaw: buildFunctionToolResultProviderRaw(
            toolCall,
            content,
            envelope?.outputContent,
          ),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolExecutionError(
        `Tool "${toolCall.name}" failed: ${message}`,
        { toolName: toolCall.name, cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async executeAll(
    toolCalls: LLMToolCall[],
    options?: ToolExecutionOptions,
  ): Promise<LLMToolResult[]> {
    const results = await Promise.allSettled(
      toolCalls.map((tc) => this.execute(tc, options)),
    );

    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return {
        toolCallId: toolCalls[i].id,
        content: message,
        isError: true,
      };
    });
  }
}

function buildFunctionToolResultProviderRaw(
  toolCall: LLMToolCall,
  output: string,
  outputContent?: ToolResultOutputContent[],
) {
  if (toolCall.executionKind === "provider_native" || toolCall.provider !== "openai") {
    return undefined;
  }

  return {
    provider: "openai" as const,
    inputItems: [
      {
        type: "function_call_output",
        call_id: toolCall.id,
        output: outputContent ? convertOutputContent(outputContent) : output,
      },
    ],
  };
}

function normalizeToolResultEnvelope(result: unknown): ToolResultEnvelope | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }

  const candidate = result as ToolResultEnvelope;
  if (
    "structuredContent" in candidate ||
    "outputContent" in candidate
  ) {
    return candidate;
  }
  return undefined;
}

function convertOutputContent(outputContent: ToolResultOutputContent[]): unknown[] {
  return outputContent.map((part) => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text };
    }
    return {
      type: "input_file",
      file_id: part.fileId,
    };
  });
}
