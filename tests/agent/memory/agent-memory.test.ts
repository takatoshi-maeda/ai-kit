import { describe, it, expect, vi } from "vitest";
import { AgentMemoryImpl } from "../../../src/agent/memory/agent-memory.js";
import type { MemoryBackend } from "../../../src/agent/memory/backend.js";
import type { MemoryItem } from "../../../src/types/agent.js";

function createMockBackend(): MemoryBackend & {
  items: MemoryItem[];
} {
  const items: MemoryItem[] = [];
  let nextId = 1;

  return {
    items,
    async retrieve(query, options) {
      const limit = options?.limit ?? items.length;
      return items
        .filter((item) =>
          item.content.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, limit);
    },
    async save(item) {
      const saved: MemoryItem = {
        ...item,
        id: String(nextId++),
        createdAt: new Date(),
      };
      items.push(saved);
      return saved;
    },
    async delete(id) {
      const idx = items.findIndex((i) => i.id === id);
      if (idx >= 0) items.splice(idx, 1);
    },
  };
}

describe("AgentMemoryImpl", () => {
  it("saves with namespace", async () => {
    const backend = createMockBackend();
    const memory = new AgentMemoryImpl({
      namespace: "notes",
      backend,
    });

    const item = await memory.save("important fact");

    expect(item.id).toBe("1");
    expect(item.content).toBe("important fact");
    expect(item.namespace).toBe("notes");
    expect(item.createdAt).toBeInstanceOf(Date);
    expect(backend.items).toHaveLength(1);
  });

  it("saves with metadata", async () => {
    const backend = createMockBackend();
    const memory = new AgentMemoryImpl({ namespace: "ns", backend });

    const item = await memory.save("data", { tag: "test" });
    expect(item.metadata).toEqual({ tag: "test" });
  });

  it("retrieves matching items", async () => {
    const backend = createMockBackend();
    const memory = new AgentMemoryImpl({ namespace: "ns", backend });

    await memory.save("apples are red");
    await memory.save("bananas are yellow");

    const results = await memory.retrieve("apple");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("apples are red");
  });

  it("retrieves with limit", async () => {
    const backend = createMockBackend();
    const memory = new AgentMemoryImpl({ namespace: "ns", backend });

    await memory.save("fact one about cats");
    await memory.save("fact two about cats");
    await memory.save("fact three about cats");

    const results = await memory.retrieve("cats", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("defaults metadata to empty object", async () => {
    const backend = createMockBackend();
    const memory = new AgentMemoryImpl({ namespace: "ns", backend });

    const item = await memory.save("test");
    expect(item.metadata).toEqual({});
  });

  describe("toRetrieverTool", () => {
    it("creates a valid tool definition", () => {
      const backend = createMockBackend();
      const memory = new AgentMemoryImpl({ namespace: "ns", backend });

      const tool = memory.toRetrieverTool();
      expect(tool.name).toBe("memory_retrieve");
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeInstanceOf(Function);
    });

    it("executes retrieve via tool", async () => {
      const backend = createMockBackend();
      const memory = new AgentMemoryImpl({ namespace: "ns", backend });

      await memory.save("TypeScript is great");

      const tool = memory.toRetrieverTool();
      const result = await tool.execute({ query: "TypeScript" });

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("TypeScript is great");
      expect(result[0].createdAt).toBeTruthy();
    });
  });

  describe("toWriterTool", () => {
    it("creates a valid tool definition", () => {
      const backend = createMockBackend();
      const memory = new AgentMemoryImpl({ namespace: "ns", backend });

      const tool = memory.toWriterTool();
      expect(tool.name).toBe("memory_save");
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeInstanceOf(Function);
    });

    it("executes save via tool", async () => {
      const backend = createMockBackend();
      const memory = new AgentMemoryImpl({ namespace: "ns", backend });

      const tool = memory.toWriterTool();
      const result = await tool.execute({
        content: "new memory",
        metadata: { source: "test" },
      });

      expect(result.id).toBeTruthy();
      expect(result.content).toBe("new memory");
      expect(backend.items).toHaveLength(1);
      expect(backend.items[0].metadata).toEqual({ source: "test" });
    });

    it("executes save without metadata via tool", async () => {
      const backend = createMockBackend();
      const memory = new AgentMemoryImpl({ namespace: "ns", backend });

      const tool = memory.toWriterTool();
      const result = await tool.execute({ content: "bare memory" });

      expect(result.content).toBe("bare memory");
      expect(backend.items[0].metadata).toEqual({});
    });
  });
});
