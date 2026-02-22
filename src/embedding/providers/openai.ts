import OpenAI from "openai";
import type {
  EmbeddingModel,
  EmbeddingProvider,
} from "../../types/embedding.js";
import { AiKitError } from "../../errors.js";

const OPENAI_MODELS: EmbeddingModel[] = [
  { name: "text-embedding-3-small", dimension: 1536, provider: "openai" },
  { name: "text-embedding-3-large", dimension: 3072, provider: "openai" },
  { name: "text-embedding-ada-002", dimension: 1536, provider: "openai" },
];

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(options: { model: string; apiKey?: string }) {
    this.model = options.model;
    this.client = new OpenAI({ apiKey: options.apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
      });
      return response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (error) {
      throw new AiKitError(
        `OpenAI embedding failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  availableModels(): EmbeddingModel[] {
    return OPENAI_MODELS;
  }
}
