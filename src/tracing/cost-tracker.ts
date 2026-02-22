import type { LLMUsage } from "../types/llm.js";

export interface UsageSummary {
  totalTokens: number;
  totalCost: number;
  byModel: Map<string, LLMUsage>;
}

function emptyUsage(): LLMUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
  };
}

function addUsage(target: LLMUsage, source: LLMUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.totalTokens += source.totalTokens;
  target.inputCost += source.inputCost;
  target.outputCost += source.outputCost;
  target.cacheCost += source.cacheCost;
  target.totalCost += source.totalCost;
}

function buildSummary(byModel: Map<string, LLMUsage>): UsageSummary {
  let totalTokens = 0;
  let totalCost = 0;
  for (const u of byModel.values()) {
    totalTokens += u.totalTokens;
    totalCost += u.totalCost;
  }
  return { totalTokens, totalCost, byModel };
}

/** 使用量の累積レコーダー */
export class UsageRecorder {
  private readonly byModel = new Map<string, LLMUsage>();

  record(model: string, usage: LLMUsage): void {
    let entry = this.byModel.get(model);
    if (!entry) {
      entry = emptyUsage();
      this.byModel.set(model, entry);
    }
    addUsage(entry, usage);
  }

  get summary(): UsageSummary {
    return buildSummary(new Map(this.byModel));
  }

  reset(): void {
    this.byModel.clear();
  }
}

/**
 * スコープ付きコスト追跡。
 * using 構文、または明示的な start/stop で使用。
 */
export class CostTracker {
  private recorder = new UsageRecorder();
  private active = false;

  start(): void {
    this.recorder.reset();
    this.active = true;
  }

  stop(): UsageSummary {
    this.active = false;
    return this.recorder.summary;
  }

  record(model: string, usage: LLMUsage): void {
    if (this.active) {
      this.recorder.record(model, usage);
    }
  }

  get summary(): UsageSummary {
    return this.recorder.summary;
  }

  [Symbol.dispose](): void {
    this.active = false;
  }
}
