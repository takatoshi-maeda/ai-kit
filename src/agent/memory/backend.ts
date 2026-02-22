import type { MemoryItem } from "../../types/agent.js";

export interface MemoryBackend {
  retrieve(
    query: string,
    options?: { limit?: number },
  ): Promise<MemoryItem[]>;
  save(item: Omit<MemoryItem, "id" | "createdAt">): Promise<MemoryItem>;
  delete(id: string): Promise<void>;
}

export interface MemoryPolicy {
  load?: { autoLoad: boolean; maxItems: number };
  save?: { autoSave: boolean };
}
