import { z } from "zod";
import type { ToolDefinition } from "../../types/tool.js";
import type { AgentMemory, MemoryItem } from "../../types/agent.js";
import type { MemoryBackend, MemoryPolicy } from "./backend.js";

export interface AgentMemoryOptions {
  namespace: string;
  backend: MemoryBackend;
  policy?: MemoryPolicy;
}

export class AgentMemoryImpl implements AgentMemory {
  private readonly namespace: string;
  private readonly backend: MemoryBackend;
  readonly policy: MemoryPolicy;

  constructor(options: AgentMemoryOptions) {
    this.namespace = options.namespace;
    this.backend = options.backend;
    this.policy = options.policy ?? {};
  }

  async retrieve(
    query: string,
    options?: { limit?: number },
  ): Promise<MemoryItem[]> {
    return this.backend.retrieve(query, options);
  }

  async save(
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<MemoryItem> {
    return this.backend.save({
      namespace: this.namespace,
      content,
      metadata: metadata ?? {},
    });
  }

  toRetrieverTool(): ToolDefinition {
    const memory = this;
    return {
      name: "memory_retrieve",
      description:
        "Search long-term memory for relevant information based on a query.",
      parameters: z.object({
        query: z.string().describe("The search query"),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of results to return"),
      }),
      async execute(params) {
        const items = await memory.retrieve(params.query, {
          limit: params.limit,
        });
        return items.map((item) => ({
          id: item.id,
          content: item.content,
          metadata: item.metadata,
          createdAt: item.createdAt.toISOString(),
        }));
      },
    };
  }

  toWriterTool(): ToolDefinition {
    const memory = this;
    return {
      name: "memory_save",
      description: "Save important information to long-term memory.",
      parameters: z.object({
        content: z.string().describe("The content to save"),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe("Optional metadata to attach"),
      }),
      async execute(params) {
        const item = await memory.save(params.content, params.metadata);
        return {
          id: item.id,
          content: item.content,
          createdAt: item.createdAt.toISOString(),
        };
      },
    };
  }
}
