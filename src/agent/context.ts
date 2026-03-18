import type { ZodType } from "zod";
import type { AuthContext } from "../auth/index.js";
import type {
  AgentContext,
  ConversationHistory,
  ProgressTracker,
  TurnResult,
} from "../types/agent.js";
import type { LLMToolCall } from "../types/tool.js";
import { ProgressTrackerImpl } from "./progress.js";

export interface AgentContextOptions {
  history: ConversationHistory;
  sessionId?: string;
  auth?: AuthContext;
  progress?: ProgressTracker;
  selectedAgentName?: string;
}

export class AgentContextImpl implements AgentContext {
  readonly history: ConversationHistory;
  readonly sessionId: string;
  readonly auth?: AuthContext;
  readonly progress: ProgressTracker;
  readonly toolCallResults: LLMToolCall[] = [];
  readonly turns: TurnResult[] = [];
  selectedAgentName?: string;
  readonly metadata: Map<string, unknown> = new Map();

  constructor(options: AgentContextOptions) {
    this.history = options.history;
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.auth = options.auth;
    this.progress = options.progress ?? new ProgressTrackerImpl();
    this.selectedAgentName = options.selectedAgentName;
    if (options.auth) {
      this.metadata.set("auth", options.auth);
    }
  }

  collectToolResults<T>(schema: ZodType<T>): T[] {
    const results: T[] = [];
    for (const tc of this.toolCallResults) {
      if (!tc.result || tc.result.isError) continue;
      try {
        const parsed = JSON.parse(tc.result.content);
        results.push(schema.parse(parsed));
      } catch {
        // Skip results that don't match the schema
      }
    }
    return results;
  }
}
