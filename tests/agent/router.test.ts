import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgentRouter } from "../../src/agent/router.js";
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

function makeAgent(name: string): ConversationalAgent {
  const result = makeResult({ content: `Response from ${name}` });
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

/**
 * Creates a router client that selects the given agent by returning
 * a tool call for `delegate_to_{agentId}`.
 */
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
    async *stream(input: LLMChatInput) {
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

describe("AgentRouter", () => {
  it("throws if no agents are provided", () => {
    expect(() => new AgentRouter({
      context: new AgentContextImpl({ history: stubHistory() }),
      client: routerClient("any"),
      instructions: "Route",
      agents: new Map(),
    })).toThrow("at least one agent");
  });

  it("returns the single agent without LLM call for single-agent maps", async () => {
    let invokeCalled = false;
    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke() {
        invokeCalled = true;
        return makeResult({ content: "" });
      },
      async *stream() {
        yield { type: "response.created" as const, responseId: "r" };
      },
      estimateTokens: () => 10,
    };

    const agent = makeAgent("solo");
    const context = new AgentContextImpl({ history: stubHistory() });
    const router = new AgentRouter({
      context,
      client,
      instructions: "Route",
      agents: new Map([["solo", agent]]),
    });

    const resolved = await router.resolve("Hello");

    expect(resolved).toBe(agent);
    expect(invokeCalled).toBe(false);
    expect(context.selectedAgentName).toBe("solo");
  });

  it("selects the correct agent based on LLM tool choice", async () => {
    const agentA = makeAgent("analysis");
    const agentB = makeAgent("coding");
    const agents = new Map([
      ["analysis", agentA],
      ["coding", agentB],
    ]);

    const context = new AgentContextImpl({ history: stubHistory() });
    const router = new AgentRouter({
      context,
      client: routerClient("coding"),
      instructions: "Route to the best agent.",
      agents,
    });

    const resolved = await router.resolve("Write a function");

    expect(resolved).toBe(agentB);
    expect(context.selectedAgentName).toBe("coding");
  });

  it("passes correct tools to the LLM", async () => {
    const agentA = makeAgent("alpha");
    const agentB = makeAgent("beta");
    const agents = new Map([
      ["alpha", agentA],
      ["beta", agentB],
    ]);

    let receivedTools: LLMChatInput["tools"];
    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke(input) {
        receivedTools = input.tools;
        return makeResult({
          toolCalls: [{
            id: "tc",
            name: "delegate_to_alpha",
            arguments: {},
          }],
        });
      },
      async *stream() {
        yield { type: "response.created" as const, responseId: "r" };
      },
      estimateTokens: () => 10,
    };

    const context = new AgentContextImpl({ history: stubHistory() });
    const router = new AgentRouter({
      context,
      client,
      instructions: "Route",
      agents,
    });

    await router.resolve("Test");

    expect(receivedTools).toHaveLength(2);
    expect(receivedTools![0].name).toBe("delegate_to_alpha");
    expect(receivedTools![1].name).toBe("delegate_to_beta");
  });

  it("uses toolChoice: required in LLM call", async () => {
    const agents = new Map([
      ["a", makeAgent("a")],
      ["b", makeAgent("b")],
    ]);

    let receivedToolChoice: string | undefined;
    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke(input) {
        receivedToolChoice = input.toolChoice;
        return makeResult({
          toolCalls: [{
            id: "tc",
            name: "delegate_to_a",
            arguments: {},
          }],
        });
      },
      async *stream() {
        yield { type: "response.created" as const, responseId: "r" };
      },
      estimateTokens: () => 10,
    };

    const context = new AgentContextImpl({ history: stubHistory() });
    const router = new AgentRouter({
      context,
      client,
      instructions: "Route",
      agents,
    });

    await router.resolve("Test");

    expect(receivedToolChoice).toBe("required");
  });

  it("falls back to first agent if LLM returns no tool calls", async () => {
    const agentA = makeAgent("first");
    const agentB = makeAgent("second");
    const agents = new Map([
      ["first", agentA],
      ["second", agentB],
    ]);

    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke() {
        // No tool calls returned
        return makeResult({ content: "I can't decide" });
      },
      async *stream() {
        yield { type: "response.created" as const, responseId: "r" };
      },
      estimateTokens: () => 10,
    };

    const context = new AgentContextImpl({ history: stubHistory() });
    const router = new AgentRouter({
      context,
      client,
      instructions: "Route",
      agents,
    });

    const resolved = await router.resolve("Test");

    expect(resolved).toBe(agentA);
    expect(context.selectedAgentName).toBe("first");
  });

  it("falls back to first agent if LLM selects an unknown agent", async () => {
    const agentA = makeAgent("known");
    const agents = new Map([
      ["known", agentA],
      ["other", makeAgent("other")],
    ]);

    const client: LLMClient = {
      model: "test",
      provider: "openai",
      capabilities: defaultCapabilities,
      async invoke() {
        return makeResult({
          toolCalls: [{
            id: "tc",
            name: "delegate_to_nonexistent",
            arguments: {},
          }],
        });
      },
      async *stream() {
        yield { type: "response.created" as const, responseId: "r" };
      },
      estimateTokens: () => 10,
    };

    const context = new AgentContextImpl({ history: stubHistory() });
    const router = new AgentRouter({
      context,
      client,
      instructions: "Route",
      agents,
    });

    const resolved = await router.resolve("Test");

    expect(resolved).toBe(agentA);
    expect(context.selectedAgentName).toBe("known");
  });
});
