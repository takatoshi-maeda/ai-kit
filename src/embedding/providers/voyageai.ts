import type {
  EmbeddingModel,
  EmbeddingProvider,
} from "../../types/embedding.js";
import { AiKitError } from "../../errors.js";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

const VOYAGE_MODELS: EmbeddingModel[] = [
  { name: "voyage-3", dimension: 1024, provider: "voyageai" },
  { name: "voyage-3-lite", dimension: 512, provider: "voyageai" },
  { name: "voyage-code-3", dimension: 1024, provider: "voyageai" },
  { name: "voyage-large-2", dimension: 1536, provider: "voyageai" },
];

interface VoyageEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

export class VoyageAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "voyageai" as const;
  readonly model: string;
  private readonly apiKey: string;

  constructor(options: { model: string; apiKey?: string }) {
    this.model = options.model;
    this.apiKey = options.apiKey ?? process.env.VOYAGE_API_KEY ?? "";
    if (!this.apiKey) {
      throw new AiKitError("VoyageAI API key is required (pass apiKey or set VOYAGE_API_KEY)");
    }
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new AiKitError(
        `VoyageAI embedding failed (${response.status}): ${body}`,
      );
    }

    const json = (await response.json()) as VoyageEmbeddingResponse;
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  availableModels(): EmbeddingModel[] {
    return VOYAGE_MODELS;
  }
}
