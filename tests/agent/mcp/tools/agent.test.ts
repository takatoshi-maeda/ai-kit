import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleAgentList, handleAgentRun } from "../../../../src/agent/mcp/tools/agent.js";
import type { AgentToolDeps } from "../../../../src/agent/mcp/tools/agent.js";
import { AgentRegistry } from "../../../../src/agent/mcp/agent-registry.js";
import { JsonlMcpPersistence } from "../../../../src/agent/mcp/jsonl-persistence.js";
import { handleConversationsGet } from "../../../../src/agent/mcp/tools/conversations.js";
import { ConversationalAgent } from "../../../../src/agent/conversational.js";
import type { McpPersistence } from "../../../../src/agent/mcp/persistence.js";
import { FileSystemStorage } from "../../../../src/storage/fs.js";
import type { AgentContext, ConversationHistory } from "../../../../src/types/agent.js";
import type { LLMClient } from "../../../../src/types/agent.js";
import type { ContentPart, LLMResult, LLMUsage } from "../../../../src/types/llm.js";
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

    it("passes multimodal input via input and persists userContent", async () => {
      const capturedInputs: Array<string | ContentPart[]> = [];
      function multimodalAgent(ctx: AgentContext): ConversationalAgent {
        const client: LLMClient = {
          model: "test-model",
          provider: "openai",
          capabilities: defaultCapabilities,
          async invoke() {
            throw new Error("invoke should not be called");
          },
          async *stream(input) {
            let userMessage = input.messages[0];
            for (let index = input.messages.length - 1; index >= 0; index -= 1) {
              if (input.messages[index]?.role === "user") {
                userMessage = input.messages[index];
                break;
              }
            }
            capturedInputs.push(userMessage?.content ?? "");
            yield {
              type: "response.completed",
              result: makeResult("received multimodal"),
            };
          },
          estimateTokens: () => 10,
        };
        return new ConversationalAgent({
          context: ctx,
          client,
          instructions: "Multimodal agent",
        });
      }

      const registry = new AgentRegistry({
        agents: [{ create: multimodalAgent, agentId: "multi" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = { registry, persistence };
      const input: ContentPart[] = [
        {
          type: "image",
          source: { type: "url", url: "https://example.com/image.png" },
        },
        { type: "text", text: "Describe this image" },
      ];

      const result = await handleAgentRun(deps, { agentId: "multi", input });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.status).toBe("success");
      expect(capturedInputs).toEqual([input]);
      expect(persistence.appendConversationTurn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          userContent: input,
        }),
        undefined,
      );
    });

    it("normalizes base64 image content to public URL and persists normalized content", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-kit-agent-run-"));
      const registry = new AgentRegistry({
        agents: [{ create: createTestAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = {
        registry,
        persistence,
        publicAssetsDir: path.join(tempDir, "public"),
        publicAssetsBasePath: "/api/mcp/test/public",
      };
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Nm7cAAAAASUVORK5CYII=";
      const input: ContentPart[] = [
        {
          type: "image",
          source: {
            type: "base64",
            mediaType: "image/png",
            data: pngBase64,
          },
        },
        { type: "text", text: "normalize me" },
      ];

      try {
        await handleAgentRun(deps, { agentId: "test", input, sessionId: "sess-base64" });

        const appendTurnCall = (persistence.appendConversationTurn as ReturnType<typeof vi.fn>).mock.calls[0];
        const persistedTurn = appendTurnCall?.[1] as { userContent?: ContentPart[]; userMessage?: string } | undefined;
        expect(Array.isArray(persistedTurn?.userContent)).toBe(true);

        const imagePart = persistedTurn?.userContent?.[0];
        expect(imagePart?.type).toBe("image");
        if (imagePart?.type === "image") {
          expect(imagePart.source.type).toBe("url");
          if (imagePart.source.type === "url") {
            expect(imagePart.source.url).toMatch(
              /^uploads\/\d{4}\/\d{2}\/\d{2}\/sess-base64\/[0-9a-f-]+\.png$/,
            );
            const fullPath = path.join(tempDir, "public", imagePart.source.url);
            const saved = await fs.readFile(fullPath);
            expect(saved.length).toBeGreaterThan(0);
          }
        }
        expect(persistedTurn?.userMessage).toContain("[image:url:uploads/");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("normalizes image data URL input to public URL", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-kit-agent-dataurl-"));
      const registry = new AgentRegistry({
        agents: [{ create: createTestAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = {
        registry,
        persistence,
        publicAssetsDir: path.join(tempDir, "public"),
        publicAssetsBasePath: "/api/mcp/test/public",
      };
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Nm7cAAAAASUVORK5CYII=";
      const input: ContentPart[] = [
        {
          type: "image",
          source: {
            type: "url",
            url: `data:image/png;base64,${pngBase64}`,
          },
        },
        { type: "text", text: "normalize data url" },
      ];

      try {
        await handleAgentRun(deps, { agentId: "test", input, sessionId: "sess-data-url" });

        const appendTurnCall = (persistence.appendConversationTurn as ReturnType<typeof vi.fn>).mock.calls[0];
        const persistedTurn = appendTurnCall?.[1] as { userContent?: ContentPart[] } | undefined;
        const imagePart = persistedTurn?.userContent?.[0];
        expect(imagePart?.type).toBe("image");
        if (imagePart?.type === "image" && imagePart.source.type === "url") {
          expect(imagePart.source.url).toMatch(
            /^uploads\/\d{4}\/\d{2}\/\d{2}\/sess-data-url\/[0-9a-f-]+\.png$/,
          );
        }
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("sends local public image URLs to the LLM as data URLs while persisting public URLs", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-kit-agent-local-public-"));
      const capturedInputs: Array<string | ContentPart[]> = [];
      function captureAgent(ctx: AgentContext): ConversationalAgent {
        const client: LLMClient = {
          model: "test-model",
          provider: "openai",
          capabilities: defaultCapabilities,
          async invoke() {
            throw new Error("invoke should not be called");
          },
          async *stream(input) {
            let userMessage = input.messages[0];
            for (let index = input.messages.length - 1; index >= 0; index -= 1) {
              if (input.messages[index]?.role === "user") {
                userMessage = input.messages[index];
                break;
              }
            }
            capturedInputs.push(userMessage?.content ?? "");
            yield {
              type: "response.completed",
              result: makeResult("converted for llm"),
            };
          },
          estimateTokens: () => 10,
        };
        return new ConversationalAgent({
          context: ctx,
          client,
          instructions: "Capture agent",
        });
      }

      const registry = new AgentRegistry({
        agents: [{ create: captureAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = {
        registry,
        persistence,
        publicAssetsDir: path.join(tempDir, "public"),
        publicAssetsBasePath: "/api/mcp/test/public",
      };
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Nm7cAAAAASUVORK5CYII=";
      const relativePath = "uploads/2026/03/04/sess-public/local.png";
      await fs.mkdir(path.join(tempDir, "public", "uploads/2026/03/04/sess-public"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "public", relativePath), Buffer.from(pngBase64, "base64"));
      const publicUrl = `/api/mcp/test/public/${relativePath}`;
      const input: ContentPart[] = [
        {
          type: "image",
          source: {
            type: "url",
            url: publicUrl,
          },
        },
        { type: "text", text: "llmへはdata url" },
      ];

      try {
        await handleAgentRun(deps, { agentId: "test", input, sessionId: "sess-public" });

        const llmInput = capturedInputs[0];
        expect(Array.isArray(llmInput)).toBe(true);
        if (Array.isArray(llmInput) && llmInput[0]?.type === "image" && llmInput[0].source.type === "url") {
          expect(llmInput[0].source.url).toContain("data:image/png;base64,");
        }

        const appendTurnCall = (persistence.appendConversationTurn as ReturnType<typeof vi.fn>).mock.calls[0];
        const persistedTurn = appendTurnCall?.[1] as { userContent?: ContentPart[] } | undefined;
        expect(persistedTurn?.userContent?.[0]).toEqual({
          type: "image",
          source: { type: "url", url: publicUrl },
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects base64 image payloads larger than the per-turn limit", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-kit-agent-limit-"));
      const registry = new AgentRegistry({
        agents: [{ create: createTestAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = {
        registry,
        persistence,
        publicAssetsDir: path.join(tempDir, "public"),
        publicAssetsBasePath: "/api/mcp/test/public",
      };
      const oversizedData = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");

      try {
        await expect(
          handleAgentRun(deps, {
            agentId: "test",
            input: [
              {
                type: "image",
                source: {
                  type: "base64",
                  mediaType: "image/png",
                  data: oversizedData,
                },
              },
            ],
          }),
        ).rejects.toThrow(/exceeds/);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects mismatched image media type and binary content", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-kit-agent-mime-"));
      const registry = new AgentRegistry({
        agents: [{ create: createTestAgent, agentId: "test" }],
      });
      const persistence = stubPersistence();
      const deps: AgentToolDeps = {
        registry,
        persistence,
        publicAssetsDir: path.join(tempDir, "public"),
        publicAssetsBasePath: "/api/mcp/test/public",
      };
      const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");

      try {
        await expect(
          handleAgentRun(deps, {
            agentId: "test",
            input: [
              {
                type: "image",
                source: {
                  type: "base64",
                  mediaType: "image/png",
                  data: jpegData,
                },
              },
            ],
          }),
        ).rejects.toThrow(/does not match binary content/);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
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

    it("persists streaming timeline so conversations.get can return it", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-kit-agent-timeline-"));
      function streamingAgent(ctx: AgentContext): ConversationalAgent {
        const client: LLMClient = {
          model: "test-model",
          provider: "openai",
          capabilities: defaultCapabilities,
          async invoke() {
            throw new Error("invoke should not be called");
          },
          async *stream() {
            yield { type: "reasoning.delta", delta: "Thinking" };
            yield { type: "tool_call.arguments.delta", toolCallId: "tool-1", name: "read_file", delta: "{\"path\":\"" };
            yield { type: "tool_call.arguments.done", toolCallId: "tool-1", name: "read_file", arguments: { path: "README.md" } };
            yield { type: "text.delta", delta: "Done." };
            yield { type: "response.completed", result: makeResult("Done.") };
          },
          estimateTokens: () => 10,
        };
        return new ConversationalAgent({
          context: ctx,
          client,
          instructions: "Streaming agent",
        });
      }

      try {
        const registry = new AgentRegistry({
          agents: [{ create: streamingAgent, agentId: "test" }],
        });
        const persistence = new JsonlMcpPersistence(new FileSystemStorage(tempDir));
        const deps: AgentToolDeps = {
          registry,
          persistence,
          sendNotification: vi.fn(async () => {}),
        };

        const runResult = await handleAgentRun(deps, {
          message: "Hello",
          agentId: "test",
          sessionId: "sess-timeline",
          stream: true,
        });
        const runPayload = JSON.parse(runResult.content[0].text);

        const conversation = await handleConversationsGet(persistence, {
          sessionId: "sess-timeline",
        });
        const payload = JSON.parse(conversation.content[0].text);

        expect(runPayload.status).toBe("success");
        expect(payload.turns).toHaveLength(1);
        expect(payload.turns[0].timeline).toEqual([
          {
            kind: "reasoning",
            id: "reasoning-1",
            text: "Thinking",
            status: "completed",
          },
          {
            kind: "tool-call",
            id: "tool-1",
            summary: "read_file",
            status: "completed",
            argumentLines: ["{", "  \"path\": \"README.md\"", "}"],
          },
          expect.objectContaining({
            kind: "text",
            text: "Done.",
            completedAt: expect.any(Number),
            durationSeconds: expect.any(Number),
          }),
        ]);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
