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

    it("converts OpenAI native tool declarations", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-native-tools",
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
        messages: [{ role: "user", content: "inspect repo" }],
        tools: [
          {
            kind: "provider_native",
            provider: "openai",
            type: "shell",
            workingDir: "/workspace",
            timeoutMs: 10_000,
          },
          {
            kind: "provider_native",
            provider: "openai",
            type: "apply_patch",
            allowedPaths: ["docs/spec"],
          },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toEqual([
        { type: "shell", environment: { type: "local" } },
        { type: "apply_patch" },
      ]);
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
      expect(input[0].type).toBe("function_call");
      expect(input[0].call_id).toBe("fc-1");
      expect(input[1].type).toBe("function_call_output");
      expect(input[1].call_id).toBe("fc-1");
    });

    it("reuses providerRaw input items for native tool follow-up turns", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-provider-raw",
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
          {
            role: "tool",
            content: "native output",
            toolCallId: "shell-1",
            name: "shell",
            extra: {
              providerRaw: {
                provider: "openai",
                inputItems: [
                  { type: "shell_call", call_id: "shell-1", action: { commands: ["pwd"] } },
                  { type: "shell_call_output", call_id: "shell-1", output: [] },
                ],
              },
            },
          },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.input).toEqual([
        { type: "shell_call", call_id: "shell-1", action: { commands: ["pwd"] } },
        { type: "shell_call_output", call_id: "shell-1", output: [] },
      ]);
    });

    it("maps native tool calls from response output", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-native-call",
        output: [
          {
            type: "shell_call",
            id: "shell-item-1",
            call_id: "shell-call-1",
            action: { commands: ["pwd"] },
          },
          {
            type: "apply_patch_call",
            id: "patch-item-1",
            call_id: "patch-call-1",
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "*** Begin Patch\n*** Update File: docs/spec/a.md\n@@\n-old\n+new\n*** End Patch" }],
              },
            ],
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
      expect(result.toolCalls[0]).toMatchObject({
        id: "shell-call-1",
        name: "shell",
        executionKind: "provider_native",
        provider: "openai",
        arguments: { commands: ["pwd"] },
      });
      expect(result.toolCalls[1]).toMatchObject({
        id: "patch-call-1",
        name: "apply_patch",
        executionKind: "provider_native",
        provider: "openai",
        arguments: {
          patch: "*** Begin Patch\n*** Update File: docs/spec/a.md\n@@\n-old\n+new\n*** End Patch",
        },
      });
    });

    it("parses string apply_patch arguments from response output", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-native-call-string-args",
        output: [
          {
            type: "apply_patch_call",
            id: "patch-item-2",
            call_id: "patch-call-2",
            arguments: JSON.stringify({
              type: "update_file",
              path: "docs/spec/a.md",
              diff: "@@\n-old\n+new",
            }),
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
      expect(result.toolCalls[0]).toMatchObject({
        id: "patch-call-2",
        name: "apply_patch",
        executionKind: "provider_native",
        provider: "openai",
        arguments: {
          type: "update_file",
          path: "docs/spec/a.md",
          diff: "@@\n-old\n+new",
        },
      });
    });

    it("parses operation apply_patch arguments from response output", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-native-call-operation",
        output: [
          {
            type: "apply_patch_call",
            id: "patch-item-op",
            call_id: "patch-call-op",
            operation: {
              type: "update_file",
              path: "docs/spec/README.md",
              diff: "@@\n-old\n+new",
            },
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
      expect(result.toolCalls[0]).toMatchObject({
        id: "patch-call-op",
        name: "apply_patch",
        executionKind: "provider_native",
        provider: "openai",
        arguments: {
          type: "update_file",
          path: "docs/spec/README.md",
          diff: "@@\n-old\n+new",
        },
      });
    });

    it("parses nested string patch content from response output", async () => {
      mockCreate.mockResolvedValue({
        id: "resp-native-call-nested-patch",
        output: [
          {
            type: "apply_patch_call",
            id: "patch-item-3",
            call_id: "patch-call-3",
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "*** Begin Patch\n*** Add File: docs/spec/b.md\n+# B\n*** End Patch",
                  },
                ],
              },
            ],
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
      expect(result.toolCalls[0]).toMatchObject({
        id: "patch-call-3",
        name: "apply_patch",
        executionKind: "provider_native",
        provider: "openai",
        arguments: {
          patch: "*** Begin Patch\n*** Add File: docs/spec/b.md\n+# B\n*** End Patch",
        },
      });
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

  describe("stream", () => {
    it("suppresses pseudo tool-call text from text deltas", async () => {
      mockStream.mockReturnValue((async function* () {
        yield {
          type: "response.output_text.delta",
          delta: "Before ",
        };
        yield {
          type: "response.output_text.delta",
          delta: "[tool_call: apply_patch(\"*** Begin Patch",
        };
        yield {
          type: "response.output_text.delta",
          delta: "\\n*** End Patch\")] After",
        };
        yield {
          type: "response.output_text.done",
          text: "Before [tool_call: apply_patch(\"*** Begin Patch\\n*** End Patch\")] After",
        };
        yield {
          type: "response.completed",
          response: {
            id: "resp-stream-1",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Before [tool_call: apply_patch(\"*** Begin Patch\\n*** End Patch\")] After" }],
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
          },
        };
      })());

      const client = makeClient();
      const events = [];
      for await (const event of client.stream(makeBasicInput())) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: "text.delta", delta: "Before " });
      expect(events).toContainEqual({ type: "text.done", text: "Before After" });
      expect(events).toContainEqual({
        type: "response.completed",
        result: expect.objectContaining({
          content: "Before After",
          responseId: "resp-stream-1",
        }),
      });
      expect(
        events.some(
          (event) => event.type === "text.delta" && event.delta.includes("[tool_call:"),
        ),
      ).toBe(false);
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
