import type { ZodType } from "zod";
import type { LLMChatInput, LLMResult, LLMUsage } from "./llm.js";
import type { LLMToolCall, LLMToolResult, ToolDefinition } from "./tool.js";

export interface AgentContext {
  history: ConversationHistory;
  sessionId: string;
  progress: ProgressTracker;
  toolCallResults: LLMToolCall[];
  turns: TurnResult[];
  selectedAgentName?: string;
  metadata: Map<string, unknown>;
  collectToolResults<T>(schema: ZodType<T>): T[];
}

export interface AgentResult {
  content: string | null;
  toolCalls: LLMToolCall[];
  usage: LLMUsage;
  responseId: string | null;
  raw: LLMResult;
}

export interface TurnResult {
  turnType: "finish" | "next_action";
  result: LLMResult;
  index: number;
}

export interface AgentOptions {
  context: AgentContext;
  client: LLMClient;
  instructions: string;
  tools?: ToolDefinition[];
  hooks?: AgentHooks;
  toolPipeline?: ToolPipeline;
  memory?: AgentMemory;
  maxTurns?: number;
}

export interface AgentHooks {
  beforeTurn?: BeforeTurnHook[];
  afterTurn?: AfterTurnHook[];
  beforeToolCall?: BeforeToolCallHook[];
  afterToolCall?: AfterToolCallHook[];
  afterRun?: AfterRunHook[];
}

export type BeforeTurnHook = (ctx: BeforeTurnContext) => Promise<void>;
export type AfterTurnHook = (ctx: AfterTurnContext) => Promise<void>;
export type BeforeToolCallHook = (ctx: BeforeToolCallContext) => Promise<void>;
export type AfterToolCallHook = (ctx: AfterToolCallContext) => Promise<void>;
export type AfterRunHook = (ctx: AfterRunContext) => Promise<AfterRunAction>;

export type AfterRunAction =
  | { type: "done" }
  | { type: "rerun"; reason?: string };

export interface BeforeTurnContext {
  agentContext: AgentContext;
  turnIndex: number;
  input: LLMChatInput;
}

export interface AfterTurnContext {
  agentContext: AgentContext;
  turnResult: TurnResult;
}

export interface BeforeToolCallContext {
  agentContext: AgentContext;
  toolCall: LLMToolCall;
}

export interface AfterToolCallContext {
  agentContext: AgentContext;
  toolCall: LLMToolCall;
  result: LLMToolResult;
}

export interface AfterRunContext {
  agentContext: AgentContext;
  result: AgentResult;
}

export interface ToolPipeline {
  onStart?: ToolDefinition[];
  onBeforeComplete?: ToolDefinition[];
}

// Forward-declared interfaces for types used by AgentOptions/AgentContext
// Full implementations are in their respective modules

export interface ConversationHistory {
  getMessages(options?: {
    limit?: number;
    before?: Date;
  }): Promise<ConversationMessage[]>;
  addMessage(message: Omit<ConversationMessage, "timestamp">): Promise<void>;
  toLLMMessages(): Promise<import("./llm.js").LLMMessage[]>;
  clear(): Promise<void>;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | import("./llm.js").ContentPart[];
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface LLMClient {
  readonly model: string;
  readonly provider: LLMProvider;
  readonly capabilities: import("./model.js").ModelCapabilities;
  invoke(
    input: LLMChatInput,
  ): Promise<LLMResult>;
  stream(
    input: LLMChatInput,
  ): AsyncIterable<import("./stream-events.js").LLMStreamEvent>;
  estimateTokens(content: string): number;
}

export type LLMProvider = "openai" | "anthropic" | "google" | "perplexity";

export interface ProgressTracker {
  readonly goals: ProgressGoal[];
  subscribe(listener: ProgressListener): () => void;
  addGoal(title: string, type: ProgressType): ProgressGoal;
  updateGoalStatus(goalId: string, status: ProgressStatus): void;
  addStep(
    goalId: string,
    title: string,
    options?: {
      description?: string;
      tags?: string[];
      status?: ProgressStatus;
    },
  ): ProgressStep;
  updateStepStatus(
    goalId: string,
    stepId: string,
    status: ProgressStatus,
  ): void;
}

export type ProgressStatus = "pending" | "in_progress" | "completed";
export type ProgressType = "thinking" | "search";
export type ProgressListener = (goals: ProgressGoal[]) => void;

export interface ProgressGoal {
  id: string;
  title: string;
  type: ProgressType;
  status: ProgressStatus;
  steps: ProgressStep[];
}

export interface ProgressStep {
  id: string;
  title: string;
  description?: string;
  status: ProgressStatus;
  tags?: string[];
}

export interface AgentMemory {
  retrieve(
    query: string,
    options?: { limit?: number },
  ): Promise<MemoryItem[]>;
  save(
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<MemoryItem>;
  toRetrieverTool(): ToolDefinition;
  toWriterTool(): ToolDefinition;
}

export interface MemoryItem {
  id: string;
  namespace: string;
  content: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
  embedding?: number[];
}
