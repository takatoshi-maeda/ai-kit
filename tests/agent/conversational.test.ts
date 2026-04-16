import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConversationalAgent } from "../../src/agent/conversational.js";
import { AgentContextImpl } from "../../src/agent/context.js";
import { defineTool } from "../../src/llm/tool/define.js";
import { MaxTurnsExceededError } from "../../src/errors.js";
import type { LLMClient, ConversationHistory } from "../../src/types/agent.js";
import type {
  ContentPart,
  LLMResult,
  LLMUsage,
  LLMChatInput,
} from "../../src/types/llm.js";
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

function trackingHistory(): {
  history: ConversationHistory;
  messages: { role: string; content: string | unknown[] }[];
} {
  const messages: { role: string; content: string | unknown[] }[] = [];
  const history: ConversationHistory = {
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
  return { history, messages };
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
  responseId?: string;
}): LLMResult {
  return {
    type: opts.toolCalls?.length ? "tool_use" : "message",
    content: opts.content ?? null,
    toolCalls: opts.toolCalls ?? [],
    usage: emptyUsage(),
    responseId: opts.responseId ?? "resp-1",
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

    it("accepts multimodal input and stores it in conversation history", async () => {
      const result = makeResult({ content: "Acknowledged image input." });
      const client = mockClient([result]);
      const tracked = trackingHistory();
      const context = new AgentContextImpl({ history: tracked.history });
      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "You are helpful.",
      });

      const multimodalInput: ContentPart[] = [
        {
          type: "image",
          source: { type: "url", url: "https://example.com/screenshot.png" },
        },
        { type: "text", text: "What is shown here?" },
      ];
      const agentResult = await agent.invoke(multimodalInput);

      expect(agentResult.content).toBe("Acknowledged image input.");
      expect(tracked.messages[0]?.role).toBe("user");
      expect(tracked.messages[0]?.content).toEqual(multimodalInput);
      expect(tracked.messages[1]?.role).toBe("assistant");
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
          { id: "tc-1", name: "echo", arguments: { text: "hello" }, provider: "openai" },
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
      expect(agentResult.toolCalls[0].result?.extra).toMatchObject({
        providerRaw: {
          provider: "openai",
          inputItems: [
            {
              type: "function_call_output",
              call_id: "tc-1",
              output: "echoed: hello",
            },
          ],
        },
      });
    });

    it("uses the latest OpenAI response id and only sends incremental tool messages on follow-up turns", async () => {
      const echoTool = defineTool({
        name: "echo",
        description: "Echo input",
        parameters: z.object({ text: z.string() }),
        execute: async ({ text }) => `echoed: ${text}`,
      });

      const capturedInputs: LLMChatInput[] = [];
      const toolCallResult = makeResult({
        responseId: "resp-tool-turn",
        toolCalls: [
          {
            id: "tc-1",
            name: "echo",
            arguments: { text: "hello" },
            provider: "openai",
          },
        ],
      });
      const finalResult = makeResult({
        responseId: "resp-final-turn",
        content: "Got echo result",
      });
      const client: LLMClient = {
        model: "test-model",
        provider: "openai",
        capabilities: defaultCapabilities,
        async invoke() {
          throw new Error("invoke should not be called");
        },
        async *stream(input: LLMChatInput) {
          capturedInputs.push(input);
          const result = capturedInputs.length === 1 ? toolCallResult : finalResult;
          for (const event of makeStreamEvents(result)) {
            yield event;
          }
        },
        estimateTokens() {
          return 10;
        },
      };
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Use tools.",
        tools: [echoTool],
      });

      const agentResult = await agent.invoke("Echo something");

      expect(agentResult.content).toBe("Got echo result");
      expect(capturedInputs[0]?.previousResponseId).toBeUndefined();
      expect(capturedInputs[1]?.previousResponseId).toBe("resp-tool-turn");
      expect(capturedInputs[1]?.messages).toEqual([
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "tool", toolCallId: "tc-1" }),
      ]);
      expect(capturedInputs[1]?.messages.some((message) => message.role === "user")).toBe(false);
      expect(context.metadata.get("previousResponseId")).toBe("resp-final-turn");
    });

    it("routes provider-native tool calls through the native runtime", async () => {
      const capturedInputs: LLMChatInput[] = [];
      const nativeToolCall = makeResult({
        toolCalls: [
          {
            id: "shell-call-1",
            name: "shell",
            arguments: { commands: ["pwd"] },
            executionKind: "provider_native",
            provider: "openai",
            extra: {
              providerRaw: {
                provider: "openai",
                outputItems: [{ type: "shell_call", call_id: "shell-call-1", action: { commands: ["pwd"] } }],
              },
            },
          },
        ],
      });
      const finalResult = makeResult({ content: "shell complete" });
      const client: LLMClient = {
        model: "test-model",
        provider: "openai",
        capabilities: defaultCapabilities,
        async invoke() {
          throw new Error("invoke should not be called");
        },
        async *stream(input: LLMChatInput) {
          capturedInputs.push(input);
          const result = capturedInputs.length === 1 ? nativeToolCall : finalResult;
          for (const event of makeStreamEvents(result)) {
            yield event;
          }
        },
        estimateTokens() {
          return 10;
        },
      };
      const nativeToolRuntime = {
        supports: () => true,
        async execute() {
          return {
            toolCallId: "shell-call-1",
            content: "[]",
            extra: {
              providerRaw: {
                provider: "openai",
                inputItems: [{ type: "shell_call_output", call_id: "shell-call-1", output: [] }],
              },
            },
          };
        },
      };
      const context = new AgentContextImpl({ history: stubHistory() });
      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Use native tools.",
        tools: [
          {
            kind: "provider_native",
            provider: "openai",
            type: "shell",
            workingDir: "/workspace",
            timeoutMs: 10_000,
          },
        ],
        nativeToolRuntime,
      });

      const agentResult = await agent.invoke("Inspect repo");

      expect(agentResult.content).toBe("shell complete");
      expect(capturedInputs[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          toolCallId: "shell-call-1",
          extra: {
            providerRaw: {
              provider: "openai",
              inputItems: [{ type: "shell_call", call_id: "shell-call-1", action: { commands: ["pwd"] } }, { type: "shell_call_output", call_id: "shell-call-1", output: [] }],
              outputItems: [{ type: "shell_call", call_id: "shell-call-1", action: { commands: ["pwd"] } }],
            },
            tool: {
              call: {
                id: "shell-call-1",
                name: "shell",
                executionKind: "provider_native",
                provider: "openai",
                arguments: { commands: ["pwd"] },
                extra: {
                  providerRaw: {
                    provider: "openai",
                    outputItems: [{ type: "shell_call", call_id: "shell-call-1", action: { commands: ["pwd"] } }],
                  },
                },
              },
              result: {
                content: "[]",
                isError: undefined,
                extra: {
                  providerRaw: {
                    provider: "openai",
                    inputItems: [{ type: "shell_call_output", call_id: "shell-call-1", output: [] }],
                  },
                },
              },
            },
          },
        }),
      );
    });

    it("continues after a tool failure and passes the error result back to the model", async () => {
      const failingTool = defineTool({
        name: "read_file",
        description: "Read a file",
        parameters: z.object({ path: z.string() }),
        execute: async () => {
          throw new Error("File not found: README.md");
        },
      });

      const capturedInputs: LLMChatInput[] = [];
      const toolCallResult = makeResult({
        toolCalls: [{ id: "tc-1", name: "read_file", arguments: { path: "README.md" }, provider: "openai" }],
      });
      toolCallResult.toolCalls[0]!.extra = {
        providerRaw: {
          provider: "openai",
          outputItems: [
            {
              type: "function_call",
              call_id: "tc-1",
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}",
            },
          ],
        },
      };
      const finalResult = makeResult({ content: "README.md は存在しませんでした。" });
      const client: LLMClient = {
        model: "test-model",
        provider: "openai",
        capabilities: defaultCapabilities,
        async invoke() {
          throw new Error("invoke should not be called");
        },
        async *stream(input: LLMChatInput) {
          capturedInputs.push(input);
          const result = capturedInputs.length === 1 ? toolCallResult : finalResult;
          for (const event of makeStreamEvents(result)) {
            yield event;
          }
        },
        estimateTokens() {
          return 10;
        },
      };
      const context = new AgentContextImpl({ history: stubHistory() });

      const agent = new ConversationalAgent({
        context,
        client,
        instructions: "Use tools.",
        tools: [failingTool],
      });

      const agentResult = await agent.invoke("Read the readme");

      expect(agentResult.content).toBe("README.md は存在しませんでした。");
      expect(agentResult.toolCalls).toHaveLength(1);
      expect(agentResult.toolCalls[0].result).toMatchObject({
        isError: true,
        content: 'Tool "read_file" failed: File not found: README.md',
      });
      expect(capturedInputs[1]?.messages.some((message) => message.role === "tool" && String(message.content).includes("File not found: README.md"))).toBe(true);
      const toolMessage = capturedInputs[1]?.messages.find((message) => message.role === "tool");
      expect(toolMessage?.extra).toMatchObject({
        providerRaw: {
          provider: "openai",
          inputItems: [
            {
              type: "function_call",
              call_id: "tc-1",
            },
            {
              type: "function_call_output",
              call_id: "tc-1",
            },
          ],
        },
      });
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
