import { describe, it, expect } from "vitest";
import { AgentStreamForwarder } from "../../../src/agent/stream/forwarder.js";
import type { LLMStreamEvent } from "../../../src/types/stream-events.js";
import type { LLMResult, LLMUsage } from "../../../src/types/llm.js";
import type { AgentStreamResponse } from "../../../src/agent/stream/responses.js";

// --- Helpers ---

function emptyUsage(): LLMUsage {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    totalTokens: 15,
    inputCost: 0.001,
    outputCost: 0.001,
    cacheCost: 0,
    totalCost: 0.002,
  };
}

function makeResult(content: string | null): LLMResult {
  return {
    type: "message",
    content,
    toolCalls: [],
    usage: emptyUsage(),
    responseId: "resp-1",
    finishReason: "stop",
  };
}

async function* toStream(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  for (const e of events) {
    yield e;
  }
}

async function collect(stream: AsyncIterable<AgentStreamResponse>): Promise<AgentStreamResponse[]> {
  const items: AgentStreamResponse[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

// --- Tests ---

describe("AgentStreamForwarder", () => {
  it("converts text.delta to agent.text_delta", async () => {
    const forwarder = new AgentStreamForwarder();
    const events: LLMStreamEvent[] = [
      { type: "text.delta", delta: "Hello" },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toEqual([
      { type: "agent.text_delta", delta: "Hello" },
    ]);
  });

  it("converts reasoning.delta to agent.reasoning_delta", async () => {
    const forwarder = new AgentStreamForwarder();
    const events: LLMStreamEvent[] = [
      { type: "reasoning.delta", delta: "Thinking..." },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toEqual([
      { type: "agent.reasoning_delta", delta: "Thinking..." },
    ]);
  });

  it("converts tool_call.arguments.done to agent.tool_call", async () => {
    const forwarder = new AgentStreamForwarder();
    const events: LLMStreamEvent[] = [
      {
        type: "tool_call.arguments.done",
        toolCallId: "tc-1",
        name: "readFile",
        arguments: { path: "/tmp/file.txt" },
      },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toEqual([
      { type: "agent.tool_call", name: "readFile", summary: "Called readFile" },
    ]);
  });

  it("converts response.completed to agent.result with text", async () => {
    const forwarder = new AgentStreamForwarder();
    const result = makeResult("Done!");
    const events: LLMStreamEvent[] = [
      { type: "response.completed", result },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toEqual([
      {
        type: "agent.result",
        resultType: "text",
        content: "Done!",
        responseId: "resp-1",
      },
    ]);
  });

  it("converts response.completed with null content to json resultType", async () => {
    const forwarder = new AgentStreamForwarder();
    const result = makeResult(null);
    const events: LLMStreamEvent[] = [
      { type: "response.completed", result },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toEqual([
      {
        type: "agent.result",
        resultType: "json",
        content: null,
        responseId: "resp-1",
      },
    ]);
  });

  it("converts error event to agent.error", async () => {
    const forwarder = new AgentStreamForwarder();
    const err = new Error("something went wrong");
    const events: LLMStreamEvent[] = [
      { type: "error", error: err },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("agent.error");
    expect((results[0] as { type: "agent.error"; error: Error }).error.message).toBe(
      "something went wrong",
    );
  });

  it("converts response.failed to agent.error", async () => {
    const forwarder = new AgentStreamForwarder();
    const err = new Error("API failed");
    const events: LLMStreamEvent[] = [
      { type: "response.failed", error: err },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("agent.error");
    expect((results[0] as { type: "agent.error"; error: Error }).error.message).toBe(
      "API failed",
    );
  });

  it("skips unmapped events by default", async () => {
    const forwarder = new AgentStreamForwarder();
    const events: LLMStreamEvent[] = [
      { type: "response.created", responseId: "resp-1" },
      { type: "text.done", text: "Hello" },
      { type: "usage", usage: emptyUsage() },
      { type: "reasoning.done", text: "done thinking" },
      {
        type: "tool_call.arguments.delta",
        toolCallId: "tc-1",
        name: "readFile",
        delta: '{"path":',
      },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toEqual([]);
  });

  it("emits progress for unmapped events in debug mode", async () => {
    const forwarder = new AgentStreamForwarder({ debug: true });
    const events: LLMStreamEvent[] = [
      { type: "response.created", responseId: "resp-1" },
      { type: "text.delta", delta: "Hi" },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      type: "agent.progress",
      summary: "Unhandled event: response.created",
      description: "",
    });
    expect(results[1]).toEqual({
      type: "agent.text_delta",
      delta: "Hi",
    });
  });

  it("handles a full conversation stream", async () => {
    const forwarder = new AgentStreamForwarder();
    const result = makeResult("The answer is 42.");
    const events: LLMStreamEvent[] = [
      { type: "response.created", responseId: "resp-1" },
      { type: "reasoning.delta", delta: "Let me think" },
      { type: "reasoning.done", text: "Let me think" },
      { type: "text.delta", delta: "The answer " },
      { type: "text.delta", delta: "is 42." },
      { type: "text.done", text: "The answer is 42." },
      { type: "usage", usage: emptyUsage() },
      { type: "response.completed", result },
    ];

    const results = await collect(forwarder.forward(toStream(events)));

    expect(results).toEqual([
      { type: "agent.reasoning_delta", delta: "Let me think" },
      { type: "agent.text_delta", delta: "The answer " },
      { type: "agent.text_delta", delta: "is 42." },
      {
        type: "agent.result",
        resultType: "text",
        content: "The answer is 42.",
        responseId: "resp-1",
      },
    ]);
  });

  it("handles empty stream", async () => {
    const forwarder = new AgentStreamForwarder();
    const results = await collect(forwarder.forward(toStream([])));
    expect(results).toEqual([]);
  });
});
