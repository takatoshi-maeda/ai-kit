import { AsyncLocalStorage } from "node:async_hooks";
import { ModelRegistry } from "../model-registry/index.js";
import type { LLMProvider } from "./client.js";
import type { LLMUsage } from "../types/llm.js";

type UsageCostSessionState = {
  cumulativeUsageByModel: Map<string, LLMUsage>;
};

const usageCostSessionStorage = new AsyncLocalStorage<UsageCostSessionState>();

export type SerializedUsageCostSessionState = {
  cumulativeUsageByModel: Record<string, LLMUsage>;
};

export type UsageCostSessionRunner = {
  run<T>(fn: () => T): T;
  serialize(): SerializedUsageCostSessionState;
};

export function createUsageCostSessionRunner(
  initialState?: SerializedUsageCostSessionState,
): UsageCostSessionRunner {
  const state = deserializeUsageCostSessionState(initialState);
  return {
    run<T>(fn: () => T): T {
      return usageCostSessionStorage.run(state, fn);
    },
    serialize(): SerializedUsageCostSessionState {
      return serializeUsageCostSessionState(state);
    },
  };
}

export function withComputedUsageCost(
  provider: LLMProvider,
  model: string,
  usage: LLMUsage,
): LLMUsage {
  const normalizedModel = normalizeModelId(model);
  const pricing = ModelRegistry.default.getCost(provider, model)
    ?? ModelRegistry.default.getCost(provider, normalizedModel);
  if (!pricing) {
    return usage;
  }

  const cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const nonCachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  const multiplier = getSessionPriceMultiplier(provider, model, usage);

  const inputCost = tokensToUsd(nonCachedInputTokens, pricing.input * multiplier.input);
  const cacheCost = pricing.cacheRead !== undefined
    ? tokensToUsd(cachedInputTokens, pricing.cacheRead)
    : 0;
  const outputCost = tokensToUsd(usage.outputTokens, pricing.output * multiplier.output);

  return {
    ...usage,
    inputCost,
    outputCost,
    cacheCost,
    totalCost: inputCost + cacheCost + outputCost,
  };
}

export function billUsageForCurrentSession(
  provider: LLMProvider,
  model: string,
  usage: LLMUsage,
): LLMUsage {
  const session = usageCostSessionStorage.getStore();
  if (!session) {
    return withComputedUsageCost(provider, model, usage);
  }

  const modelKey = `${provider}:${normalizeModelId(model)}`;
  const previousCumulative = session.cumulativeUsageByModel.get(modelKey) ?? emptyUsage();
  const nextCumulative = cloneUsage(previousCumulative);
  addUsage(nextCumulative, usage);

  const billedPrevious = withComputedUsageCost(provider, model, previousCumulative);
  const billedNext = withComputedUsageCost(provider, model, nextCumulative);

  session.cumulativeUsageByModel.set(modelKey, nextCumulative);

  return {
    ...usage,
    inputCost: billedNext.inputCost - billedPrevious.inputCost,
    outputCost: billedNext.outputCost - billedPrevious.outputCost,
    cacheCost: billedNext.cacheCost - billedPrevious.cacheCost,
    totalCost: billedNext.totalCost - billedPrevious.totalCost,
  };
}

export function serializeUsageCostSessionState(
  state: UsageCostSessionState,
): SerializedUsageCostSessionState {
  return {
    cumulativeUsageByModel: Object.fromEntries(
      Array.from(state.cumulativeUsageByModel.entries()).map(([key, usage]) => [
        key,
        cloneUsage(usage),
      ]),
    ),
  };
}

export function deserializeUsageCostSessionState(
  value?: SerializedUsageCostSessionState,
): UsageCostSessionState {
  const entries = Object.entries(value?.cumulativeUsageByModel ?? {})
    .filter(([, usage]) => isLLMUsageRecord(usage))
    .map(([key, usage]) => [key, cloneUsage(usage)] as const);
  return {
    cumulativeUsageByModel: new Map(entries),
  };
}

export function appendUsageToSerializedUsageCostSessionState(
  state: SerializedUsageCostSessionState | undefined,
  provider: LLMProvider,
  model: string,
  usage: LLMUsage,
): SerializedUsageCostSessionState {
  const deserialized = deserializeUsageCostSessionState(state);
  const modelKey = `${provider}:${normalizeModelId(model)}`;
  const nextCumulative = cloneUsage(
    deserialized.cumulativeUsageByModel.get(modelKey) ?? emptyUsage(),
  );
  addUsage(nextCumulative, usage);
  deserialized.cumulativeUsageByModel.set(
    modelKey,
    withComputedUsageCost(provider, model, nextCumulative),
  );
  return serializeUsageCostSessionState(deserialized);
}

export function computeBilledUsageDeltaFromSessionState(
  state: SerializedUsageCostSessionState | undefined,
  provider: LLMProvider,
  model: string,
  usage: LLMUsage,
): LLMUsage {
  const baseline = getUsageFromSerializedUsageCostSessionState(state, provider, model);
  const nextState = appendUsageToSerializedUsageCostSessionState(
    state,
    provider,
    model,
    usage,
  );
  const billedTotal = getUsageFromSerializedUsageCostSessionState(
    nextState,
    provider,
    model,
  );
  return {
    ...usage,
    inputCost: billedTotal.inputCost - baseline.inputCost,
    outputCost: billedTotal.outputCost - baseline.outputCost,
    cacheCost: billedTotal.cacheCost - baseline.cacheCost,
    totalCost: billedTotal.totalCost - baseline.totalCost,
  };
}

export function getUsageFromSerializedUsageCostSessionState(
  state: SerializedUsageCostSessionState | undefined,
  provider: LLMProvider,
  model: string,
): LLMUsage {
  const key = `${provider}:${normalizeModelId(model)}`;
  const usage = state?.cumulativeUsageByModel[key];
  return usage && isLLMUsageRecord(usage) ? cloneUsage(usage) : emptyUsage();
}

function tokensToUsd(tokens: number, pricePer1MTokensUsd: number): number {
  return (tokens / 1_000_000) * pricePer1MTokensUsd;
}

function getSessionPriceMultiplier(
  provider: LLMProvider,
  model: string,
  usage: LLMUsage,
): { input: number; output: number } {
  if (provider === "openai" && isGpt54LongContextSession(model, usage.inputTokens)) {
    return { input: 2, output: 1.5 };
  }
  return { input: 1, output: 1 };
}

function isGpt54LongContextSession(model: string, inputTokens: number): boolean {
  return normalizeModelId(model) === "gpt-5.4" && inputTokens > 272_000;
}

function normalizeModelId(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
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

function isLLMUsageRecord(value: unknown): value is LLMUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "totalTokens",
    "inputCost",
    "outputCost",
    "cacheCost",
    "totalCost",
  ].every((key) => typeof record[key] === "number");
}

function cloneUsage(usage: LLMUsage): LLMUsage {
  return { ...usage };
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
