export type {
  EmbeddingProviderId,
  EmbeddingModel,
  EmbeddingProvider,
} from "./provider.js";

export { OpenAIEmbeddingProvider } from "./providers/openai.js";
export { VoyageAIEmbeddingProvider } from "./providers/voyageai.js";
export { DeepInfraEmbeddingProvider } from "./providers/deepinfra.js";

import type { EmbeddingProviderId, EmbeddingProvider } from "./provider.js";
import { OpenAIEmbeddingProvider } from "./providers/openai.js";
import { VoyageAIEmbeddingProvider } from "./providers/voyageai.js";
import { DeepInfraEmbeddingProvider } from "./providers/deepinfra.js";
import { withObservation } from "../tracing/langfuse.js";

export interface EmbeddingProviderOptions {
  provider: EmbeddingProviderId;
  model: string;
  apiKey?: string;
}

export function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): EmbeddingProvider {
  const provider = (() => {
  switch (options.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider(options);
    case "voyageai":
      return new VoyageAIEmbeddingProvider(options);
    case "deepinfra":
      return new DeepInfraEmbeddingProvider(options);
  }
  })();

  return {
    provider: provider.provider,
    model: provider.model,
    availableModels() {
      return provider.availableModels();
    },
    embed(text) {
      return withObservation(
        "embedding.embed",
        {
          type: "span",
          input: { text },
          model: provider.model,
          metadata: { provider: provider.provider },
        },
        async (observation) => {
          const vector = await provider.embed(text);
          observation.update({
            metadata: {
              dimension: vector.length,
            },
          });
          return vector;
        },
      );
    },
    embedBatch(texts) {
      return withObservation(
        "embedding.embed_batch",
        {
          type: "span",
          input: { textsCount: texts.length },
          model: provider.model,
          metadata: { provider: provider.provider },
        },
        async (observation) => {
          const vectors = await provider.embedBatch(texts);
          observation.update({
            metadata: {
              textsCount: texts.length,
              dimension: vectors[0]?.length ?? 0,
            },
          });
          return vectors;
        },
      );
    },
  };
}
