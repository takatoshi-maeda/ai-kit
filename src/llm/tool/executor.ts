import { ToolExecutionError } from "../../errors.js";
import type { ToolDefinition, LLMToolCall, LLMToolResult } from "../../types/tool.js";

export class ToolExecutor {
  private readonly toolMap: Map<string, ToolDefinition>;

  constructor(tools: ToolDefinition[]) {
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
  }

  findTool(name: string): ToolDefinition | undefined {
    return this.toolMap.get(name);
  }

  async execute(toolCall: LLMToolCall): Promise<LLMToolResult> {
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
      const result = await tool.execute(parsed);
      return {
        toolCallId: toolCall.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolExecutionError(
        `Tool "${toolCall.name}" failed: ${message}`,
        { toolName: toolCall.name, cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async executeAll(toolCalls: LLMToolCall[]): Promise<LLMToolResult[]> {
    const results = await Promise.allSettled(
      toolCalls.map((tc) => this.execute(tc)),
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
