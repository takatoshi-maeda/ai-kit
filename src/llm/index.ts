import type { LLMClient, LLMClientOptions } from "./client.js";
import { OpenAIClient } from "./providers/openai.js";
import { AnthropicClient } from "./providers/anthropic.js";
import { GoogleClient } from "./providers/google.js";
import { PerplexityClient } from "./providers/perplexity.js";

export function createLLMClient(options: LLMClientOptions): LLMClient {
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
