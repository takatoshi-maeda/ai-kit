import type {
  Reranker,
  RerankDocument,
  RerankResult,
} from "../../types/embedding.js";
import { AiKitError } from "../../errors.js";

const DEEPINFRA_RERANK_URL = "https://api.deepinfra.com/v1/rerank";

interface DeepInfraRerankResponse {
  results: { index: number; relevance_score: number }[];
}

export class DeepInfraReranker implements Reranker {
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

  async rerank(
    query: string,
    documents: RerankDocument[],
  ): Promise<RerankResult> {
    const response = await fetch(DEEPINFRA_RERANK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: documents.map((d) => d.text),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new AiKitError(
        `DeepInfra rerank failed (${response.status}): ${body}`,
      );
    }

    const json = (await response.json()) as DeepInfraRerankResponse;

    const reranked = json.results
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((r) => ({
        text: documents[r.index].text,
        score: r.relevance_score,
        metadata: documents[r.index].metadata,
      }));

    return {
      documents: reranked,
      metadata: {
        provider: "deepinfra",
        model: this.model,
        query,
        documentsCount: documents.length,
      },
    };
  }
}
