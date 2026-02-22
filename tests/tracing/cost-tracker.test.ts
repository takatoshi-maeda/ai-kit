import { describe, it, expect, beforeEach } from "vitest";
import { CostTracker, UsageRecorder } from "../../src/tracing/cost-tracker.js";
import type { LLMUsage } from "../../src/types/llm.js";

function makeUsage(overrides: Partial<LLMUsage> = {}): LLMUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    totalTokens: 150,
    inputCost: 0.01,
    outputCost: 0.02,
    cacheCost: 0,
    totalCost: 0.03,
    ...overrides,
  };
}

describe("UsageRecorder", () => {
  let recorder: UsageRecorder;

  beforeEach(() => {
    recorder = new UsageRecorder();
  });

  it("starts with zero summary", () => {
    const s = recorder.summary;
    expect(s.totalTokens).toBe(0);
    expect(s.totalCost).toBe(0);
    expect(s.byModel.size).toBe(0);
  });

  it("records usage for a single model", () => {
    recorder.record("gpt-4o", makeUsage());
    const s = recorder.summary;
    expect(s.totalTokens).toBe(150);
    expect(s.totalCost).toBeCloseTo(0.03);
    expect(s.byModel.get("gpt-4o")!.inputTokens).toBe(100);
  });

  it("accumulates usage across multiple records for same model", () => {
    recorder.record("gpt-4o", makeUsage());
    recorder.record("gpt-4o", makeUsage({ inputTokens: 200, totalTokens: 250, totalCost: 0.05 }));
    const s = recorder.summary;
    expect(s.byModel.get("gpt-4o")!.inputTokens).toBe(300);
    expect(s.byModel.get("gpt-4o")!.totalTokens).toBe(400);
  });

  it("tracks multiple models separately", () => {
    recorder.record("gpt-4o", makeUsage({ totalTokens: 100, totalCost: 0.01 }));
    recorder.record("claude", makeUsage({ totalTokens: 200, totalCost: 0.05 }));
    const s = recorder.summary;
    expect(s.byModel.size).toBe(2);
    expect(s.totalTokens).toBe(300);
    expect(s.totalCost).toBeCloseTo(0.06);
  });

  it("reset clears all data", () => {
    recorder.record("gpt-4o", makeUsage());
    recorder.reset();
    const s = recorder.summary;
    expect(s.totalTokens).toBe(0);
    expect(s.byModel.size).toBe(0);
  });

  it("summary returns a copy of byModel map", () => {
    recorder.record("gpt-4o", makeUsage());
    const s1 = recorder.summary;
    recorder.record("gpt-4o", makeUsage());
    const s2 = recorder.summary;
    // s1 should not be affected by subsequent records
    expect(s1.totalTokens).toBe(150);
    expect(s2.totalTokens).toBe(300);
  });
});

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  it("ignores records when not started", () => {
    tracker.record("gpt-4o", makeUsage());
    expect(tracker.summary.totalTokens).toBe(0);
  });

  it("records usage after start", () => {
    tracker.start();
    tracker.record("gpt-4o", makeUsage());
    expect(tracker.summary.totalTokens).toBe(150);
  });

  it("stop returns summary and stops recording", () => {
    tracker.start();
    tracker.record("gpt-4o", makeUsage({ totalTokens: 100, totalCost: 0.01 }));
    const result = tracker.stop();
    expect(result.totalTokens).toBe(100);

    // Further records should be ignored
    tracker.record("gpt-4o", makeUsage({ totalTokens: 200, totalCost: 0.02 }));
    expect(tracker.summary.totalTokens).toBe(100);
  });

  it("start resets previous data", () => {
    tracker.start();
    tracker.record("gpt-4o", makeUsage({ totalTokens: 100, totalCost: 0.01 }));
    tracker.start();
    expect(tracker.summary.totalTokens).toBe(0);
  });

  it("supports Symbol.dispose", () => {
    tracker.start();
    tracker.record("gpt-4o", makeUsage());
    tracker[Symbol.dispose]();

    // After dispose, records should be ignored
    tracker.record("gpt-4o", makeUsage());
    expect(tracker.summary.totalTokens).toBe(150); // only the first record
  });

  it("tracks multiple models", () => {
    tracker.start();
    tracker.record("gpt-4o", makeUsage({ totalTokens: 100, totalCost: 0.01 }));
    tracker.record("claude", makeUsage({ totalTokens: 200, totalCost: 0.05 }));
    const s = tracker.summary;
    expect(s.byModel.size).toBe(2);
    expect(s.totalTokens).toBe(300);
    expect(s.totalCost).toBeCloseTo(0.06);
  });

  it("accumulates cache costs correctly", () => {
    tracker.start();
    tracker.record(
      "claude",
      makeUsage({
        cachedInputTokens: 500,
        cacheCost: 0.005,
        totalCost: 0.035,
      }),
    );
    const s = tracker.summary;
    expect(s.byModel.get("claude")!.cachedInputTokens).toBe(500);
    expect(s.byModel.get("claude")!.cacheCost).toBeCloseTo(0.005);
  });
});
