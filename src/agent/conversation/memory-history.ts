import type { LLMMessage } from "../../types/llm.js";
import type {
  ConversationHistory,
  ConversationMessage,
} from "../../types/agent.js";

export class InMemoryHistory implements ConversationHistory {
  private messages: ConversationMessage[] = [];

  async getMessages(options?: {
    limit?: number;
    before?: Date;
  }): Promise<ConversationMessage[]> {
    let result = this.messages;
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
    this.messages.push({ ...message, timestamp: new Date() });
  }

  async toLLMMessages(): Promise<LLMMessage[]> {
    return this.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  async clear(): Promise<void> {
    this.messages = [];
  }
}
