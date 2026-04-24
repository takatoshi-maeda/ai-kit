import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { ConversationalAgent } from "../../src/agent/conversational.js";
import type { AgentContext, LLMClient } from "../../src/types/agent.js";
import type { LLMResult, LLMUsage } from "../../src/types/llm.js";
import type { LLMStreamEvent } from "../../src/types/stream-events.js";
import type { ModelCapabilities } from "../../src/types/model.js";
import { createFakeSupabaseClient } from "../helpers/fake-supabase.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=";

const defaultCapabilities: ModelCapabilities = {
  supportsReasoning: false,
  supportsToolCalls: true,
  supportsStreaming: true,
  supportsImages: true,
  contextWindowSize: 128000,
};

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("@supabase/supabase-js");
});

describe("mountMcpRoutes backend contract", () => {
  it("returns matching core HTTP payloads for filesystem and supabase backends", async () => {
    const filesystem = await exerciseBackend("filesystem");
    const supabase = await exerciseBackend("supabase");

    expect(supabase).toEqual(filesystem);
  });
});

async function exerciseBackend(kind: "filesystem" | "supabase") {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-17T00:00:00.000Z"));

  const app = new Hono();
  const baseUrl = "http://app.test";
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `ai-kit-${kind}-`));
  const fakeSupabaseClient = createFakeSupabaseClient();

  vi.doMock("@supabase/supabase-js", () => ({
    createClient: vi.fn(() => fakeSupabaseClient),
  }));

  const { mountMcpRoutes } = await import("../../src/hono/index.js");

  await mountMcpRoutes(app, {
    agentDefinitions: [
      {
        name: "alpha",
        description: "Alpha agent",
        create: createTestAgent,
      },
    ],
    persistence: kind === "filesystem"
      ? {
        kind: "filesystem",
        dataDir: tmpDir,
      }
      : {
        kind: "supabase",
        url: "https://example.supabase.co",
        serviceRoleKey: "service-role-key",
        bucket: "ai-kit",
        signedUrlExpiresInSeconds: 45,
      },
  });

  vi.setSystemTime(new Date("2026-03-17T00:00:00.000Z"));
  const firstRun = await callTool(app, baseUrl, "alpha", "agent.run", {
    sessionId: "session-idem",
    agentId: "alpha",
    message: "hello",
    title: "Greeting",
    idempotencyKey: "idem-1",
  });

  vi.setSystemTime(new Date("2026-03-17T00:00:05.000Z"));
  const repeatedRun = await callTool(app, baseUrl, "alpha", "agent.run", {
    sessionId: "session-idem",
    agentId: "alpha",
    message: "hello",
    title: "Greeting",
    idempotencyKey: "idem-1",
  });

  vi.setSystemTime(new Date("2026-03-17T00:01:00.000Z"));
  await callTool(app, baseUrl, "alpha", "agent.run", {
    sessionId: "session-image",
    agentId: "alpha",
    title: "Image conversation",
    input: [
      { type: "text", text: "look at this" },
      {
        type: "image",
        source: {
          type: "base64",
          mediaType: "image/png",
          data: ONE_PIXEL_PNG_BASE64,
        },
      },
    ],
  });

  vi.setSystemTime(new Date("2026-03-17T00:01:30.000Z"));
  const list = await callTool(app, baseUrl, "alpha", "conversations.list", {});
  const get = await callTool(app, baseUrl, "alpha", "conversations.get", {
    sessionId: "session-image",
    agentId: "alpha",
  });
  const fork = await callTool(app, baseUrl, "alpha", "conversations.fork", {
    sessionId: "session-image",
    agentId: "alpha",
    checkpointTurnIndex: 0,
  });
  const usage = await callTool(app, baseUrl, "alpha", "usage.summary", {});
  const health = await callTool(app, baseUrl, "alpha", "health.check", {});

  const statusResponse = await app.request(`${baseUrl}/api/mcp/alpha/status`);
  expect(statusResponse.status).toBe(200);
  const status = await statusResponse.json() as Record<string, unknown>;

  expect(repeatedRun).toEqual(firstRun);

  const conversationPayload = get.structuredContent as {
    turns: Array<{
      userContent: Array<{
        type: string;
        source?: { type?: string; url?: string };
      }> | null;
      userMessage: string;
    }>;
  };
  const latestTurn = conversationPayload.turns.at(-1);
  const imagePart = Array.isArray(latestTurn?.userContent)
    ? latestTurn.userContent.find((part) => part.type === "image")
    : null;

  expect(imagePart?.source?.url?.startsWith(`${baseUrl}/api/mcp/alpha/public/`)).toBe(true);
  expect(latestTurn?.userMessage).toContain("[image:url:");
  expect((health.structuredContent as { dependencies: { storage: { ok: boolean } } }).dependencies.storage.ok)
    .toBe(true);
  expect(status).toMatchObject({
    ok: true,
    state: "ready",
    pid: null,
  });

  return normalizeForComparison({
    firstRun,
    repeatedRun,
    list,
    get,
    fork,
    usage,
    health,
    status,
  });
}

function createTestAgent(ctx: AgentContext): ConversationalAgent {
  return new ConversationalAgent({
    context: ctx,
    client: mockClient("Test response"),
    instructions: "Test agent",
  });
}

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

function makeStreamEvents(result: LLMResult): LLMStreamEvent[] {
  return [
    { type: "response.created", responseId: result.responseId ?? "resp-1" },
    { type: "text.delta", delta: result.content },
    { type: "text.done", text: result.content },
    { type: "response.completed", result },
  ];
}

async function callTool(
  app: Hono,
  baseUrl: string,
  appName: string,
  toolName: string,
  body: Record<string, unknown>,
): Promise<{
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const payload = toolName === "agent.run"
    ? {
      jsonrpc: "2.0",
      id: `${toolName}-1`,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: body,
      },
    }
    : body;
  const response = await app.request(`${baseUrl}/api/mcp/${appName}/tools/call/${toolName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  expect(response.status).toBe(200);
  const envelope = await parseToolEnvelope(response) as {
    result?: {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
  };

  expect(envelope.result).toBeDefined();
  expect(envelope.result?.content?.[0]?.type).toBe("text");
  expect(JSON.parse(envelope.result?.content?.[0]?.text ?? "null")).toEqual(
    envelope.result?.structuredContent,
  );

  return {
    structuredContent: envelope.result?.structuredContent ?? {},
    isError: envelope.result?.isError === true,
  };
}

async function parseToolEnvelope(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const body = await response.text();
  const match = body.match(/^data:\s*(.+)$/m);
  if (!match) {
    throw new Error(`Missing SSE payload: ${body}`);
  }
  return JSON.parse(match[1]);
}

function normalizeForComparison(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        "<uuid>",
      )
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")
      .replace(/storage\+(?:file|supabase):\/\/[^\s\]]+/g, "<asset-ref>")
      .replace(/https?:\/\/[^ \]]+\/api\/mcp\/[^ \]]+\/public\/(?:uploads\/[^ \]]+|ref\/[^ \]]+)/g, "<public-asset-url>")
      .replace(/"driver":"(?:filesystem|supabase)"/g, "\"driver\":\"<driver>\"");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForComparison(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (key === "driver" && (entry === "filesystem" || entry === "supabase")) {
          return [key, "<driver>"];
        }
        return [key, normalizeForComparison(entry)];
      }),
    );
  }

  return value;
}
