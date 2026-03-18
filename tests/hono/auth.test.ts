import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

describe("mountMcpRoutes auth", () => {
  it("rejects unauthenticated tool calls when auth0 is enabled", async () => {
    vi.resetModules();
    vi.doMock("jose", () => ({
      createRemoteJWKSet: vi.fn(() => Symbol("jwks")),
      jwtVerify: vi.fn(),
    }));

    const { mountMcpRoutes } = await import("../../src/hono/index.js");
    const app = new Hono();
    await mountMcpRoutes(app, {
      agentDefinitions: [
        {
          name: "alpha",
          create: () => null as never,
        },
      ],
      auth: {
        kind: "auth0",
        issuerBaseUrl: "https://example.auth0.com/",
        audience: "https://api.example.com",
      },
    });

    const response = await app.request("/api/mcp/alpha/tools/call/health.check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");

    vi.doUnmock("jose");
  });

  it("stores conversations under the authenticated user scope", async () => {
    const jwtVerify = vi.fn(async () => ({
      payload: {
        sub: "auth0|user-123",
      },
    }));

    vi.resetModules();
    vi.doMock("jose", () => ({
      createRemoteJWKSet: vi.fn(() => Symbol("jwks")),
      jwtVerify,
    }));

    const { mountMcpRoutes } = await import("../../src/hono/index.js");
    const { ConversationalAgent } = await import("../../src/agent/conversational.js");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-hono-auth-"));
    const app = new Hono();
    await mountMcpRoutes(app, {
      agentDefinitions: [
        {
          name: "alpha",
          create: (context) =>
            new ConversationalAgent({
              context,
              instructions: "test",
              client: {
                model: "test-model",
                provider: "openai",
                capabilities: {
                  supportsReasoning: false,
                  supportsToolCalls: true,
                  supportsStreaming: true,
                  supportsImages: false,
                  contextWindowSize: 128000,
                },
                async invoke() {
                  return {
                    type: "message" as const,
                    content: "ok",
                    toolCalls: [],
                    usage: {
                      inputTokens: 1,
                      outputTokens: 1,
                      cachedInputTokens: 0,
                      totalTokens: 2,
                      inputCost: 0,
                      outputCost: 0,
                      cacheCost: 0,
                      totalCost: 0,
                    },
                    responseId: "resp-1",
                    finishReason: "stop" as const,
                  };
                },
                async *stream() {
                  yield {
                    type: "response.completed" as const,
                    result: {
                      type: "message" as const,
                      content: "ok",
                      toolCalls: [],
                      usage: {
                        inputTokens: 1,
                        outputTokens: 1,
                        cachedInputTokens: 0,
                        totalTokens: 2,
                        inputCost: 0,
                        outputCost: 0,
                        cacheCost: 0,
                        totalCost: 0,
                      },
                      responseId: "resp-1",
                      finishReason: "stop" as const,
                    },
                  };
                },
                estimateTokens() {
                  return 1;
                },
              },
            }),
        },
      ],
      auth: {
        kind: "auth0",
        issuerBaseUrl: "https://example.auth0.com/",
        audience: "https://api.example.com",
      },
      persistence: {
        kind: "filesystem",
        dataDir,
      },
    });

    const response = await app.request("/api/mcp/alpha/tools/call/agent.run", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "hello",
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    const conversationsDir = path.join(
      dataDir,
      "alpha",
      "users",
      encodeURIComponent("auth0|user-123"),
      "conversations",
      "alpha",
    );
    const files = await readdir(conversationsDir);
    expect(files).toHaveLength(1);
    const stored = await readFile(path.join(conversationsDir, files[0]), "utf8");
    expect(stored).toContain("ok");
    expect(jwtVerify).toHaveBeenCalledTimes(1);

    vi.doUnmock("jose");
  });
});
