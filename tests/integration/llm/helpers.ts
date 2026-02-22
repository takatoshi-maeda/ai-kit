import { createLLMClient } from "../../../src/llm/index.js";
import type { LLMClient, LLMClientOptions } from "../../../src/llm/client.js";
import { defineTool } from "../../../src/llm/tool/define.js";
import { z } from "zod";

export interface ProviderTestConfig {
  provider: "openai" | "anthropic" | "google" | "perplexity";
  model: string;
  envKey: string;
}

export const PROVIDERS: ProviderTestConfig[] = [
  { provider: "openai", model: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", envKey: "ANTHROPIC_API_KEY" },
  { provider: "google", model: "gemini-2.0-flash", envKey: "GOOGLE_API_KEY" },
  { provider: "perplexity", model: "sonar", envKey: "PERPLEXITY_API_KEY" },
];

export const TOOL_CAPABLE_PROVIDERS = PROVIDERS.filter(
  (p) => p.provider !== "perplexity",
);

export const STRUCTURED_OUTPUT_PROVIDERS = PROVIDERS.filter(
  (p) => p.provider === "openai" || p.provider === "google",
);

export function hasApiKey(config: ProviderTestConfig): boolean {
  if (config.provider === "google") {
    return !!process.env[config.envKey] || !!process.env.GOOGLE_CLOUD_SA_CREDENTIAL;
  }
  return !!process.env[config.envKey];
}

export function createTestClient(config: ProviderTestConfig): LLMClient {
  const apiKey = process.env[config.envKey];

  if (config.provider === "google" && !apiKey && process.env.GOOGLE_CLOUD_SA_CREDENTIAL) {
    return createLLMClient({
      provider: "google",
      model: config.model,
      maxTokens: 256,
      temperature: 0,
    } as LLMClientOptions);
  }

  if (!apiKey) throw new Error(`Missing env var: ${config.envKey}`);

  return createLLMClient({
    provider: config.provider,
    model: config.model,
    apiKey,
    maxTokens: 256,
    temperature: 0,
  } as LLMClientOptions);
}

export const weatherTool = defineTool({
  name: "get_weather",
  description: "Get the current weather for a given location",
  parameters: z.object({
    location: z.string().describe("The city name, e.g. Tokyo"),
  }),
  execute: async ({ location }) => ({
    location,
    temperature: 22,
    condition: "sunny",
  }),
});
