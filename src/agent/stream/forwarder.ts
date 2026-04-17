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
  private activeTextPart = false;
  private activeText = "";

  constructor(options?: AgentStreamForwarderOptions) {
    this.debug = options?.debug ?? false;
  }

  async *forward(
    stream: AsyncIterable<LLMStreamEvent>,
  ): AsyncIterable<AgentStreamResponse> {
    for await (const event of stream) {
      const mapped = this.mapEvent(event);
      if (mapped.length > 0) {
        for (const item of mapped) {
          yield item;
        }
      } else if (this.debug) {
        if (event.type !== "text.done" || !this.activeTextPart) {
          yield {
            type: "agent.progress",
            summary: `Unhandled event: ${event.type}`,
            description: "",
          };
        }
      }
    }
  }

  private mapEvent(event: LLMStreamEvent): AgentStreamResponse[] {
    switch (event.type) {
      case "text.delta": {
        this.activeText += event.delta;
        if (this.activeTextPart) {
          return [{ type: "agent.text_delta", delta: event.delta }];
        }
        this.activeTextPart = true;
        return [
          { type: "agent.part_added", part: { type: "text" } },
          { type: "agent.text_delta", delta: event.delta },
        ];
      }

      case "text.done":
        return this.flushTextPart(event.text);

      case "reasoning.delta":
        return [
          ...this.flushTextPart(),
          { type: "agent.reasoning_delta", delta: event.delta },
        ];

      case "output_item.added":
        return [
          ...this.flushTextPart(),
          {
            type: "agent.output_item.added",
            itemId: event.itemId,
            item: event.item,
            contentType: event.contentType,
          },
        ];

      case "artifact.delta":
        return [
          ...this.flushTextPart(),
          {
            type: "agent.artifact_delta",
            itemId: event.itemId,
            delta: event.delta,
          },
        ];

      case "output_item.done":
        return [
          ...this.flushTextPart(),
          {
            type: "agent.output_item.done",
            itemId: event.itemId,
            item: event.item,
            contentType: event.contentType,
          },
        ];

      case "tool_call.arguments.done":
        return [
          ...this.flushTextPart(),
          {
            type: "agent.tool_call",
            name: event.name,
            summary: `Called ${event.name}`,
          },
        ];

      case "tool_result":
        return [
          ...this.flushTextPart(),
          {
            type: "agent.progress",
            summary: event.isError ? `Tool failed: ${event.name}` : `Tool finished: ${event.name}`,
            description: event.content,
          },
        ];

      case "response.completed":
        return [
          ...this.flushTextPart(),
          {
            type: "agent.result",
            resultType: event.result.content != null ? "text" : "json",
            content: event.result.content,
            responseId: event.result.responseId ?? undefined,
          },
        ];

      case "error":
        return [{ type: "agent.error", error: event.error }];

      case "response.failed":
        return [{ type: "agent.error", error: event.error }];

      default:
        return [];
    }
  }

  private flushTextPart(completedText?: string): AgentStreamResponse[] {
    if (!this.activeTextPart) {
      return [];
    }
    const text = completedText ?? this.activeText;
    this.activeTextPart = false;
    this.activeText = "";
    return [{
      type: "agent.part_done",
      part: {
        type: "text",
        text,
      },
    }];
  }
}
