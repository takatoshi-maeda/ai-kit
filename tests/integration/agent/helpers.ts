import {
  PROVIDERS,
  STRUCTURED_OUTPUT_PROVIDERS,
  hasApiKey,
  createTestClient,
  weatherTool,
} from "../llm/helpers.js";
import type { ProviderTestConfig } from "../llm/helpers.js";
import { AgentContextImpl } from "../../../src/agent/context.js";
import { InMemoryHistory } from "../../../src/agent/conversation/memory-history.js";
import { ConversationalAgent } from "../../../src/agent/conversational.js";
import type { AgentOptions } from "../../../src/types/agent.js";

// Perplexity lacks tool-call support and unreliable instruction-following
export const AGENT_PROVIDERS = PROVIDERS.filter(
  (p) => p.provider !== "perplexity",
);

export { STRUCTURED_OUTPUT_PROVIDERS, hasApiKey, weatherTool };
export type { ProviderTestConfig };

export function createAgentContext() {
  return new AgentContextImpl({ history: new InMemoryHistory() });
}

export function createAgent(
  config: ProviderTestConfig,
  overrides?: Partial<AgentOptions>,
): ConversationalAgent {
  return new ConversationalAgent({
    context: createAgentContext(),
    client: createTestClient(config),
    instructions: "You are a helpful assistant. Be concise.",
    ...overrides,
  });
}
