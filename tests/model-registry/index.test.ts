import { describe, it, expect, beforeEach } from "vitest";
import { ModelRegistry } from "../../src/model-registry/index.js";
import { builtInModels } from "../../src/model-registry/built-in-models.js";
import type { ModelInfo } from "../../src/types/model.js";

describe("ModelRegistry", () => {
  describe("default instance", () => {
    it("contains built-in models", () => {
      const gpt4o = ModelRegistry.default.getModel("openai", "gpt-4o");
      expect(gpt4o).toBeDefined();
      expect(gpt4o!.displayName).toBe("GPT-4o");
    });

    it("includes models from all providers", () => {
      for (const provider of ["openai", "anthropic", "google", "perplexity"]) {
        const models = ModelRegistry.default.getModelsByProvider(provider);
        expect(models.length).toBeGreaterThan(0);
      }
    });

    it("contains all built-in models", () => {
      for (const m of builtInModels) {
        expect(ModelRegistry.default.getModel(m.provider, m.modelId)).toBeDefined();
      }
    });
  });

  describe("getModel", () => {
    it("returns undefined for unknown model", () => {
      expect(ModelRegistry.default.getModel("openai", "nonexistent")).toBeUndefined();
    });

    it("returns undefined for unknown provider", () => {
      expect(ModelRegistry.default.getModel("unknown", "gpt-4o")).toBeUndefined();
    });

    it("returns model info with correct fields", () => {
      const model = ModelRegistry.default.getModel("anthropic", "claude-sonnet-4-20250514");
      expect(model).toMatchObject({
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        displayName: "Claude Sonnet 4",
        contextWindowSize: 200_000,
        inputCostPer1MTokens: 3,
        outputCostPer1MTokens: 15,
      });
      expect(model!.capabilities.supportsToolCalls).toBe(true);
    });
  });

  describe("getModelsByProvider", () => {
    it("returns empty array for unknown provider", () => {
      expect(ModelRegistry.default.getModelsByProvider("unknown")).toEqual([]);
    });

    it("returns all models for a provider", () => {
      const openaiModels = ModelRegistry.default.getModelsByProvider("openai");
      const openaiBuiltIn = builtInModels.filter((m) => m.provider === "openai");
      expect(openaiModels).toHaveLength(openaiBuiltIn.length);
    });
  });

  describe("registerModel", () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      registry = new ModelRegistry();
    });

    it("adds a new model", () => {
      const custom: ModelInfo = {
        provider: "custom",
        modelId: "my-model",
        displayName: "My Model",
        contextWindowSize: 8_000,
        inputCostPer1MTokens: 1,
        outputCostPer1MTokens: 2,
        capabilities: {
          supportsReasoning: false,
          supportsToolCalls: false,
          supportsStreaming: false,
          supportsImages: false,
          contextWindowSize: 8_000,
        },
      };
      registry.registerModel(custom);
      expect(registry.getModel("custom", "my-model")).toEqual(custom);
    });

    it("overwrites an existing model", () => {
      const v1: ModelInfo = {
        provider: "test",
        modelId: "m1",
        displayName: "v1",
        contextWindowSize: 1000,
        inputCostPer1MTokens: 1,
        outputCostPer1MTokens: 1,
        capabilities: {
          supportsReasoning: false,
          supportsToolCalls: false,
          supportsStreaming: false,
          supportsImages: false,
          contextWindowSize: 1000,
        },
      };
      const v2: ModelInfo = { ...v1, displayName: "v2", inputCostPer1MTokens: 5 };

      registry.registerModel(v1);
      registry.registerModel(v2);
      expect(registry.getModel("test", "m1")!.displayName).toBe("v2");
      expect(registry.getModel("test", "m1")!.inputCostPer1MTokens).toBe(5);
    });
  });

  describe("getCost", () => {
    it("returns cost info for known model", () => {
      const cost = ModelRegistry.default.getCost("openai", "gpt-4o");
      expect(cost).toEqual({
        input: 2.5,
        output: 10,
        cacheRead: 1.25,
        cacheWrite: undefined,
      });
    });

    it("includes cacheWrite for Anthropic models", () => {
      const cost = ModelRegistry.default.getCost("anthropic", "claude-sonnet-4-20250514");
      expect(cost).toBeDefined();
      expect(cost!.cacheWrite).toBe(3.75);
    });

    it("returns undefined for unknown model", () => {
      expect(ModelRegistry.default.getCost("openai", "nonexistent")).toBeUndefined();
    });
  });

  describe("getContextWindowSize", () => {
    it("returns context window size for known model", () => {
      expect(ModelRegistry.default.getContextWindowSize("google", "gemini-2.5-pro")).toBe(1_048_576);
    });

    it("returns undefined for unknown model", () => {
      expect(ModelRegistry.default.getContextWindowSize("openai", "nonexistent")).toBeUndefined();
    });
  });

  describe("constructor with initial models", () => {
    it("creates empty registry when no models given", () => {
      const registry = new ModelRegistry();
      expect(registry.getModelsByProvider("openai")).toEqual([]);
    });

    it("creates registry with provided models", () => {
      const models: ModelInfo[] = [
        {
          provider: "test",
          modelId: "a",
          displayName: "A",
          contextWindowSize: 100,
          inputCostPer1MTokens: 1,
          outputCostPer1MTokens: 2,
          capabilities: {
            supportsReasoning: false,
            supportsToolCalls: false,
            supportsStreaming: false,
            supportsImages: false,
            contextWindowSize: 100,
          },
        },
      ];
      const registry = new ModelRegistry(models);
      expect(registry.getModel("test", "a")).toBeDefined();
    });
  });
});
