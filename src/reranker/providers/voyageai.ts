import type {
  Reranker,
  RerankDocument,
  RerankResult,
} from "../../types/embedding.js";
import { AiKitError } from "../../errors.js";

const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";

interface VoyageRerankResponse {
  results: { index: number; relevance_score: number }[];
  usage: { total_tokens: number };
}

export class VoyageAIReranker implements Reranker {
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

  async rerank(
    query: string,
    documents: RerankDocument[],
  ): Promise<RerankResult> {
    const response = await fetch(VOYAGE_RERANK_URL, {
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
        `VoyageAI rerank failed (${response.status}): ${body}`,
      );
    }

    const json = (await response.json()) as VoyageRerankResponse;

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
        provider: "voyageai",
        model: this.model,
        query,
        documentsCount: documents.length,
        inputTokens: json.usage.total_tokens,
      },
    };
  }
}
