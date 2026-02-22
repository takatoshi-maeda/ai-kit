import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIEmbeddingProvider } from "../../src/embedding/providers/openai.js";
import { createEmbeddingProvider } from "../../src/embedding/index.js";

const mockCreate = vi.fn();

vi.mock("openai", () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    embeddings: { create: mockCreate },
  }));
  return { default: MockOpenAI };
});

describe("OpenAIEmbeddingProvider", () => {
  let provider: OpenAIEmbeddingProvider;

  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
    provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      apiKey: "test-key",
    });
  });

  it("should have correct provider and model", () => {
    expect(provider.provider).toBe("openai");
    expect(provider.model).toBe("text-embedding-3-small");
  });

  it("should embed a single text", async () => {
    const result = await provider.embed("hello world");
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["hello world"],
    });
  });

  it("should embed batch of texts and sort by index", async () => {
    mockCreate.mockResolvedValueOnce({
      data: [
        { index: 1, embedding: [0.4, 0.5, 0.6] },
        { index: 0, embedding: [0.1, 0.2, 0.3] },
      ],
      usage: { prompt_tokens: 10, total_tokens: 10 },
    });

    const result = await provider.embedBatch(["text1", "text2"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result[1]).toEqual([0.4, 0.5, 0.6]);
  });

  it("should list available models", () => {
    const models = provider.availableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "openai")).toBe(true);
    expect(models.find((m) => m.name === "text-embedding-3-small")).toBeDefined();
    expect(models.find((m) => m.name === "text-embedding-3-large")).toBeDefined();
  });

  it("should throw AiKitError on API failure", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"));

    await expect(provider.embed("test")).rejects.toThrow("OpenAI embedding failed");
  });
});

describe("createEmbeddingProvider", () => {
  it("should create OpenAI provider", () => {
    const p = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "test-key",
    });
    expect(p.provider).toBe("openai");
    expect(p.model).toBe("text-embedding-3-small");
  });

  it("should create VoyageAI provider", () => {
    const p = createEmbeddingProvider({
      provider: "voyageai",
      model: "voyage-3",
      apiKey: "test-key",
    });
    expect(p.provider).toBe("voyageai");
    expect(p.model).toBe("voyage-3");
  });

  it("should create DeepInfra provider", () => {
    const p = createEmbeddingProvider({
      provider: "deepinfra",
      model: "BAAI/bge-m3",
      apiKey: "test-key",
    });
    expect(p.provider).toBe("deepinfra");
    expect(p.model).toBe("BAAI/bge-m3");
  });
});
