import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { handleAgentList, handleAgentRun } from "../../../../src/agent/mcp/tools/agent.js";
import type { AgentToolDeps } from "../../../../src/agent/mcp/tools/agent.js";
import { AgentRegistry } from "../../../../src/agent/mcp/agent-registry.js";
import { ConversationalAgent } from "../../../../src/agent/conversational.js";
import type { McpPersistence } from "../../../../src/agent/mcp/persistence.js";
import type { AgentContext, ConversationHistory } from "../../../../src/types/agent.js";
import type { LLMClient } from "../../../../src/types/agent.js";
import type { LLMResult, LLMUsage } from "../../../../src/types/llm.js";
import type { LLMStreamEvent } from "../../../../src/types/stream-events.js";
import type { ModelCapabilities } from "../../../../src/types/model.js";

// --- Helpers ---

function stubPersistence(): McpPersistence {
  const conversations = new Map<string, unknown>();
  return {
    readConversation: vi.fn(async () => null),
    listConversationSummaries: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => false),
    appendConversationTurn: vi.fn(async () => {}),
    appendRunState: vi.fn(async () => {}),
    appendInputMessageHistory: vi.fn(async () => {}),
    listInputMessageHistory: vi.fn(async () => []),
    appendUsage: vi.fn(async () => {}),
    summarizeUsage: vi.fn(async () => null),
    readIdempotencyRecord: vi.fn(async () => null),
    writeIdempotencyRecord: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => ({ ok: true })),
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
    ...(result.content ? [
      { type: "text.delta" as const, delta: result.content },
      { type: "text.done" as const, text: result.content },
    ] : []),
    { type: "response.completed", result },
  ];
}

const defaultCapabilities: ModelCapabilities = {
  supportsReasoning: false,
  supportsToolCalls: true,
  supportsStreaming: true,
  supportsImages: false,
  contextWindowSize: 128000,
};

function mockClient(content: string): LLMClient {
  const result = makeResult(content);
  return {
    model: "test-model",
    provider: "openai",
    capabilities: defaultCapabilities,
    async invoke() {
      return result;
    },
    async *stream() {
      for (const event of makeStreamEvents(result)) {
        yield event;
      }
    },
    estimateTokens: () => 10,
  };
}

function createTestAgent(ctx: AgentContext): ConversationalAgent {
  const client = mockClient("Test response");
  return new ConversationalAgent({
    context: ctx,
    client,
    instructions: "Test agent",
  });
}

describe("agent tools", () => {
  describe("handleAgentList", () => {
    it("returns list of registered agents", async () => {
      const registry = new AgentRegistry({
        agents: [
          { create: createTestAgent, agentId: "test", description: "A test agent" },
        ],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = { registry, persistence };

      const result = await handleAgentList(deps);
      const payload = JSON.parse(result.content[0].text);

      expect(payload.defaultAgentId).toBe("test");
      expect(payload.agents).toEqual([
        { agentId: "test", description: "A test agent" },
      ]);
      expect(result.structuredContent).toEqual(payload);
      expect(result.isError).toBe(false);
    });
  });

  describe("handleAgentRun", () => {
    it("runs an agent and returns result", async () => {
      const registry = new AgentRegistry({
        agents: [
          { create: createTestAgent, agentId: "test", description: "Test" },
        ],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = { registry, persistence };

      const result = await handleAgentRun(deps, {
        message: "Hello",
        agentId: "test",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("success");
      expect(parsed.message).toBe("Test response");
      expect(parsed.agentId).toBe("test");
      expect(result.structuredContent).toEqual(parsed);
      expect(result.isError).toBe(false);
    });

    it("persists conversation turn", async () => {
      const registry = new AgentRegistry({
        agents: [
          { create: createTestAgent, agentId: "test" },
        ],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = { registry, persistence };

      await handleAgentRun(deps, {
        message: "Hello",
        agentId: "test",
        title: "Test Title",
      });

      expect(persistence.appendConversationTurn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          userMessage: "Hello",
          assistantMessage: "Test response",
          status: "success",
        }),
        "Test Title",
      );
    });

    it("records input message history", async () => {
      const registry = new AgentRegistry({
        agents: [{ create: createTestAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = { registry, persistence };

      await handleAgentRun(deps, { message: "Hello", agentId: "test" });

      expect(persistence.appendInputMessageHistory).toHaveBeenCalledWith(
        "Hello",
        expect.any(String),
        expect.any(String),
      );
    });

    it("returns cached result for duplicate idempotency key", async () => {
      const registry = new AgentRegistry({
        agents: [{ create: createTestAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const cachedResult = { status: "success", message: "cached" };
      (persistence.readIdempotencyRecord as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        idempotencyKey: "key-1",
        result: cachedResult,
      });
      const deps: AgentToolDeps = { registry, persistence };

      const result = await handleAgentRun(deps, {
        message: "Hello",
        agentId: "test",
        idempotencyKey: "key-1",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toBe("cached");
    });

    it("writes idempotency record on success", async () => {
      const registry = new AgentRegistry({
        agents: [{ create: createTestAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = { registry, persistence };

      await handleAgentRun(deps, {
        message: "Hello",
        agentId: "test",
        idempotencyKey: "key-1",
      });

      expect(persistence.writeIdempotencyRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: "key-1",
          status: "success",
        }),
      );
    });

    it("handles agent errors gracefully", async () => {
      function failingAgent(ctx: AgentContext): ConversationalAgent {
        const client: LLMClient = {
          model: "test",
          provider: "openai",
          capabilities: defaultCapabilities,
          async invoke() { throw new Error("LLM failed"); },
          async *stream() { throw new Error("LLM failed"); },
          estimateTokens: () => 10,
        };
        return new ConversationalAgent({
          context: ctx,
          client,
          instructions: "Fail",
        });
      }

      const registry = new AgentRegistry({
        agents: [{ create: failingAgent, agentId: "fail" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = { registry, persistence };

      const result = await handleAgentRun(deps, {
        message: "Hello",
        agentId: "fail",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("error");
      expect(parsed.errorMessage).toBe("LLM failed");
      expect(result.isError).toBe(true);
    });

    it("records usage on success", async () => {
      const registry = new AgentRegistry({
        agents: [{ create: createTestAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = { registry, persistence };

      await handleAgentRun(deps, { message: "Hello", agentId: "test" });

      expect(persistence.appendUsage).toHaveBeenCalledWith(
        expect.any(Number),
        "usd",
        expect.any(String),
        expect.any(String),
      );
    });
  });
});
