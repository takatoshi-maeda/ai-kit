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
    forkConversation: vi.fn(async () => ({ sessionId: "forked-session", copiedTurnCount: 0 })),
    appendConversationTurn: vi.fn(async () => {}),
    appendSessionState: vi.fn(async () => {}),
    appendRunState: vi.fn(async () => {}),
    deleteRunState: vi.fn(async () => {}),
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
      periods: {
        cumulative: {
          period: "all",
          cost: { totalUsd: 1.23, totalByCurrency: { usd: 1.23 } },
        },
        monthly: {
          period: "2026-04",
          cost: { totalUsd: 1, totalByCurrency: { usd: 1 } },
        },
        weekly: {
          period: "2026-W16",
          cost: { totalUsd: 0.8, totalByCurrency: { usd: 0.8 } },
        },
        daily: {
          period: "2026-04-17",
          cost: { totalUsd: 0.2, totalByCurrency: { usd: 0.2 } },
        },
      },
    }));

    const result = await handleUsageSummary(persistence, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.period).toBe("all");
    expect(parsed.cost.totalUsd).toBe(1.23);
    expect(parsed.cost.totalByCurrency).toEqual({ usd: 1.23 });
    expect(parsed.periods.monthly.period).toBe("2026-04");
    expect(parsed.periods.weekly.period).toBe("2026-W16");
    expect(parsed.periods.daily.period).toBe("2026-04-17");
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
    expect(parsed.periods.cumulative.cost.totalUsd).toBe(0);
    expect(result.isError).toBe(false);
  });
});
