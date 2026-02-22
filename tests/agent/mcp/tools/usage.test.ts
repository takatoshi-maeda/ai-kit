import { describe, it, expect, vi } from "vitest";
import { handleUsageSummary } from "../../../../src/agent/mcp/tools/usage.js";
import type { McpPersistence } from "../../../../src/agent/mcp/persistence.js";

function stubPersistence(
  summarizeUsage: McpPersistence["summarizeUsage"],
): McpPersistence {
  return {
    readConversation: vi.fn(async () => null),
    listConversationSummaries: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => false),
    appendConversationTurn: vi.fn(async () => {}),
    appendRunState: vi.fn(async () => {}),
    appendInputMessageHistory: vi.fn(async () => {}),
    listInputMessageHistory: vi.fn(async () => []),
    appendUsage: vi.fn(async () => {}),
    summarizeUsage: vi.fn(summarizeUsage),
    readIdempotencyRecord: vi.fn(async () => null),
    writeIdempotencyRecord: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => ({ ok: true })),
  };
}

describe("usage tools", () => {
  it("returns snake_case usage payload", async () => {
    const persistence = stubPersistence(async () => ({
      period: "all",
      cost: { totalUsd: 1.23, totalByCurrency: { usd: 1.23 } },
    }));

    const result = await handleUsageSummary(persistence, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.period).toBe("all");
    expect(parsed.cost.totalUsd).toBe(1.23);
    expect(parsed.cost.totalByCurrency).toEqual({ usd: 1.23 });
    expect(parsed.tokens).toBeNull();
    expect(parsed.requests).toBeNull();
    expect(result.structuredContent).toEqual(parsed);
    expect(result.isError).toBe(false);
  });

  it("returns zero payload when usage is missing", async () => {
    const persistence = stubPersistence(async () => null);

    const result = await handleUsageSummary(persistence, { period: "2026-02" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.period).toBe("2026-02");
    expect(parsed.cost.totalUsd).toBe(0);
    expect(parsed.cost.totalByCurrency).toEqual({});
    expect(result.isError).toBe(false);
  });
});
