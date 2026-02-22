import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { GoogleClient } from "../../src/llm/providers/google.js";
import type { LLMChatInput } from "../../src/types/llm.js";

// Mock the Google GenAI module
const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();

let capturedCtorArgs: unknown;

vi.mock("@google/genai", () => {
  class MockGoogleGenAI {
    models = {
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
    };
    constructor(args: unknown) {
      capturedCtorArgs = args;
    }
  }

  return {
    GoogleGenAI: MockGoogleGenAI,
  };
});

function makeClient(overrides = {}) {
  return new GoogleClient({
    provider: "google",
    model: "gemini-2.5-flash",
    apiKey: "test-key",
    ...overrides,
  });
}

function makeBasicInput(): LLMChatInput {
  return {
    messages: [{ role: "user", content: "Hello" }],
  };
}

describe("GoogleClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("sets provider and model", () => {
      const client = makeClient();
      expect(client.provider).toBe("google");
      expect(client.model).toBe("gemini-2.5-flash");
      expect(client.capabilities.supportsToolCalls).toBe(true);
    });

    it("passes apiKey when provided", () => {
      makeClient({ apiKey: "my-key" });
      expect(capturedCtorArgs).toEqual({ apiKey: "my-key" });
    });

    it("uses Vertex AI mode when GOOGLE_CLOUD_SA_CREDENTIAL is set and no apiKey", () => {
      const sa = {
        project_id: "my-project",
        client_email: "sa@my-project.iam.gserviceaccount.com",
        private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
      };
      process.env.GOOGLE_CLOUD_SA_CREDENTIAL = JSON.stringify(sa);
      try {
        makeClient({ apiKey: undefined });
        expect(capturedCtorArgs).toEqual({
          vertexai: true,
          project: "my-project",
          location: "us-central1",
          googleAuthOptions: {
            credentials: {
              client_email: sa.client_email,
              private_key: sa.private_key,
            },
          },
        });
      } finally {
        delete process.env.GOOGLE_CLOUD_SA_CREDENTIAL;
      }
    });

    it("prefers apiKey over GOOGLE_CLOUD_SA_CREDENTIAL", () => {
      process.env.GOOGLE_CLOUD_SA_CREDENTIAL = JSON.stringify({
        project_id: "p",
        client_email: "e",
        private_key: "k",
      });
      try {
        makeClient({ apiKey: "explicit-key" });
        expect(capturedCtorArgs).toEqual({ apiKey: "explicit-key" });
      } finally {
        delete process.env.GOOGLE_CLOUD_SA_CREDENTIAL;
      }
    });
  });

  describe("invoke", () => {
    it("returns LLMResult from Gemini response", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: "Hello back!" }],
              role: "model",
            },
            finishReason: "STOP",
          },
        ],
        responseId: "resp-1",
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
          cachedContentTokenCount: 0,
        },
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());

      expect(result.type).toBe("message");
      expect(result.content).toBe("Hello back!");
      expect(result.responseId).toBe("resp-1");
      expect(result.finishReason).toBe("stop");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
    });

    it("maps function calls to tool_use", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "search",
                    args: { query: "test" },
                  },
                },
              ],
              role: "model",
            },
            finishReason: "STOP",
          },
        ],
        responseId: "resp-2",
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());

      expect(result.type).toBe("tool_use");
      expect(result.finishReason).toBe("tool_use");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("search");
      expect(result.toolCalls[0].arguments).toEqual({ query: "test" });
    });

    it("passes system messages as systemInstruction", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: "ok" }], role: "model" },
            finishReason: "STOP",
          },
        ],
      });

      const client = makeClient();
      await client.invoke({
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hi" },
        ],
        instructions: "Extra instructions",
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      // System messages are excluded from contents
      expect(callArgs.contents).toHaveLength(1);
      expect(callArgs.contents[0].role).toBe("user");
      // Instructions go to systemInstruction
      expect(callArgs.config.systemInstruction).toBe("Extra instructions");
    });

    it("converts tool definitions to FunctionDeclaration", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: "ok" }], role: "model" },
            finishReason: "STOP",
          },
        ],
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

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const tools = callArgs.config.tools;
      expect(tools).toHaveLength(1);
      expect(tools[0].functionDeclarations).toHaveLength(1);
      expect(tools[0].functionDeclarations[0].name).toBe("calc");
    });

    it("maps assistant messages to model role", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: "ok" }], role: "model" },
            finishReason: "STOP",
          },
        ],
      });

      const client = makeClient();
      await client.invoke({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
          { role: "user", content: "How are you?" },
        ],
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.contents[1].role).toBe("model");
    });

    it("maps tool result messages to functionResponse", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: "ok" }], role: "model" },
            finishReason: "STOP",
          },
        ],
      });

      const client = makeClient();
      await client.invoke({
        messages: [
          {
            role: "tool",
            content: "result data",
            toolCallId: "fc-1",
            name: "search",
          },
        ],
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.contents[0].parts[0].functionResponse).toBeDefined();
      expect(callArgs.contents[0].parts[0].functionResponse.name).toBe("search");
    });

    it("maps MAX_TOKENS finish reason to length", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: "truncated" }], role: "model" },
            finishReason: "MAX_TOKENS",
          },
        ],
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());
      expect(result.finishReason).toBe("length");
    });

    it("maps SAFETY finish reason to content_filter", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: "" }], role: "model" },
            finishReason: "SAFETY",
          },
        ],
      });

      const client = makeClient();
      const result = await client.invoke(makeBasicInput());
      expect(result.finishReason).toBe("content_filter");
    });
  });

  describe("estimateTokens", () => {
    it("estimates roughly 4 chars per token", () => {
      const client = makeClient();
      expect(client.estimateTokens("abcdefgh")).toBe(2);
    });
  });
});
