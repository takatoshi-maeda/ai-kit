import type {
  AgentContext,
  NativeToolRuntime,
} from "../../types/agent.js";
import type { LLMToolCall, ProviderNativeTool } from "../../types/tool.js";
import { executeOpenAIApplyPatchToolCall } from "./openai-apply-patch-runtime.js";
import { executeOpenAIShellToolCall } from "./openai-shell-runtime.js";

export class OpenAINativeToolRuntime implements NativeToolRuntime {
  constructor(private readonly tools: ProviderNativeTool[]) {}

  supports(toolCall: LLMToolCall, availableTools: ProviderNativeTool[]): boolean {
    return this.findTool(toolCall, availableTools) !== undefined;
  }

  async execute(toolCall: LLMToolCall, _context: AgentContext) {
    const tool = this.findTool(toolCall, this.tools);
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        content: `Native tool is not enabled: ${toolCall.name}`,
        isError: true,
      };
    }

    if (tool.type === "shell") {
      return executeOpenAIShellToolCall(toolCall, tool);
    }
    return executeOpenAIApplyPatchToolCall(toolCall, tool);
  }

  private findTool(
    toolCall: LLMToolCall,
    tools: ProviderNativeTool[],
  ): ProviderNativeTool | undefined {
    return tools.find((tool) => tool.provider === toolCall.provider && tool.type === toolCall.name);
  }
}
