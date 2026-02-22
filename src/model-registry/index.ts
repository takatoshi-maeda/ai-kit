import type { ModelInfo } from "../types/model.js";
import { builtInModels } from "./built-in-models.js";

/**
 * プロバイダ別モデルメタデータのレジストリ。
 * コスト計算・コンテキスト長の問い合わせに使用。
 */
export class ModelRegistry {
  /** 組み込みモデル情報で初期化されたデフォルトインスタンス */
  static readonly default: ModelRegistry = new ModelRegistry(builtInModels);

  private readonly models = new Map<string, ModelInfo>();

  constructor(models?: ModelInfo[]) {
    if (models) {
      for (const m of models) {
        this.registerModel(m);
      }
    }
  }

  private key(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  getModel(provider: string, modelId: string): ModelInfo | undefined {
    return this.models.get(this.key(provider, modelId));
  }

  getModelsByProvider(provider: string): ModelInfo[] {
    const result: ModelInfo[] = [];
    for (const m of this.models.values()) {
      if (m.provider === provider) {
        result.push(m);
      }
    }
    return result;
  }

  registerModel(model: ModelInfo): void {
    this.models.set(this.key(model.provider, model.modelId), model);
  }

  getCost(
    provider: string,
    modelId: string,
  ):
    | {
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
      }
    | undefined {
    const m = this.getModel(provider, modelId);
    if (!m) return undefined;
    return {
      input: m.inputCostPer1MTokens,
      output: m.outputCostPer1MTokens,
      cacheRead: m.cacheReadCostPer1MTokens,
      cacheWrite: m.cacheWriteCostPer1MTokens,
    };
  }

  getContextWindowSize(
    provider: string,
    modelId: string,
  ): number | undefined {
    return this.getModel(provider, modelId)?.contextWindowSize;
  }
}
