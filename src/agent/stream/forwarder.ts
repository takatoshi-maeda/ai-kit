import type { LLMStreamEvent } from "../../types/stream-events.js";
import type { AgentStreamResponse } from "./responses.js";

export interface AgentStreamForwarderOptions {
  debug?: boolean;
}

/**
 * LLMStreamEvent を AgentStreamResponse に変換するフォワーダー。
 * NDJSON 出力などの外部配信に使用。
 */
export class AgentStreamForwarder {
  private readonly debug: boolean;

  constructor(options?: AgentStreamForwarderOptions) {
    this.debug = options?.debug ?? false;
  }

  async *forward(
    stream: AsyncIterable<LLMStreamEvent>,
  ): AsyncIterable<AgentStreamResponse> {
    for await (const event of stream) {
      const mapped = this.mapEvent(event);
      if (mapped) {
        yield mapped;
      } else if (this.debug) {
        yield {
          type: "agent.progress",
          summary: `Unhandled event: ${event.type}`,
          description: "",
        };
      }
    }
  }

  private mapEvent(event: LLMStreamEvent): AgentStreamResponse | null {
    switch (event.type) {
      case "text.delta":
        return { type: "agent.text_delta", delta: event.delta };

      case "reasoning.delta":
        return { type: "agent.reasoning_delta", delta: event.delta };

      case "tool_call.arguments.done":
        return {
          type: "agent.tool_call",
          name: event.name,
          summary: `Called ${event.name}`,
        };

      case "response.completed":
        return {
          type: "agent.result",
          resultType: event.result.content != null ? "text" : "json",
          content: event.result.content,
          responseId: event.result.responseId ?? undefined,
        };

      case "error":
        return { type: "agent.error", error: event.error };

      case "response.failed":
        return { type: "agent.error", error: event.error };

      default:
        return null;
    }
  }
}
