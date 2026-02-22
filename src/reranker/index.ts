export type {
  Reranker,
  RerankerProviderId,
  RerankDocument,
  RerankedDocument,
  RerankResult,
} from "./reranker.js";

export { VoyageAIReranker } from "./providers/voyageai.js";
export { DeepInfraReranker } from "./providers/deepinfra.js";
export { BedrockReranker } from "./providers/bedrock.js";

import type { RerankerProviderId, Reranker } from "./reranker.js";
import { VoyageAIReranker } from "./providers/voyageai.js";
import { DeepInfraReranker } from "./providers/deepinfra.js";
import { BedrockReranker } from "./providers/bedrock.js";

export type RerankerOptions =
  | { provider: "voyageai"; model: string; apiKey?: string }
  | { provider: "deepinfra"; model: string; apiKey?: string }
  | { provider: "bedrock"; model: string; region?: string };

export function createReranker(options: RerankerOptions): Reranker {
  switch (options.provider) {
    case "voyageai":
      return new VoyageAIReranker(options);
    case "deepinfra":
      return new DeepInfraReranker(options);
    case "bedrock":
      return new BedrockReranker(options);
  }
}
