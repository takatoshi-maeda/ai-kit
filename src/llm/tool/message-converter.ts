import type { LLMMessage } from "../../types/llm.js";
import type { LLMToolCall, ProviderRawTransport } from "../../types/tool.js";

export function toolCallsToMessages(
  toolCalls: LLMToolCall[],
  assistantContent?: string,
): LLMMessage[] {
  const messages: LLMMessage[] = [];

  // Assistant message with tool calls info
  const toolCallSummary = toolCalls
    .map((tc) => summarizeToolCall(tc))
    .filter((summary) => summary.length > 0)
    .join("\n");
  const assistantText = [assistantContent, toolCallSummary]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");

  messages.push({
    role: "assistant",
    content: assistantText,
    extra: {
      providerRaw: normalizeAssistantProviderRaw(toolCalls),
    },
  });

  // Tool result messages
  for (const tc of toolCalls) {
    if (!tc.result) continue;
    messages.push({
      role: "tool",
      content: tc.result.content,
      toolCallId: tc.result.toolCallId,
      name: tc.name,
      extra: {
        tool: {
          call: {
            id: tc.id,
            name: tc.name,
            executionKind: tc.executionKind ?? "user_function",
            provider: tc.provider,
            arguments: tc.arguments,
            extra: tc.extra,
          },
          result: {
            content: tc.result.content,
            structuredContent: tc.result.structuredContent,
            outputContent: tc.result.outputContent,
            isError: tc.result.isError,
            extra: tc.result.extra,
          },
        },
        providerRaw: normalizeProviderRaw(tc),
      },
    });
  }

  return messages;
}

function summarizeToolCall(toolCall: LLMToolCall): string {
  if (toolCall.executionKind === "provider_native") {
    if (toolCall.provider === "anthropic" && isAnthropicProviderRawTransport(toolCall.extra?.providerRaw)) {
      return "";
    }
    return `[tool_call: ${toolCall.name}]`;
  }

  const args = JSON.stringify(toolCall.arguments);
  const truncatedArgs = args.length > 240 ? `${args.slice(0, 237)}...` : args;
  return `[tool_call: ${toolCall.name}(${truncatedArgs})]`;
}

function normalizeProviderRaw(toolCall: LLMToolCall): ProviderRawTransport | undefined {
  const callRaw = toolCall.extra?.providerRaw;
  const resultRaw = toolCall.result?.extra?.providerRaw;
  if (
    !callRaw ||
    typeof callRaw !== "object" ||
    Array.isArray(callRaw) ||
    !("provider" in callRaw)
  ) {
    return undefined;
  }
  const provider = (callRaw as { provider?: unknown }).provider;
  if (provider !== "openai") {
    return undefined;
  }
  const inputItems = [
    ...asArray((callRaw as { outputItems?: unknown[] }).outputItems),
    ...asArray(
      resultRaw && typeof resultRaw === "object" && !Array.isArray(resultRaw)
        ? (resultRaw as { inputItems?: unknown[] }).inputItems
        : undefined,
    ),
  ];
  return {
    provider: "openai",
    inputItems,
    outputItems: asArray((callRaw as { outputItems?: unknown[] }).outputItems),
  };
}

function normalizeAssistantProviderRaw(toolCalls: LLMToolCall[]): ProviderRawTransport | undefined {
  const providerRawValues = toolCalls.map((tc) => tc.extra?.providerRaw);
  const anthropicRaw = providerRawValues.find(isAnthropicProviderRawTransport);
  if (!anthropicRaw) {
    return undefined;
  }

  return {
    provider: "anthropic",
    outputItems: asArray(anthropicRaw.outputItems),
  };
}

function isProviderRawTransport(value: unknown): value is ProviderRawTransport {
  return !!value && typeof value === "object" && !Array.isArray(value) && "provider" in value;
}

function isAnthropicProviderRawTransport(value: unknown): value is ProviderRawTransport {
  return isProviderRawTransport(value) && value.provider === "anthropic";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
