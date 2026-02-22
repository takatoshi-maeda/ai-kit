export interface ModelCapabilities {
  supportsReasoning: boolean;
  supportsToolCalls: boolean;
  supportsStreaming: boolean;
  supportsImages: boolean;
  contextWindowSize: number;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  contextWindowSize: number;
  inputCostPer1MTokens: number;
  outputCostPer1MTokens: number;
  cacheReadCostPer1MTokens?: number;
  cacheWriteCostPer1MTokens?: number;
  capabilities: ModelCapabilities;
}
