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
import { withObservation } from "../tracing/langfuse.js";

export type RerankerOptions =
  | { provider: "voyageai"; model: string; apiKey?: string }
  | { provider: "deepinfra"; model: string; apiKey?: string }
  | { provider: "bedrock"; model: string; region?: string };

export function createReranker(options: RerankerOptions): Reranker {
  const reranker = (() => {
  switch (options.provider) {
    case "voyageai":
      return new VoyageAIReranker(options);
    case "deepinfra":
      return new DeepInfraReranker(options);
    case "bedrock":
      return new BedrockReranker(options);
  }
  })();

  return {
    provider: reranker.provider,
    model: reranker.model,
    rerank(query, documents) {
      return withObservation(
        "reranker.rerank",
        {
          type: "span",
          input: { query, documentsCount: documents.length },
          model: reranker.model,
          metadata: { provider: reranker.provider },
        },
        async (observation) => {
          const result = await reranker.rerank(query, documents);
          observation.update({
            metadata: {
              documentsCount: documents.length,
            },
            output: {
              topScore: result.documents[0]?.score ?? null,
            },
          });
          return result;
        },
      );
    },
  };
}
