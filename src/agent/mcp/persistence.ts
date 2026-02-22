import type { AgentContext } from "../../types/agent.js";
import type { ConversationalAgent } from "../conversational.js";

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
      status: "running" | "completed";
      argumentLines?: string[];
    }
  | {
      kind: "text";
      id: string;
      text: string;
      startedAt: number;
      updatedAt: number;
      completedAt?: number;
      durationSeconds?: number;
    };

/** 会話ターン */
export interface ConversationTurn {
  turnId: string;
  runId: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  status: "success" | "error" | "cancelled";
  errorMessage?: string;
  timeline?: TimelineItem[];
  agentId?: string;
  agentName?: string;
}

/** 会話全体 */
export interface Conversation {
  sessionId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  agentName?: string;
  status: "idle" | "progress";
  inProgress?: {
    runId: string;
    turnId?: string;
    startedAt: string;
    updatedAt: string;
    userMessage?: string;
    assistantMessage?: string;
    timeline?: TimelineItem[];
    agentId?: string;
    agentName?: string;
  };
  turns: ConversationTurn[];
}

/** 会話サマリー（一覧用） */
export interface ConversationSummary {
  sessionId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "progress";
  activeRunId?: string;
  activeUpdatedAt?: string;
  turnCount: number;
  latestUserMessage?: string;
}

/** 使用量サマリー */
export interface McpUsageSummary {
  period: string;
  cost: { totalUsd: number; totalByCurrency: Record<string, number> };
}

/** 冪等性レコード */
export interface IdempotencyRecord {
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
  assistantMessage?: string;
  timeline?: TimelineItem[];
  agentId?: string;
  agentName?: string;
}

/**
 * MCP 永続化インターフェース。
 * JSONL ファイル / Supabase / DynamoDB など任意のバックエンドで実装可能。
 */
export interface McpPersistence {
  /** 会話 */
  readConversation(sessionId: string): Promise<Conversation | null>;
  listConversationSummaries(limit?: number): Promise<ConversationSummary[]>;
  deleteConversation(sessionId: string): Promise<boolean>;
  appendConversationTurn(
    sessionId: string,
    turn: ConversationTurn,
    title?: string,
  ): Promise<void>;
  appendRunState(sessionId: string, state: RunState): Promise<void>;

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
  checkHealth(): Promise<{ ok: boolean; error?: string }>;
}
