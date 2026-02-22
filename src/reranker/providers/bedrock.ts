import type {
  Reranker,
  RerankDocument,
  RerankResult,
} from "../../types/embedding.js";
import { AiKitError } from "../../errors.js";

interface BedrockRerankResponse {
  results: { index: number; relevanceScore: number }[];
}

export class BedrockReranker implements Reranker {
  readonly provider = "bedrock" as const;
  readonly model: string;
  private readonly region: string;
  private client: unknown;

  constructor(options: { model: string; region?: string }) {
    this.model = options.model;
    this.region = options.region ?? process.env.AWS_REGION ?? "us-east-1";
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
  ): Promise<RerankResult> {
    // Dynamic import: optional peer dependency, not resolved at compile time
    const moduleName: string = "@aws-sdk/client-bedrock-agent-runtime";
    const { BedrockAgentRuntimeClient, RerankCommand } = await import(
      moduleName
    ).catch(() => {
      throw new AiKitError(
        "@aws-sdk/client-bedrock-agent-runtime is required for Bedrock reranking. " +
          "Install it with: npm install @aws-sdk/client-bedrock-agent-runtime",
      );
    });

    if (!this.client) {
      this.client = new BedrockAgentRuntimeClient({ region: this.region });
    }

    const modelArn = `arn:aws:bedrock:${this.region}::foundation-model/${this.model}`;

    try {
      const command = new RerankCommand({
        queries: [{ type: "TEXT", textQuery: { text: query } }],
        sources: documents.map((doc) => ({
          type: "INLINE",
          inlineDocumentSource: {
            type: "TEXT",
            textDocument: { text: doc.text },
          },
        })),
        rerankingConfiguration: {
          type: "BEDROCK_RERANKING_MODEL",
          bedrockRerankingConfiguration: {
            modelConfiguration: { modelArn },
          },
        },
      });

      const response = (await (this.client as { send: (cmd: unknown) => Promise<unknown> }).send(
        command,
      )) as BedrockRerankResponse;

      const reranked = response.results
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .map((r) => ({
          text: documents[r.index].text,
          score: r.relevanceScore,
          metadata: documents[r.index].metadata,
        }));

      return {
        documents: reranked,
        metadata: {
          provider: "bedrock",
          model: this.model,
          query,
          documentsCount: documents.length,
        },
      };
    } catch (error) {
      if (error instanceof AiKitError) throw error;
      throw new AiKitError(
        `Bedrock rerank failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }
}
