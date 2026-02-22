import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { LLMChatInput } from "../../src/types/llm.js";
import { LLMApiError, RateLimitError, ContextLengthExceededError } from "../../src/errors.js";

// Hoist mock functions so they're shared across all mock instances
const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: mockCreate,
      stream: mockStream,
    };
    constructor(_opts?: Record<string, unknown>) {
      // Accept any options silently
    }
  }

  class APIError extends Error {
    status: number;
    headers: Record<string, string>;
    constructor(
      status: number,
      message: string,
      headers: Record<string, string> = {},
    ) {
      super(message);
      this.status = status;
      this.headers = headers;
      this.name = "APIError";
    }
  }

  MockOpenAI.APIError = APIError;

  return {
    default: MockOpenAI,
    APIError,
  };
});

// Import after mock setup
const { OpenAIClient } = await import("../../src/llm/providers/openai.js");

function makeClient(overrides = {}) {
  return new OpenAIClient({
    provider: "openai",
    model: "gpt-4o",
    apiKey: "test-key",
    ...overrides,
  });
}

function makeBasicInput(): LLMChatInput {
  return {
    messages: [{ role: "user", content: "Hello" }],
  };
}

describe("OpenAIClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("sets provider, model, and capabilities", () => {
      const client = makeClient();
      expect(client.provider).toBe("openai");
      expect(client.model).toBe("gpt-4o");
      expect(client.capabilities.supportsToolCalls).toBe(true);
      expect(client.capabilities.supportsStreaming).toBe(true);
    });
  });

  describe("invoke", () => {
    it("converts messages and returns LLMResult", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-1",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Hi there!" }],
          },
        ],
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());

      expect(result.type).toBe("message");
      expect(result.content).toBe("Hi there!");
      expect(result.toolCalls).toEqual([]);
      expect(result.responseId).toBe("resp-1");
      expect(result.finishReason).toBe("stop");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
      expect(result.usage.cachedInputTokens).toBe(2);
    });

    it("maps function calls to tool_use result", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-2",
        output: [
          {
            type: "function_call",
            call_id: "fc-1",
            name: "search",
            arguments: '{"query":"test"}',
          },
        ],
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: {},
          output_tokens_details: {},
        },
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());

      expect(result.type).toBe("tool_use");
      expect(result.finishReason).toBe("tool_use");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe("fc-1");
      expect(result.toolCalls[0].name).toBe("search");
      expect(result.toolCalls[0].arguments).toEqual({ query: "test" });
    });

    it("passes instructions to params", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-3",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        status: "completed",
      });

      const client = makeClient();
      await client.invoke({
        messages: [{ role: "user", content: "Hello" }],
        instructions: "Be helpful",
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.instructions).toBe("Be helpful");
    });

    it("converts tool definitions", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-4",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        status: "completed",
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
      expect(callArgs.tools[0].type).toBe("function");
      expect(callArgs.tools[0].name).toBe("calc");
    });

    it("maps system messages to developer role", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-5",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        status: "completed",
      });

      const client = makeClient();
      await client.invoke({
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hi" },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      const input = callArgs.input;
      expect(input[0].role).toBe("developer");
      expect(input[1].role).toBe("user");
    });

    it("maps tool messages to function_call_output", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-6",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        status: "completed",
      });

      const client = makeClient();
      await client.invoke({
        messages: [
          { role: "tool", content: "result data", toolCallId: "fc-1" },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      const input = callArgs.input;
      expect(input[0].type).toBe("function_call_output");
      expect(input[0].call_id).toBe("fc-1");
    });

    it("handles incomplete status as length finish reason", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-7",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "truncated" }],
          },
        ],
        status: "incomplete",
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          total_tokens: 110,
          input_tokens_details: {},
          output_tokens_details: {},
        },
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());
      expect(result.finishReason).toBe("length");
    });

    it("passes reasoning options for o-series models", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-8",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        status: "completed",
      });

      const client = makeClient({
        model: "o3",
        reasoningEffort: "high",
        reasoningSummary: "concise",
      });
      await client.invoke(makeBasicInput());

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.reasoning).toEqual({
        effort: "high",
        summary: "concise",
      });
    });
  });

  describe("error mapping", () => {
    it("maps 429 to RateLimitError", async () => {
      const OpenAI = (await import("openai")).default as any;
      const err = new OpenAI.APIError(429, "Too many requests");
      mockCreate.mockRejectedValue(err);

      const client = makeClient();
      await expect(client.invoke(makeBasicInput())).rejects.toThrow(
        RateLimitError,
      );
    });

    it("maps context_length_exceeded to ContextLengthExceededError", async () => {
      const OpenAI = (await import("openai")).default as any;
      const err = new OpenAI.APIError(400, "context_length_exceeded");
      mockCreate.mockRejectedValue(err);

      const client = makeClient();
      await expect(client.invoke(makeBasicInput())).rejects.toThrow(
        ContextLengthExceededError,
      );
    });

    it("maps other API errors to LLMApiError", async () => {
      const OpenAI = (await import("openai")).default as any;
      const err = new OpenAI.APIError(500, "Internal error");
      mockCreate.mockRejectedValue(err);

      const client = makeClient();
      await expect(client.invoke(makeBasicInput())).rejects.toThrow(
        LLMApiError,
      );
    });
  });

  describe("estimateTokens", () => {
    it("estimates roughly 4 chars per token", () => {
      const client = makeClient();
      expect(client.estimateTokens("hello world")).toBe(3); // 11 / 4 = 2.75 → 3
    });
  });
});
