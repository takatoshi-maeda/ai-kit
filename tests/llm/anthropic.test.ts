import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { LLMChatInput } from "../../src/types/llm.js";
import type { LLMStreamEvent } from "../../src/types/stream-events.js";
import { RateLimitError, ContextLengthExceededError, LLMApiError } from "../../src/errors.js";

// Hoist mock functions
const mockCreate = vi.fn();
const mockStream = vi.fn();

// Custom APIError class shared between mock and tests
class MockAPIError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.headers = {};
    this.name = "APIError";
  }
}

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      create: mockCreate,
      stream: mockStream,
    };
    constructor(_opts?: Record<string, unknown>) {}
    static APIError = MockAPIError;
  }

  return {
    default: MockAnthropic,
    APIError: MockAPIError,
  };
});

const { AnthropicClient } = await import(
  "../../src/llm/providers/anthropic.js"
);

function makeClient(overrides = {}) {
  return new AnthropicClient({
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "test-key",
    ...overrides,
  });
}

function makeBasicInput(): LLMChatInput {
  return {
    messages: [{ role: "user", content: "Hello" }],
  };
}

function makeMockStream(events: unknown[], finalMessage: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
  };
}

describe("AnthropicClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("sets provider and model", () => {
      const client = makeClient();
      expect(client.provider).toBe("anthropic");
      expect(client.model).toBe("claude-sonnet-4-20250514");
      expect(client.capabilities.supportsToolCalls).toBe(true);
    });
  });

  describe("invoke", () => {
    it("returns LLMResult from Anthropic response", async () => {
      mockCreate.mockResolvedValue({
        id: "msg-1",
        content: [{ type: "text", text: "Hello back!" }],
        model: "claude-sonnet-4-20250514",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 0,
        },
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());

      expect(result.type).toBe("message");
      expect(result.content).toBe("Hello back!");
      expect(result.responseId).toBe("msg-1");
      expect(result.finishReason).toBe("stop");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.cachedInputTokens).toBe(2);
    });

    it("separates system messages from chat messages", async () => {
      mockCreate.mockResolvedValue({
        id: "msg-2",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const client = makeClient();
      await client.invoke({
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Hi" },
        ],
        instructions: "Additional instructions",
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toContain("Additional instructions");
      expect(callArgs.system).toContain("Be concise");
      expect(callArgs.messages).toHaveLength(1);
      expect(callArgs.messages[0].role).toBe("user");
    });

    it("maps tool_use content blocks", async () => {
      mockCreate.mockResolvedValue({
        id: "msg-3",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "search",
            input: { query: "test" },
          },
        ],
        stop_reason: "tool_use",
        type: "message",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());

      expect(result.type).toBe("tool_use");
      expect(result.finishReason).toBe("tool_use");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe("tu-1");
      expect(result.toolCalls[0].name).toBe("search");
      expect(result.toolCalls[0].arguments).toEqual({ query: "test" });
    });

    it("converts tool definitions to Anthropic format", async () => {
      mockCreate.mockResolvedValue({
        id: "msg-4",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const client = makeClient();
      await client.invoke({
        messages: [{ role: "user", content: "test" }],
        tools: [
          {
            name: "calc",
            description: "Calculator",
            parameters: z.object({ expr: z.string() }),
            execute: async () => "42",
          },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.tools[0].name).toBe("calc");
      expect(callArgs.tools[0].input_schema.type).toBe("object");
    });

    it("converts tool messages to tool_result blocks", async () => {
      mockCreate.mockResolvedValue({
        id: "msg-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const client = makeClient();
      await client.invoke({
        messages: [
          { role: "tool", content: "result data", toolCallId: "tu-1" },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].role).toBe("user");
      expect(callArgs.messages[0].content[0].type).toBe("tool_result");
      expect(callArgs.messages[0].content[0].tool_use_id).toBe("tu-1");
    });

    it("maps toolChoice correctly", async () => {
      mockCreate.mockResolvedValue({
        id: "msg-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const client = makeClient();
      await client.invoke({
        messages: [{ role: "user", content: "test" }],
        toolChoice: "required",
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tool_choice).toEqual({ type: "any" });
    });

    it("passes thinking config when specified", async () => {
      mockCreate.mockResolvedValue({
        id: "msg-7",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const client = makeClient({ thinking: { budgetTokens: 2048 } });
      await client.invoke(makeBasicInput());

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.thinking).toEqual({
        type: "enabled",
        budget_tokens: 2048,
      });
    });

    it("maps max_tokens stop reason to length", async () => {
      mockCreate.mockResolvedValue({
        id: "msg-8",
        content: [{ type: "text", text: "trunc" }],
        stop_reason: "max_tokens",
        type: "message",
        usage: { input_tokens: 5, output_tokens: 100 },
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());
      expect(result.finishReason).toBe("length");
    });
  });

  describe("error mapping", () => {
    it("maps 429 to RateLimitError", async () => {
      mockCreate.mockRejectedValue(new MockAPIError(429, "Rate limited"));

      const client = makeClient();
      await expect(client.invoke(makeBasicInput())).rejects.toThrow(
        RateLimitError,
      );
    });

    it("maps context_length error", async () => {
      mockCreate.mockRejectedValue(
        new MockAPIError(400, "context_length exceeded"),
      );

      const client = makeClient();
      await expect(client.invoke(makeBasicInput())).rejects.toThrow(
        ContextLengthExceededError,
      );
    });

    it("maps other errors to LLMApiError", async () => {
      mockCreate.mockRejectedValue(new MockAPIError(500, "Server error"));

      const client = makeClient();
      await expect(client.invoke(makeBasicInput())).rejects.toThrow(
        LLMApiError,
      );
    });
  });

  describe("stream", () => {
    it("emits tool_call.arguments.done for tool_use blocks", async () => {
      mockStream.mockReturnValue(
        makeMockStream(
          [
            { type: "message_start", message: { id: "msg-stream-1" } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "tu-1", name: "search" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "{\"query\":\"tes" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "t\"}" },
            },
            { type: "content_block_stop", index: 0 },
            { type: "message_stop" },
          ],
          {
            id: "msg-stream-1",
            content: [
              {
                type: "tool_use",
                id: "tu-1",
                name: "search",
                input: { query: "test" },
              },
            ],
            stop_reason: "tool_use",
            type: "message",
            usage: { input_tokens: 5, output_tokens: 3 },
          },
        ),
      );

      const client = makeClient();
      const events: LLMStreamEvent[] = [];
      for await (const event of client.stream(makeBasicInput())) {
        events.push(event);
      }

      const done = events.find((e) => e.type === "tool_call.arguments.done");
      expect(done).toBeDefined();
      if (done?.type === "tool_call.arguments.done") {
        expect(done.toolCallId).toBe("tu-1");
        expect(done.name).toBe("search");
        expect(done.arguments).toEqual({ query: "test" });
      }
    });

    it("emits reasoning.done for thinking blocks", async () => {
      mockStream.mockReturnValue(
        makeMockStream(
          [
            { type: "message_start", message: { id: "msg-stream-2" } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "step-1 " },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "step-2" },
            },
            { type: "content_block_stop", index: 0 },
            { type: "message_stop" },
          ],
          {
            id: "msg-stream-2",
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            type: "message",
            usage: { input_tokens: 5, output_tokens: 3 },
          },
        ),
      );

      const client = makeClient();
      const events: LLMStreamEvent[] = [];
      for await (const event of client.stream(makeBasicInput())) {
        events.push(event);
      }

      const deltas = events.filter((e) => e.type === "reasoning.delta");
      expect(deltas).toHaveLength(2);

      const done = events.find((e) => e.type === "reasoning.done");
      expect(done).toBeDefined();
      if (done?.type === "reasoning.done") {
        expect(done.text).toBe("step-1 step-2");
      }
    });
  });

  describe("estimateTokens", () => {
    it("estimates roughly 4 chars per token", () => {
      const client = makeClient();
      expect(client.estimateTokens("test")).toBe(1);
    });
  });
});
