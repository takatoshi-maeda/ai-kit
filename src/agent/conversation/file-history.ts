import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LLMMessage } from "../../types/llm.js";
import type {
  ConversationHistory,
  ConversationMessage,
} from "../../types/agent.js";

interface StoredMessage {
  role: ConversationMessage["role"];
  content: string | unknown[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export class FileHistory implements ConversationHistory {
  private readonly filePath: string;

  constructor(options: { sessionId: string; baseDir: string }) {
    this.filePath = path.join(options.baseDir, `${options.sessionId}.jsonl`);
  }

  private async readAll(): Promise<ConversationMessage[]> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const messages: ConversationMessage[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const stored: StoredMessage = JSON.parse(line);
      messages.push({
        role: stored.role,
        content: stored.content as ConversationMessage["content"],
        timestamp: new Date(stored.timestamp),
        metadata: stored.metadata,
      });
    }
    return messages;
  }

  async getMessages(options?: {
    limit?: number;
    before?: Date;
  }): Promise<ConversationMessage[]> {
    let result = await this.readAll();
    if (options?.before) {
      result = result.filter((m) => m.timestamp < options.before!);
    }
    if (options?.limit) {
      result = result.slice(-options.limit);
    }
    return result;
  }

  async addMessage(
    message: Omit<ConversationMessage, "timestamp">,
  ): Promise<void> {
    const stored: StoredMessage = {
      role: message.role,
      content: message.content,
      timestamp: new Date().toISOString(),
      metadata: message.metadata,
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, JSON.stringify(stored) + "\n", "utf-8");
  }

  async toLLMMessages(): Promise<LLMMessage[]> {
    const messages = await this.readAll();
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}
