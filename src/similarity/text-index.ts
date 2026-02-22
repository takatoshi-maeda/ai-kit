import type {
  EmbeddingProvider,
  SimilarityResult,
} from "../types/embedding.js";

interface IndexEntry<T> {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  original?: T;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class TextSimilarityIndex<T = unknown> {
  private readonly provider: EmbeddingProvider;
  private readonly entries: Map<string, IndexEntry<T>> = new Map();
  private nextId = 0;

  constructor(provider: EmbeddingProvider) {
    this.provider = provider;
  }

  async addText(
    text: string,
    options?: { id?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    const id = options?.id ?? this.generateId();
    const [embedding] = await this.provider.embedBatch([text]);
    this.entries.set(id, { id, text, embedding, metadata: options?.metadata });
  }

  async addTexts(
    texts: string[],
    options?: {
      ids?: string[];
      metadatas?: Record<string, unknown>[];
    },
  ): Promise<void> {
    const embeddings = await this.provider.embedBatch(texts);
    for (let i = 0; i < texts.length; i++) {
      const id = options?.ids?.[i] ?? this.generateId();
      this.entries.set(id, {
        id,
        text: texts[i],
        embedding: embeddings[i],
        metadata: options?.metadatas?.[i],
      });
    }
  }

  async addItem(
    item: T,
    options: { textField: keyof T & string; idField?: keyof T & string },
  ): Promise<void> {
    await this.addItems([item], options);
  }

  async addItems(
    items: T[],
    options: { textField: keyof T & string; idField?: keyof T & string },
  ): Promise<void> {
    const texts = items.map(
      (item) => String((item as Record<string, unknown>)[options.textField]),
    );
    const embeddings = await this.provider.embedBatch(texts);

    for (let i = 0; i < items.length; i++) {
      const id = options.idField
        ? String((items[i] as Record<string, unknown>)[options.idField])
        : this.generateId();
      this.entries.set(id, {
        id,
        text: texts[i],
        embedding: embeddings[i],
        original: items[i],
      });
    }
  }

  async query(
    text: string,
    topK: number = 10,
  ): Promise<SimilarityResult<T>[]> {
    const queryEmbedding = await this.provider.embed(text);
    return this.queryByEmbedding(queryEmbedding, topK);
  }

  async queryById(
    id: string,
    topK: number = 10,
  ): Promise<SimilarityResult<T>[]> {
    const entry = this.entries.get(id);
    if (!entry) return [];
    return this.queryByEmbedding(entry.embedding, topK);
  }

  async queryBatch(
    texts: string[],
    topK: number = 10,
  ): Promise<SimilarityResult<T>[][]> {
    const queryEmbeddings = await this.provider.embedBatch(texts);
    return queryEmbeddings.map((emb) => this.queryByEmbedding(emb, topK));
  }

  getOriginal(id: string): T | undefined {
    return this.entries.get(id)?.original;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private queryByEmbedding(
    embedding: number[],
    topK: number,
  ): SimilarityResult<T>[] {
    const scored: SimilarityResult<T>[] = [];
    for (const entry of this.entries.values()) {
      scored.push({
        id: entry.id,
        text: entry.text,
        score: cosineSimilarity(embedding, entry.embedding),
        metadata: entry.metadata,
        original: entry.original,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private generateId(): string {
    return `idx_${this.nextId++}`;
  }
}
