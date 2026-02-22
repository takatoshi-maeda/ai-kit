import { describe, it, expect, vi } from "vitest";
import { TextSimilarityIndex } from "../../src/similarity/text-index.js";
import type { EmbeddingProvider, EmbeddingModel } from "../../src/types/embedding.js";

function createMockProvider(
  embeddings: Map<string, number[]>,
): EmbeddingProvider {
  return {
    provider: "openai" as const,
    model: "mock-model",
    embed: vi.fn(async (text: string) => {
      return embeddings.get(text) ?? [0, 0, 0];
    }),
    embedBatch: vi.fn(async (texts: string[]) => {
      return texts.map((t) => embeddings.get(t) ?? [0, 0, 0]);
    }),
    availableModels: () => [] as EmbeddingModel[],
  };
}

describe("TextSimilarityIndex", () => {
  it("should start empty", () => {
    const provider = createMockProvider(new Map());
    const index = new TextSimilarityIndex(provider);
    expect(index.size).toBe(0);
  });

  it("should add and query a single text", async () => {
    const embeddings = new Map([
      ["hello", [1, 0, 0]],
      ["world", [0, 1, 0]],
      ["hello world", [0.7, 0.7, 0]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addText("hello", { id: "1" });
    await index.addText("world", { id: "2" });
    expect(index.size).toBe(2);

    const results = await index.query("hello world", 2);
    expect(results).toHaveLength(2);
    // Both should have positive scores since query has components of both
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[1].score).toBeGreaterThan(0);
    // Scores should be sorted descending
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it("should add texts in batch", async () => {
    const embeddings = new Map([
      ["a", [1, 0, 0]],
      ["b", [0, 1, 0]],
      ["c", [0, 0, 1]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addTexts(["a", "b", "c"], {
      ids: ["id-a", "id-b", "id-c"],
      metadatas: [{ type: "first" }, { type: "second" }, { type: "third" }],
    });

    expect(index.size).toBe(3);
  });

  it("should return metadata in results", async () => {
    const embeddings = new Map([
      ["doc1", [1, 0, 0]],
      ["query", [1, 0, 0]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addText("doc1", {
      id: "1",
      metadata: { source: "test" },
    });

    const results = await index.query("query", 1);
    expect(results[0].metadata).toEqual({ source: "test" });
  });

  it("should support queryById", async () => {
    const embeddings = new Map([
      ["a", [1, 0, 0]],
      ["b", [0.9, 0.1, 0]],
      ["c", [0, 0, 1]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addTexts(["a", "b", "c"], { ids: ["1", "2", "3"] });

    const results = await index.queryById("1", 2);
    expect(results).toHaveLength(2);
    // "a" and "b" are most similar
    expect(results[0].id).toBe("1"); // self is most similar
    expect(results[1].id).toBe("2"); // b is next
  });

  it("should return empty for queryById with unknown id", async () => {
    const provider = createMockProvider(new Map());
    const index = new TextSimilarityIndex(provider);
    const results = await index.queryById("nonexistent");
    expect(results).toEqual([]);
  });

  it("should support queryBatch", async () => {
    const embeddings = new Map([
      ["doc1", [1, 0, 0]],
      ["doc2", [0, 1, 0]],
      ["q1", [1, 0, 0]],
      ["q2", [0, 1, 0]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addTexts(["doc1", "doc2"], { ids: ["1", "2"] });

    const results = await index.queryBatch(["q1", "q2"], 1);
    expect(results).toHaveLength(2);
    expect(results[0][0].id).toBe("1"); // q1 ≈ doc1
    expect(results[1][0].id).toBe("2"); // q2 ≈ doc2
  });

  it("should support addItem and getOriginal", async () => {
    interface Article {
      title: string;
      body: string;
      id: number;
    }

    const embeddings = new Map([
      ["First article body", [1, 0, 0]],
      ["Second article body", [0, 1, 0]],
      ["query", [0.9, 0.1, 0]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex<Article>(provider);

    const articles: Article[] = [
      { title: "First", body: "First article body", id: 1 },
      { title: "Second", body: "Second article body", id: 2 },
    ];

    await index.addItems(articles, {
      textField: "body",
      idField: "id" as keyof Article & string,
    });

    expect(index.size).toBe(2);

    const results = await index.query("query", 1);
    expect(results[0].original).toEqual(articles[0]);

    const original = index.getOriginal("1");
    expect(original).toEqual(articles[0]);
  });

  it("should clear all entries", async () => {
    const embeddings = new Map([["a", [1, 0, 0]]]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addText("a", { id: "1" });
    expect(index.size).toBe(1);

    index.clear();
    expect(index.size).toBe(0);
  });

  it("should limit results to topK", async () => {
    const embeddings = new Map([
      ["a", [1, 0, 0]],
      ["b", [0.9, 0.1, 0]],
      ["c", [0.8, 0.2, 0]],
      ["q", [1, 0, 0]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addTexts(["a", "b", "c"]);

    const results = await index.query("q", 2);
    expect(results).toHaveLength(2);
  });

  it("should handle cosine similarity correctly", async () => {
    // Identical vectors → score ≈ 1
    // Orthogonal vectors → score ≈ 0
    const embeddings = new Map([
      ["same", [1, 0, 0]],
      ["orthogonal", [0, 1, 0]],
      ["query", [1, 0, 0]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addTexts(["same", "orthogonal"], { ids: ["same", "ortho"] });

    const results = await index.query("query", 2);
    expect(results[0].id).toBe("same");
    expect(results[0].score).toBeCloseTo(1.0);
    expect(results[1].id).toBe("ortho");
    expect(results[1].score).toBeCloseTo(0.0);
  });

  it("should auto-generate ids when not provided", async () => {
    const embeddings = new Map([
      ["text1", [1, 0, 0]],
      ["text2", [0, 1, 0]],
    ]);
    const provider = createMockProvider(embeddings);
    const index = new TextSimilarityIndex(provider);

    await index.addText("text1");
    await index.addText("text2");
    expect(index.size).toBe(2);
  });
});
