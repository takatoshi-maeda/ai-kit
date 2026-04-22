import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountMcpRoutes } from "../../src/hono/index.js";
import { ConversationalAgent } from "../../src/agent/conversational.js";
import type { AgentContext, LLMClient } from "../../src/types/agent.js";
import type { LLMResult, LLMUsage } from "../../src/types/llm.js";
import type { ModelCapabilities } from "../../src/types/model.js";

const defaultCapabilities: ModelCapabilities = {
  supportsReasoning: false,
  supportsToolCalls: true,
  supportsStreaming: true,
  supportsImages: false,
  contextWindowSize: 128000,
};

function makeResult(content: string): LLMResult {
  return {
    type: "message",
    content,
    toolCalls: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      totalTokens: 15,
      inputCost: 0.001,
      outputCost: 0.001,
      cacheCost: 0,
      totalCost: 0.002,
    } satisfies LLMUsage,
    responseId: "resp-1",
    finishReason: "stop",
  };
}

describe("mountMcpRoutes cancellation semantics", () => {
  it("keeps agent.run running after the SSE client disconnects", async () => {
    const app = new Hono();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-sse-cancel-"));
    let enteredWait!: () => void;
    const waitStarted = new Promise<void>((resolve) => {
      enteredWait = resolve;
    });
    let releaseModel!: () => void;
    const modelReleased = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    let aborted = false;

    function createAgent(ctx: AgentContext): ConversationalAgent {
      const client: LLMClient = {
        model: "test-model",
        provider: "openai",
        capabilities: defaultCapabilities,
        async invoke() {
          throw new Error("invoke should not be called");
        },
        async *stream(_input, options) {
          yield { type: "response.created", responseId: "resp-1" as const };
          yield { type: "text.delta", delta: "partial" as const };
          enteredWait();
          await Promise.race([
            modelReleased,
            new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new DOMException("This operation was aborted", "AbortError"));
              }, { once: true });
            }),
          ]);
          yield { type: "text.done", text: "final answer" as const };
          yield {
            type: "response.completed",
            result: makeResult("final answer"),
          };
          resolveCompleted();
        },
        estimateTokens: () => 10,
      };
      return new ConversationalAgent({
        context: ctx,
        client,
        instructions: "Test agent",
      });
    }

    await mountMcpRoutes(app, {
      agentDefinitions: [
        {
          name: "alpha",
          create: createAgent,
        },
      ],
      auth: { kind: "none" },
      persistence: {
        kind: "filesystem",
        dataDir,
      },
    });

    const response = await app.request("/api/mcp/alpha/tools/call/agent.run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "run-1",
        method: "tools/call",
        params: {
          name: "agent.run",
          arguments: {
            sessionId: "sess-sse-disconnect",
            agentId: "alpha",
            message: "hello",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    await waitStarted;
    await reader!.cancel();
    releaseModel();
    await completed;

    expect(aborted).toBe(false);

    let envelope:
      | {
        result?: { structuredContent?: { inProgress?: unknown; turns?: Array<{ status: string; assistantMessage: string }> } };
      }
      | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const conversationResponse = await app.request("/api/mcp/alpha/tools/call/conversations.get", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "sess-sse-disconnect",
          agentId: "alpha",
        }),
      });

      expect(conversationResponse.status).toBe(200);
      envelope = await conversationResponse.json() as typeof envelope;
      const turn = envelope?.result?.structuredContent?.turns?.at(-1);
      if (envelope?.result?.structuredContent?.inProgress == null && turn?.status === "success") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const turn = envelope?.result?.structuredContent?.turns?.at(-1);
    expect(envelope?.result?.structuredContent?.inProgress).toBeNull();
    expect(turn).toMatchObject({
      status: "success",
      assistantMessage: "final answer",
    });
  });
});
