import { describe, it, expect, vi } from "vitest";
import { handleHealthCheck } from "../../../../src/agent/mcp/tools/health.js";
import type { McpPersistence } from "../../../../src/agent/mcp/persistence.js";

function stubPersistence(ok: boolean, error?: string): McpPersistence {
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
    checkHealth: vi.fn(async () => ({ ok, error })),
  };
}

describe("health tools", () => {
  it("returns note-compatible health payload", async () => {
    const result = await handleHealthCheck(stubPersistence(true));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.dependencies.storage.driver).toBe("filesystem");
    expect(parsed.dependencies.storage.ok).toBe(true);
    expect(parsed.dependencies.storage.error).toBeNull();
    expect(result.structuredContent).toEqual(parsed);
    expect(result.isError).toBe(false);
  });
});
