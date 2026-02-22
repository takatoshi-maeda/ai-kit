import { describe, it, expect } from "vitest";
import { toolCallsToMessages } from "../../../src/llm/tool/message-converter.js";
import type { LLMToolCall } from "../../../src/types/tool.js";

describe("toolCallsToMessages", () => {
  it("generates assistant + tool messages", () => {
    const toolCalls: LLMToolCall[] = [
      {
        id: "call-1",
        name: "search",
        arguments: { query: "hello" },
        result: {
          toolCallId: "call-1",
          content: "Found 3 results",
        },
      },
    ];

    const messages = toolCallsToMessages(toolCalls);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toContain("search");
    expect(messages[1].role).toBe("tool");
    expect(messages[1].content).toBe("Found 3 results");
    expect(messages[1].toolCallId).toBe("call-1");
    expect(messages[1].name).toBe("search");
  });

  it("includes assistant content if provided", () => {
    const toolCalls: LLMToolCall[] = [
      {
        id: "call-1",
        name: "calc",
        arguments: { x: 1 },
        result: { toolCallId: "call-1", content: "42" },
      },
    ];

    const messages = toolCallsToMessages(toolCalls, "Let me calculate");
    expect(messages[0].content).toContain("Let me calculate");
  });

  it("skips tool results that have no result", () => {
    const toolCalls: LLMToolCall[] = [
      { id: "call-1", name: "pending", arguments: {} },
    ];

    const messages = toolCallsToMessages(toolCalls);
    expect(messages).toHaveLength(1); // only assistant message
    expect(messages[0].role).toBe("assistant");
  });

  it("handles multiple tool calls", () => {
    const toolCalls: LLMToolCall[] = [
      {
        id: "c1",
        name: "tool_a",
        arguments: {},
        result: { toolCallId: "c1", content: "a" },
      },
      {
        id: "c2",
        name: "tool_b",
        arguments: {},
        result: { toolCallId: "c2", content: "b" },
      },
    ];

    const messages = toolCallsToMessages(toolCalls);
    expect(messages).toHaveLength(3); // 1 assistant + 2 tool results
    expect(messages[1].name).toBe("tool_a");
    expect(messages[2].name).toBe("tool_b");
  });
});
