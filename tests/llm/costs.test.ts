import { describe, expect, it } from "vitest";
import {
  billUsageForCurrentSession,
  createUsageCostSessionRunner,
  withComputedUsageCost,
} from "../../src/llm/costs.js";
import type { LLMUsage } from "../../src/types/llm.js";

function makeUsage(overrides: Partial<LLMUsage> = {}): LLMUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
    ...overrides,
  };
}

describe("withComputedUsageCost", () => {
  it("computes OpenAI cost using cached and uncached token rates", () => {
    const usage = withComputedUsageCost("openai", "gpt-5.4", makeUsage({
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      outputTokens: 200_000,
      totalTokens: 1_200_000,
    }));

    expect(usage.inputCost).toBeCloseTo(4.5);
    expect(usage.cacheCost).toBeCloseTo(0.025);
    expect(usage.outputCost).toBeCloseTo(4.5);
    expect(usage.totalCost).toBeCloseTo(9.025);
  });

  it("keeps standard pricing for GPT-5.4 at or below the 272K threshold", () => {
    const usage = withComputedUsageCost("openai", "gpt-5.4", makeUsage({
      inputTokens: 272_000,
      cachedInputTokens: 72_000,
      outputTokens: 100_000,
      totalTokens: 372_000,
    }));

    expect(usage.inputCost).toBeCloseTo(0.5);
    expect(usage.cacheCost).toBeCloseTo(0.018);
    expect(usage.outputCost).toBeCloseTo(1.5);
    expect(usage.totalCost).toBeCloseTo(2.018);
  });

  it("applies the long-context uplift to GPT-5.4 snapshots too", () => {
    const usage = withComputedUsageCost("openai", "gpt-5.4-2026-03-05", makeUsage({
      inputTokens: 300_000,
      cachedInputTokens: 100_000,
      outputTokens: 100_000,
      totalTokens: 400_000,
    }));

    expect(usage.inputCost).toBeCloseTo(1);
    expect(usage.cacheCost).toBeCloseTo(0.025);
    expect(usage.outputCost).toBeCloseTo(2.25);
    expect(usage.totalCost).toBeCloseTo(3.275);
  });

  it("computes Anthropic cache-read cost when the model is known", () => {
    const usage = withComputedUsageCost("anthropic", "claude-sonnet-4-20250514", makeUsage({
      inputTokens: 1_000_000,
      cachedInputTokens: 250_000,
      outputTokens: 100_000,
      totalTokens: 1_100_000,
    }));

    expect(usage.inputCost).toBeCloseTo(2.25);
    expect(usage.cacheCost).toBeCloseTo(0.075);
    expect(usage.outputCost).toBeCloseTo(1.5);
    expect(usage.totalCost).toBeCloseTo(3.825);
  });

  it("leaves cost at zero when the model is not in the registry", () => {
    const usage = withComputedUsageCost("openai", "unknown-model", makeUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    }));

    expect(usage.inputCost).toBe(0);
    expect(usage.outputCost).toBe(0);
    expect(usage.cacheCost).toBe(0);
    expect(usage.totalCost).toBe(0);
  });

  it("returns per-generation billed deltas inside a session", () => {
    const session = createUsageCostSessionRunner();

    const first = session.run(() =>
      billUsageForCurrentSession("openai", "gpt-5.4", makeUsage({
        inputTokens: 200_000,
        outputTokens: 100_000,
        totalTokens: 300_000,
      })),
    );
    const second = session.run(() =>
      billUsageForCurrentSession("openai", "gpt-5.4", makeUsage({
        inputTokens: 200_000,
        outputTokens: 100_000,
        totalTokens: 300_000,
      })),
    );

    expect(first.totalCost).toBeCloseTo(2);
    expect(second.inputCost).toBeCloseTo(1.5);
    expect(second.outputCost).toBeCloseTo(3);
    expect(second.totalCost).toBeCloseTo(4.5);
  });
});
