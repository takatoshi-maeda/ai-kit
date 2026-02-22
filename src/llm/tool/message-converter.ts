import type { LLMMessage } from "../../types/llm.js";
import type { LLMToolCall } from "../../types/tool.js";

export function toolCallsToMessages(
  toolCalls: LLMToolCall[],
  assistantContent?: string,
): LLMMessage[] {
  const messages: LLMMessage[] = [];

  // Assistant message with tool calls info
  const toolCallSummary = toolCalls
    .map((tc) => `[tool_call: ${tc.name}(${JSON.stringify(tc.arguments)})]`)
    .join("\n");

  messages.push({
    role: "assistant",
    content: assistantContent
      ? `${assistantContent}\n${toolCallSummary}`
      : toolCallSummary,
  });

  // Tool result messages
  for (const tc of toolCalls) {
    if (!tc.result) continue;
    messages.push({
      role: "tool",
      content: tc.result.content,
      toolCallId: tc.result.toolCallId,
      name: tc.name,
    });
  }

  return messages;
}
