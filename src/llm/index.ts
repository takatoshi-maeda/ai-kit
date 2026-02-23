import type { LLMClient, LLMClientOptions } from "./client.js";
import { OpenAIClient } from "./providers/openai.js";
import { AnthropicClient } from "./providers/anthropic.js";
import { GoogleClient } from "./providers/google.js";
import { PerplexityClient } from "./providers/perplexity.js";
import type { LLMResult } from "../types/llm.js";
import type { LLMStreamEvent } from "../types/stream-events.js";
import { startObservation, withObservation } from "../tracing/langfuse.js";
import type { LLMProvider } from "./client.js";

function buildTracingMetadata(
  provider: LLMProvider,
  mode: "invoke" | "stream",
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider,
    mode,
    // Langfuse ChatML adapter relies on this key for robust provider detection.
    ls_provider: provider,
    attributes: {
      "llm.system": provider,
    },
    ...(extra ?? {}),
  };
}

export function createLLMClient(options: LLMClientOptions): LLMClient {
  const client = (() => {
  switch (options.provider) {
    case "openai":
      return new OpenAIClient(options);
    case "anthropic":
      return new AnthropicClient(options);
    case "google":
      return new GoogleClient(options);
    case "perplexity":
      return new PerplexityClient(options);
  }
  })();
  return createTracedLLMClient(client);
}

function createTracedLLMClient(client: LLMClient): LLMClient {
  return {
    provider: client.provider,
    model: client.model,
    capabilities: client.capabilities,
    estimateTokens(content: string): number {
      return client.estimateTokens(content);
    },
    invoke(input) {
      return withObservation(
        "llm.invoke",
        {
          type: "generation",
          input,
          model: client.model,
          metadata: buildTracingMetadata(client.provider, "invoke"),
        },
        async (observation) => {
          const result = await client.invoke(input);
          observation.update({
            output: result.content,
            usage: result.usage,
            metadata: buildTracingMetadata(client.provider, "invoke", {
              responseId: result.responseId,
              toolCalls: result.toolCalls.length,
            }),
          });
          return result;
        },
      );
    },
    stream(input) {
      return tracedStream(client, input);
    },
  };
}

async function *tracedStream(
  client: LLMClient,
  input: Parameters<LLMClient["stream"]>[0],
): AsyncIterable<LLMStreamEvent> {
  const observationPromise = startObservation("llm.stream", {
    type: "generation",
    input,
    model: client.model,
    metadata: buildTracingMetadata(client.provider, "stream"),
  });

  let completedResult: LLMResult | null = null;
  let streamError: Error | null = null;

  try {
    for await (const event of client.stream(input)) {
      if (event.type === "response.completed") {
        completedResult = event.result;
      } else if (event.type === "response.failed" || event.type === "error") {
        streamError = event.error;
      }
      yield event;
    }
  } catch (error) {
    streamError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    try {
      const observation = await observationPromise;
      if (completedResult) {
        observation.update({
          output: completedResult.content,
          usage: completedResult.usage,
          metadata: buildTracingMetadata(client.provider, "stream", {
            responseId: completedResult.responseId,
            toolCalls: completedResult.toolCalls.length,
          }),
        });
      } else if (streamError) {
        observation.update({
          metadata: buildTracingMetadata(client.provider, "stream", {
            error: streamError.message,
          }),
        });
      }
      observation.end();
    } catch {
      // Tracing must never break normal stream behavior
    }
  }
}

// Re-export client types
export type {
  LLMClient,
  LLMClientOptions,
  LLMClientOptionsBase,
  LLMProvider,
  OpenAIClientOptions,
  AnthropicClientOptions,
  GoogleClientOptions,
  GoogleSafetySettings,
  PerplexityClientOptions,
} from "./client.js";

// Re-export providers for direct usage
export { OpenAIClient } from "./providers/openai.js";
export { AnthropicClient } from "./providers/anthropic.js";
export { GoogleClient } from "./providers/google.js";
export { PerplexityClient } from "./providers/perplexity.js";

// Re-export tool utilities
export { defineTool, toolToJsonSchema } from "./tool/define.js";
export { ToolExecutor } from "./tool/executor.js";
export { toolCallsToMessages } from "./tool/message-converter.js";
