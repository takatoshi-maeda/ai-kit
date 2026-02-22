export type EmbeddingProviderId = "openai" | "voyageai" | "deepinfra";

export interface EmbeddingModel {
  name: string;
  dimension: number;
  provider: EmbeddingProviderId;
}

export interface EmbeddingProvider {
  readonly provider: EmbeddingProviderId;
  readonly model: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  availableModels(): EmbeddingModel[];
}

export type RerankerProviderId = "voyageai" | "deepinfra" | "bedrock";

export interface RerankDocument {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RerankedDocument {
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RerankResult {
  documents: RerankedDocument[];
  metadata: {
    provider: RerankerProviderId;
    model: string;
    query: string;
    documentsCount: number;
    inputTokens?: number;
  };
}

export interface SimilarityResult<T = unknown> {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
  original?: T;
}
