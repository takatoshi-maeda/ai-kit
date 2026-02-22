import { describe, it, expect } from "vitest";
import { z } from "zod";
import { StructuredAgent } from "../../src/agent/structured.js";
import { AgentContextImpl } from "../../src/agent/context.js";
import type { LLMClient, ConversationHistory } from "../../src/types/agent.js";
import type { LLMResult, LLMUsage, LLMChatInput } from "../../src/types/llm.js";
import type { LLMStreamEvent } from "../../src/types/stream-events.js";
import type { ModelCapabilities } from "../../src/types/model.js";

function stubHistory(): ConversationHistory {
  return {
    async getMessages() { return []; },
    async addMessage() {},
    async toLLMMessages() { return []; },
    async clear() {},
  };
}

function emptyUsage(): LLMUsage {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    totalTokens: 15,
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
  };
}

const defaultCapabilities: ModelCapabilities = {
  supportsReasoning: false,
  supportsToolCalls: true,
  supportsStreaming: true,
  supportsImages: false,
  contextWindowSize: 128000,
};

function makeResult(content: string): LLMResult {
  return {
    type: "message",
    content,
    toolCalls: [],
    usage: emptyUsage(),
    responseId: "resp-1",
    finishReason: "stop",
  };
}

function makeStreamEvents(result: LLMResult): LLMStreamEvent[] {
  return [
    { type: "response.created", responseId: result.responseId ?? "resp-1" },
    { type: "response.completed", result },
  ];
}

describe("StructuredAgent", () => {
  it("parses JSON response into typed output", async () => {
    const schema = z.object({
      name: z.string(),
      score: z.number(),
    });

    const jsonContent = JSON.stringify({ name: "test", score: 42 });
    const result = makeResult(jsonContent);

    let receivedFormat: LLMChatInput["responseFormat"];
    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke() { return result; },
      async *stream(input) {
        receivedFormat = input.responseFormat;
        for (const event of makeStreamEvents(result)) {
          yield event;
        }
      },
      estimateTokens: () => 10,
    };

    const context = new AgentContextImpl({ history: stubHistory() });
    const agent = new StructuredAgent({
      context,
      client,
      instructions: "Return JSON",
      responseSchema: schema,
    });

    const agentResult = await agent.invoke("Give me data");

    expect(agentResult.parsed).toEqual({ name: "test", score: 42 });
    expect(agentResult.content).toBe(jsonContent);
    expect(receivedFormat).toEqual({
      type: "json_schema",
      schema,
    });
  });

  it("throws on invalid JSON response", async () => {
    const schema = z.object({ name: z.string() });
    const result = makeResult("not json");

    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke() { return result; },
      async *stream() {
        for (const event of makeStreamEvents(result)) {
          yield event;
        }
      },
      estimateTokens: () => 10,
    };

    const context = new AgentContextImpl({ history: stubHistory() });
    const agent = new StructuredAgent({
      context,
      client,
      instructions: "Return JSON",
      responseSchema: schema,
    });

    await expect(agent.invoke("Bad")).rejects.toThrow();
  });

  it("throws on schema validation failure", async () => {
    const schema = z.object({ name: z.string(), required: z.boolean() });
    const result = makeResult(JSON.stringify({ name: "test" }));

    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke() { return result; },
      async *stream() {
        for (const event of makeStreamEvents(result)) {
          yield event;
        }
      },
      estimateTokens: () => 10,
    };

    const context = new AgentContextImpl({ history: stubHistory() });
    const agent = new StructuredAgent({
      context,
      client,
      instructions: "Return JSON",
      responseSchema: schema,
    });

    await expect(agent.invoke("Incomplete")).rejects.toThrow();
  });
});
