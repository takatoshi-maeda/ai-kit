import type { LLMProvider } from "./agent.js";

export type AgentReasoningEffort = "low" | "medium" | "high";
export type AgentVerbosity = "low" | "medium" | "high";

export interface AgentRuntimeSettings {
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  verbosity?: AgentVerbosity;
}

export interface ResolvedAgentRuntime {
  model: string;
  reasoningEffort?: AgentReasoningEffort;
  verbosity?: AgentVerbosity;
}

export interface AgentRuntimePolicy {
  provider: LLMProvider;
  defaults: ResolvedAgentRuntime;
  allowedModels?: string[];
  allowedReasoningEfforts?: AgentReasoningEffort[];
  allowedVerbosity?: AgentVerbosity[];
}
