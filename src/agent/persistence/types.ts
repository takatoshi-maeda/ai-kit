import type { ContentPart } from "../../types/llm.js";
import type { ResolvedAgentRuntime } from "../../types/runtime.js";
import type { SerializedUsageCostSessionState } from "../../llm/costs.js";

/** タイムラインアイテム（UI 用進捗表示） */
export type TimelineItem =
  | {
      kind: "reasoning";
      id: string;
      text: string;
      status: "running" | "completed";
    }
  | {
      kind: "tool-call";
      id: string;
      summary: string;
      status: "running" | "completed" | "failed";
      argumentLines?: string[];
      errorMessage?: string;
    }
  | {
      kind: "text";
      id: string;
      text: string;
      startedAt: number;
      updatedAt: number;
      completedAt?: number;
      durationSeconds?: number;
    }
  | {
      kind: "artifact";
      id: string;
      text: string;
      contentType: "artifact";
      status: "running" | "completed";
    };

/** 会話ターン */
export interface ConversationTurn {
  turnId: string;
  runId: string;
  responseId?: string;
  timestamp: string;
  userMessage: string;
  userContent?: string | ContentPart[];
  assistantMessage: string;
  status: "success" | "error" | "cancelled";
  errorMessage?: string;
  timeline?: TimelineItem[];
  agentId?: string;
  agentName?: string;
  runtime?: ResolvedAgentRuntime;
}

/** 会話全体 */
export interface Conversation {
  sessionId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  agentId?: string;
  agentName?: string;
  status: "idle" | "progress";
  inProgress?: {
    runId: string;
    turnId?: string;
    startedAt: string;
    updatedAt: string;
    userMessage?: string;
    userContent?: string | ContentPart[];
    assistantMessage?: string;
    timeline?: TimelineItem[];
    metadata?: {
      usageCostSession?: SerializedUsageCostSessionState;
    };
    agentId?: string;
    agentName?: string;
    runtime?: ResolvedAgentRuntime;
  };
  turns: ConversationTurn[];
  lastRuntime?: ResolvedAgentRuntime;
}

/** 会話サマリー（一覧用） */
export interface ConversationSummary {
  sessionId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  agentId?: string;
  status: "idle" | "progress";
  activeRunId?: string;
  activeUpdatedAt?: string;
  turnCount: number;
  latestUserMessage?: string;
  latestUserContent?: string | ContentPart[];
}

/** 使用量サマリー */
export interface McpUsageSummary {
  period: string;
  cost: { totalUsd: number; totalByCurrency: Record<string, number> };
}

/** 冪等性レコード */
export interface IdempotencyRecord {
  userId: string;
  idempotencyKey: string;
  sessionId: string;
  runId: string;
  status: string;
  result: Record<string, unknown>;
  agentId?: string;
  createdAt: string;
}

/** 実行状態 */
export interface RunState {
  runId: string;
  turnId?: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  userMessage?: string;
  userContent?: string | ContentPart[];
  assistantMessage?: string;
  timeline?: TimelineItem[];
  metadata?: {
    usageCostSession?: SerializedUsageCostSessionState;
  };
  agentId?: string;
  agentName?: string;
  runtime?: ResolvedAgentRuntime;
}

export interface PersistenceHealthResult {
  ok: boolean;
  error?: string;
  driver?: string;
}

/**
 * Agent 永続化インターフェース。
 * JSONL ファイル / Supabase / DynamoDB など任意のバックエンドで実装可能。
 */
export interface AgentPersistence {
  /** 会話 */
  readConversation(sessionId: string, agentId?: string): Promise<Conversation | null>;
  listConversationSummaries(limit?: number, agentId?: string): Promise<ConversationSummary[]>;
  deleteConversation(sessionId: string, agentId?: string): Promise<boolean>;
  appendConversationTurn(
    sessionId: string,
    turn: ConversationTurn,
    title?: string,
  ): Promise<void>;
  appendRunState(sessionId: string, state: RunState): Promise<void>;
  deleteRunState(sessionId: string, runId: string, agentId?: string): Promise<void>;

  /** 入力メッセージ履歴 */
  appendInputMessageHistory(
    entry: string,
    sessionId?: string,
    runId?: string,
  ): Promise<void>;
  listInputMessageHistory(): Promise<string[]>;

  /** 使用量 */
  appendUsage(
    amount: number,
    currency: string,
    sessionId?: string,
    runId?: string,
  ): Promise<void>;
  summarizeUsage(period?: string): Promise<McpUsageSummary | null>;

  /** 冪等性 */
  readIdempotencyRecord(
    key: string,
    sessionId?: string,
    agentId?: string,
  ): Promise<IdempotencyRecord | null>;
  writeIdempotencyRecord(record: IdempotencyRecord): Promise<void>;

  /** ヘルスチェック */
  checkHealth(): Promise<PersistenceHealthResult>;
}

/**
 * Backward-compatible alias kept under the existing MCP terminology.
 */
export type McpPersistence = AgentPersistence;
