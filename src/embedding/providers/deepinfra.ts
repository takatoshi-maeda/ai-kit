import type {
  EmbeddingModel,
  EmbeddingProvider,
} from "../../types/embedding.js";
import { AiKitError } from "../../errors.js";

const DEEPINFRA_API_URL = "https://api.deepinfra.com/v1/openai/embeddings";

const DEEPINFRA_MODELS: EmbeddingModel[] = [
  { name: "BAAI/bge-large-en-v1.5", dimension: 1024, provider: "deepinfra" },
  { name: "BAAI/bge-m3", dimension: 1024, provider: "deepinfra" },
  { name: "intfloat/e5-large-v2", dimension: 1024, provider: "deepinfra" },
];

interface DeepInfraEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage: { prompt_tokens: number; total_tokens: number };
}

export class DeepInfraEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "deepinfra" as const;
  readonly model: string;
  private readonly apiKey: string;

  constructor(options: { model: string; apiKey?: string }) {
    this.model = options.model;
    this.apiKey = options.apiKey ?? process.env.DEEPINFRA_API_KEY ?? "";
    if (!this.apiKey) {
      throw new AiKitError("DeepInfra API key is required (pass apiKey or set DEEPINFRA_API_KEY)");
    }
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(DEEPINFRA_API_URL, {
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
        `DeepInfra embedding failed (${response.status}): ${body}`,
      );
    }

    const json = (await response.json()) as DeepInfraEmbeddingResponse;
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  availableModels(): EmbeddingModel[] {
    return DEEPINFRA_MODELS;
  }
}
