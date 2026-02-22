import { describe, it, expect } from "vitest";
import { AgentProxy } from "../../src/agent/proxy.js";
import { ConversationalAgent } from "../../src/agent/conversational.js";
import { AgentContextImpl } from "../../src/agent/context.js";
import type { LLMClient, ConversationHistory } from "../../src/types/agent.js";
import type { LLMResult, LLMUsage, LLMChatInput } from "../../src/types/llm.js";
import type { LLMStreamEvent } from "../../src/types/stream-events.js";
import type { ModelCapabilities } from "../../src/types/model.js";

// --- Helpers ---

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
    inputCost: 0.001,
    outputCost: 0.001,
    cacheCost: 0,
    totalCost: 0.002,
  };
}

function makeResult(opts: {
  content?: string | null;
  toolCalls?: LLMResult["toolCalls"];
}): LLMResult {
  return {
    type: opts.toolCalls?.length ? "tool_use" : "message",
    content: opts.content ?? null,
    toolCalls: opts.toolCalls ?? [],
    usage: emptyUsage(),
    responseId: "resp-1",
    finishReason: opts.toolCalls?.length ? "tool_use" : "stop",
  };
}

function makeStreamEvents(result: LLMResult): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = [
    { type: "response.created", responseId: result.responseId ?? "resp-1" },
  ];
  if (result.content) {
    events.push({ type: "text.delta", delta: result.content });
    events.push({ type: "text.done", text: result.content });
  }
  events.push({ type: "response.completed", result });
  return events;
}

const defaultCapabilities: ModelCapabilities = {
  supportsReasoning: false,
  supportsToolCalls: true,
  supportsStreaming: true,
  supportsImages: false,
  contextWindowSize: 128000,
};

function makeAgent(name: string, responseContent: string): ConversationalAgent {
  const result = makeResult({ content: responseContent });
  const client: LLMClient = {
    model: "test-model",
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

  return new ConversationalAgent({
    context: new AgentContextImpl({ history: stubHistory() }),
    client,
    instructions: `You are the ${name} agent.`,
  });
}

function routerClient(selectedAgentId: string): LLMClient {
  return {
    model: "router-model",
    provider: "openai",
    capabilities: defaultCapabilities,
    async invoke() {
      return makeResult({
        toolCalls: [{
          id: "tc-route",
          name: `delegate_to_${selectedAgentId}`,
          arguments: {},
        }],
      });
    },
    async *stream() {
      const result = makeResult({
        toolCalls: [{
          id: "tc-route",
          name: `delegate_to_${selectedAgentId}`,
          arguments: {},
        }],
      });
      for (const event of makeStreamEvents(result)) {
        yield event;
      }
    },
    estimateTokens: () => 10,
  };
}

// --- Tests ---

describe("AgentProxy", () => {
  it("routes to selected agent and returns streamed result", async () => {
    const agents = new Map([
      ["writer", makeAgent("writer", "Here is a story.")],
      ["coder", makeAgent("coder", "Here is code.")],
    ]);

    const context = new AgentContextImpl({ history: stubHistory() });
    const proxy = new AgentProxy({
      context,
      client: routerClient("writer"),
      instructions: "Route to the best agent.",
      agents,
    });

    const stream = proxy.run("Write me a story");
    const events: LLMStreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const result = await stream.result;

    expect(result.content).toBe("Here is a story.");
    expect(events.some(e => e.type === "response.completed")).toBe(true);
    expect(context.selectedAgentName).toBe("writer");
  });

  it("routes to single agent without LLM call", async () => {
    let routerInvokeCalled = false;
    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke() {
        routerInvokeCalled = true;
        return makeResult({ content: "" });
      },
      async *stream() {
        yield { type: "response.created" as const, responseId: "r" };
      },
      estimateTokens: () => 10,
    };

    const agents = new Map([
      ["solo", makeAgent("solo", "Solo response")],
    ]);

    const context = new AgentContextImpl({ history: stubHistory() });
    const proxy = new AgentProxy({
      context,
      client,
      instructions: "Route",
      agents,
    });

    const stream = proxy.run("Hello");
    for await (const _event of stream) {
      // consume
    }
    const result = await stream.result;

    expect(result.content).toBe("Solo response");
    expect(routerInvokeCalled).toBe(false);
  });

  it("propagates errors from the selected agent", async () => {
    const failingClient: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke() { throw new Error("agent fail"); },
      async *stream() { throw new Error("agent stream fail"); },
      estimateTokens: () => 10,
    };

    const failingAgent = new ConversationalAgent({
      context: new AgentContextImpl({ history: stubHistory() }),
      client: failingClient,
      instructions: "Fail",
    });

    const agents = new Map([
      ["failing", failingAgent],
    ]);

    const context = new AgentContextImpl({ history: stubHistory() });
    const proxy = new AgentProxy({
      context,
      client: routerClient("failing"),
      instructions: "Route",
      agents,
    });

    const stream = proxy.run("Hello");
    await expect(async () => {
      for await (const _ of stream) {
        // consume
      }
    }).rejects.toThrow("agent stream fail");

    await expect(stream.result).rejects.toThrow("agent stream fail");
  });

  it("collects all stream events from the selected agent", async () => {
    const agents = new Map([
      ["agent", makeAgent("agent", "Full response")],
    ]);

    const context = new AgentContextImpl({ history: stubHistory() });
    const proxy = new AgentProxy({
      context,
      client: routerClient("agent"),
      instructions: "Route",
      agents,
    });

    const stream = proxy.run("Go");
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toContain("response.created");
    expect(eventTypes).toContain("text.delta");
    expect(eventTypes).toContain("text.done");
    expect(eventTypes).toContain("response.completed");
  });
});
