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

export interface EmbeddingProviderOptions {
  provider: EmbeddingProviderId;
  model: string;
  apiKey?: string;
}

export function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): EmbeddingProvider {
  switch (options.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider(options);
    case "voyageai":
      return new VoyageAIEmbeddingProvider(options);
    case "deepinfra":
      return new DeepInfraEmbeddingProvider(options);
  }
}
