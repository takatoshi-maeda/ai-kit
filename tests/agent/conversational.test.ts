import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConversationalAgent } from "../../src/agent/conversational.js";
import { AgentContextImpl } from "../../src/agent/context.js";
import { defineTool } from "../../src/llm/tool/define.js";
import { MaxTurnsExceededError } from "../../src/errors.js";
import type { LLMClient, ConversationHistory } from "../../src/types/agent.js";
import type { LLMResult, LLMUsage, LLMChatInput } from "../../src/types/llm.js";
import type { LLMStreamEvent } from "../../src/types/stream-events.js";
import type { ModelCapabilities } from "../../src/types/model.js";

// --- Helpers ---

function stubHistory(): ConversationHistory {
  const messages: { role: string; content: string | unknown[] }[] = [];
  return {
    async getMessages() {
      return [];
    },
    async addMessage(msg) {
      messages.push(msg);
    },
    async toLLMMessages() {
      return [];
    },
    async clear() {
      messages.length = 0;
    },
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
  finishReason?: LLMResult["finishReason"];
}): LLMResult {
  return {
    type: opts.toolCalls?.length ? "tool_use" : "message",
    content: opts.content ?? null,
    toolCalls: opts.toolCalls ?? [],
    usage: emptyUsage(),
    responseId: "resp-1",
    finishReason: opts.finishReason ?? (opts.toolCalls?.length ? "tool_use" : "stop"),
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

function mockClient(responses: LLMResult[]): LLMClient {
  let callIndex = 0;
  return {
    model: "test-model",
    provider: "openai",
    capabilities: defaultCapabilities,
    async invoke(input: LLMChatInput) {
      return responses[callIndex++];
    },
    async *stream(input: LLMChatInput) {
      const result = responses[callIndex++];
      for (const event of makeStreamEvents(result)) {
        yield event;
      }
    },
    estimateTokens() {
      return 10;
    },
  };
}

// --- Tests ---

describe("ConversationalAgent", () => {
  describe("invoke", () => {
    it("returns result from single-turn conversation", async () => {
      const result = makeResult({ content: "Hello!" });
      const client = mockClient([result]);
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "You are helpful.",
      });

      const agentResult = await agent.invoke("Hi");

      expect(agentResult.content).toBe("Hello!");
      expect(agentResult.responseId).toBe("resp-1");
      expect(agentResult.usage.totalTokens).toBe(15);
      expect(agentResult.raw).toBe(result);
    });

    it("handles multi-turn tool call loop", async () => {
      const echoTool = defineTool({
        name: "echo",
        description: "Echo input",
        parameters: z.object({ text: z.string() }),
        execute: async ({ text }) => `echoed: ${text}`,
      });

      const toolCallResult = makeResult({
        content: null,
        toolCalls: [
          { id: "tc-1", name: "echo", arguments: { text: "hello" } },
        ],
      });
      const finalResult = makeResult({ content: "Got echo result" });
      const client = mockClient([toolCallResult, finalResult]);
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Use tools.",
        tools: [echoTool],
      });

      const agentResult = await agent.invoke("Echo something");

      expect(agentResult.content).toBe("Got echo result");
      expect(agentResult.toolCalls).toHaveLength(1);
      expect(agentResult.toolCalls[0].result?.content).toBe(
        "echoed: hello",
      );
      expect(context.turns).toHaveLength(2);
      expect(context.turns[0].turnType).toBe("next_action");
      expect(context.turns[1].turnType).toBe("finish");
    });

    it("accumulates usage across turns", async () => {
      const tool = defineTool({
        name: "noop",
        description: "No-op",
        parameters: z.object({}),
        execute: async () => "ok",
      });

      const r1 = makeResult({
        toolCalls: [{ id: "tc-1", name: "noop", arguments: {} }],
      });
      const r2 = makeResult({ content: "Done" });
      const client = mockClient([r1, r2]);
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
        tools: [tool],
      });

      const agentResult = await agent.invoke("Go");

      expect(agentResult.usage.totalTokens).toBe(30); // 15 * 2
      expect(agentResult.usage.totalCost).toBeCloseTo(0.004);
    });

    it("throws MaxTurnsExceededError when limit reached", async () => {
      const tool = defineTool({
        name: "loop",
        description: "Always called",
        parameters: z.object({}),
        execute: async () => "ok",
      });

      // Always return tool calls — never finishes
      const responses = Array.from({ length: 5 }, () =>
        makeResult({
          toolCalls: [{ id: "tc", name: "loop", arguments: {} }],
        }),
      );
      const client = mockClient(responses);
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
        tools: [tool],
        maxTurns: 3,
      });

      await expect(agent.invoke("Go")).rejects.toThrow(
        MaxTurnsExceededError,
      );
    });
  });

  describe("stream", () => {
    it("yields events and resolves result", async () => {
      const result = makeResult({ content: "Streamed!" });
      const client = mockClient([result]);
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
      });

      const agentStream = agent.stream("Hi");
      const events: LLMStreamEvent[] = [];
      for await (const event of agentStream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "response.completed")).toBe(true);

      const agentResult = await agentStream.result;
      expect(agentResult.content).toBe("Streamed!");
    });

    it("propagates errors", async () => {
      const client: LLMClient = {
        model: "test",
        provider: "openai",
        capabilities: defaultCapabilities,
        async invoke() {
          throw new Error("fail");
        },
        async *stream() {
          throw new Error("stream fail");
        },
        estimateTokens() {
          return 0;
        },
      };

      const context = new AgentContextImpl({ history: stubHistory() });
      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
      });

      const agentStream = agent.stream("Hi");
      await expect(async () => {
        for await (const _ of agentStream) {
          // consume
        }
      }).rejects.toThrow("stream fail");

      await expect(agentStream.result).rejects.toThrow("stream fail");
    });
  });

  describe("hooks", () => {
    it("calls beforeTurn and afterTurn hooks", async () => {
      const order: string[] = [];
      const result = makeResult({ content: "OK" });
      const client = mockClient([result]);
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
        hooks: {
          beforeTurn: [async () => { order.push("beforeTurn"); }],
          afterTurn: [async () => { order.push("afterTurn"); }],
        },
      });

      await agent.invoke("Hi");
      expect(order).toEqual(["beforeTurn", "afterTurn"]);
    });

    it("calls beforeToolCall and afterToolCall hooks", async () => {
      const hookCalls: string[] = [];
      const tool = defineTool({
        name: "t",
        description: "test",
        parameters: z.object({}),
        execute: async () => "ok",
      });

      const r1 = makeResult({
        toolCalls: [{ id: "tc", name: "t", arguments: {} }],
      });
      const r2 = makeResult({ content: "Done" });
      const client = mockClient([r1, r2]);
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
        tools: [tool],
        hooks: {
          beforeToolCall: [async (ctx) => {
            hookCalls.push(`before:${ctx.toolCall.name}`);
          }],
          afterToolCall: [async (ctx) => {
            hookCalls.push(`after:${ctx.toolCall.name}:${ctx.result.content}`);
          }],
        },
      });

      await agent.invoke("Go");

      expect(hookCalls).toEqual(["before:t", "after:t:ok"]);
    });

    it("supports afterRun rerun", async () => {
      let runCount = 0;
      const responses = [
        makeResult({ content: "first" }),
        makeResult({ content: "second" }),
      ];
      const client = mockClient(responses);
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
        hooks: {
          afterRun: [
            async () => {
              runCount++;
              if (runCount === 1) return { type: "rerun" as const };
              return { type: "done" as const };
            },
          ],
        },
      });

      const result = await agent.invoke("Go");

      expect(runCount).toBe(2);
      expect(result.content).toBe("second");
    });
  });

  describe("tool pipeline", () => {
    it("executes onStart enforced tools", async () => {
      const startTool = defineTool({
        name: "init",
        description: "Initialize",
        parameters: z.object({}),
        execute: async () => "initialized",
      });

      const result = makeResult({ content: "OK" });
      // We need the client to receive the enforced tool result in messages
      let receivedMessages: LLMChatInput["messages"] = [];
      const client: LLMClient = {
        model: "test",
        provider: "openai",
        capabilities: defaultCapabilities,
        async invoke(input) {
          return result;
        },
        async *stream(input) {
          receivedMessages = input.messages;
          for (const event of makeStreamEvents(result)) {
            yield event;
          }
        },
        estimateTokens: () => 10,
      };

      const context = new AgentContextImpl({ history: stubHistory() });
      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
        toolPipeline: { onStart: [startTool] },
      });

      await agent.invoke("Hi");

      // The enforced tool result should appear in messages
      const initMessage = receivedMessages.find(
        (m) => typeof m.content === "string" && m.content.includes("[init]"),
      );
      expect(initMessage).toBeDefined();
    });

    it("executes onBeforeComplete tools before finishing", async () => {
      const validateTool = defineTool({
        name: "validate",
        description: "Validate",
        parameters: z.object({}),
        execute: async () => "valid",
      });

      // First response: LLM tries to finish
      // Second response: After onBeforeComplete, LLM finishes
      const r1 = makeResult({ content: "Almost done" });
      const r2 = makeResult({ content: "Done after validation" });

      let callCount = 0;
      let lastMessages: LLMChatInput["messages"] = [];
      const client: LLMClient = {
        model: "test",
        provider: "openai",
        capabilities: defaultCapabilities,
        async invoke(input) {
          return callCount++ === 0 ? r1 : r2;
        },
        async *stream(input) {
          const result = callCount++ === 0 ? r1 : r2;
          lastMessages = input.messages;
          for (const event of makeStreamEvents(result)) {
            yield event;
          }
        },
        estimateTokens: () => 10,
      };

      const context = new AgentContextImpl({ history: stubHistory() });
      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
        toolPipeline: { onBeforeComplete: [validateTool] },
      });

      const result = await agent.invoke("Go");

      expect(result.content).toBe("Done after validation");
      // Validate tool output should be in the second call's messages
      const validateMsg = lastMessages.find(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes("[validate]"),
      );
      expect(validateMsg).toBeDefined();
    });
  });

  describe("additionalInstructions", () => {
    it("appends additional instructions", async () => {
      const result = makeResult({ content: "OK" });
      let receivedInstructions: string | undefined;

      const client: LLMClient = {
        model: "test",
        provider: "openai",
        capabilities: defaultCapabilities,
        async invoke() {
          return result;
        },
        async *stream(input) {
          receivedInstructions = input.instructions;
          for (const event of makeStreamEvents(result)) {
            yield event;
          }
        },
        estimateTokens: () => 10,
      };

      const context = new AgentContextImpl({ history: stubHistory() });
      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Base instructions",
      });

      await agent.invoke("Hi", "Extra info");
      expect(receivedInstructions).toBe("Base instructions\n\nExtra info");
    });
  });

  describe("conversation history", () => {
    it("saves user and assistant messages to history", async () => {
      const result = makeResult({ content: "Hello back" });
      const client = mockClient([result]);
      const savedMessages: { role: string; content: string | unknown[] }[] = [];
      const history: ConversationHistory = {
        async getMessages() { return []; },
        async addMessage(msg) { savedMessages.push(msg); },
        async toLLMMessages() { return []; },
        async clear() {},
      };
      const context = new AgentContextImpl({ history });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Test",
      });

      await agent.invoke("Hi");

      expect(savedMessages).toHaveLength(2);
      expect(savedMessages[0]).toEqual({ role: "user", content: "Hi" });
      expect(savedMessages[1]).toEqual({ role: "assistant", content: "Hello back" });
    });
  });
});
