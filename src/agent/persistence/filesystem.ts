import type { DataStorage } from "../../storage/storage.js";
import {
  assembleConversation,
  summarizeConversation,
  type ConversationRecord,
} from "./conversation-assembler.js";
import type {
  AgentPersistence,
  Conversation,
  ConversationSummary,
  ConversationTurn,
  IdempotencyRecord,
  McpUsageSummary,
  RunState,
} from "./types.js";

const CONVERSATIONS_DIR = "conversations";
const RUN_STATES_DIR = "run-states";
const USAGE_FILE = "usage.jsonl";
const INPUT_HISTORY_FILE = "input-history.jsonl";
const IDEMPOTENCY_DIR = "idempotency";

interface UsageEntry {
  amount: number;
  currency: string;
  sessionId?: string;
  runId?: string;
  timestamp: string;
}

/**
 * JSONL ファイルベースの AgentPersistence 実装。
 * DataStorage 上に会話・使用量・冪等性レコードを JSONL 形式で保存する。
 */
export class FilesystemPersistence implements AgentPersistence {
  constructor(private readonly storage: DataStorage) {}

  private conversationPath(sessionId: string, agentId?: string): string {
    if (!agentId) {
      return `${CONVERSATIONS_DIR}/${sessionId}.jsonl`;
    }
    return `${CONVERSATIONS_DIR}/${encodeURIComponent(agentId)}/${sessionId}.jsonl`;
  }

  private runStateDir(sessionId: string, agentId?: string): string {
    if (!agentId) {
      return `${RUN_STATES_DIR}/${sessionId}`;
    }
    return `${RUN_STATES_DIR}/${encodeURIComponent(agentId)}/${sessionId}`;
  }

  private runStatePath(sessionId: string, runId: string, agentId?: string): string {
    return `${this.runStateDir(sessionId, agentId)}/${runId}.json`;
  }

  async readConversation(sessionId: string, agentId?: string): Promise<Conversation | null> {
    const raw = await this.storage.readText(this.conversationPath(sessionId, agentId));
    const records = raw ? parseJsonl<ConversationRecord>(raw) : [];
    const latestRunState = await this.readLatestRunState(sessionId, agentId);
    if (records.length === 0 && !latestRunState) return null;
    return assembleConversation(sessionId, records, latestRunState, agentId);
  }

  async listConversationSummaries(
    limit?: number,
    agentId?: string,
  ): Promise<ConversationSummary[]> {
    const candidates = await this.listConversationCandidates(agentId);
    const summaries: ConversationSummary[] = [];
    for (const candidate of candidates) {
      const conversation = await this.readConversation(candidate.sessionId, candidate.agentId);
      if (!conversation) continue;
      summaries.push(summarizeConversation(conversation));
    }

    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return typeof limit === "number" ? summaries.slice(0, limit) : summaries;
  }

  async deleteConversation(sessionId: string, agentId?: string): Promise<boolean> {
    const exists = await this.storage.stat(
      this.conversationPath(sessionId, agentId),
    );
    const runStateIds = await this.listRunStateIds(sessionId, agentId);
    if (!exists && runStateIds.length === 0) return false;
    if (exists) {
      await this.storage.deleteFile(this.conversationPath(sessionId, agentId));
    }
    for (const runId of runStateIds) {
      await this.storage.deleteFile(this.runStatePath(sessionId, runId, agentId));
    }
    return true;
  }

  async appendConversationTurn(
    sessionId: string,
    turn: ConversationTurn,
    title?: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const conversationAgentId = turn.agentId;
    const existingConversation = await this.readConversation(sessionId, conversationAgentId);

    if (existingConversation?.agentId && conversationAgentId && existingConversation.agentId !== conversationAgentId) {
      throw new Error(`Conversation agent mismatch for session "${sessionId}"`);
    }

    if (title || conversationAgentId || turn.agentName) {
      const metaRecord: ConversationRecord = {
        type: "meta",
        data: {
          ...(title ? { title } : {}),
          ...(conversationAgentId ? { agentId: conversationAgentId } : {}),
          ...(turn.agentName ? { agentName: turn.agentName } : {}),
        },
        timestamp,
      };
      await this.storage.appendText(
        this.conversationPath(sessionId, conversationAgentId),
        JSON.stringify(metaRecord) + "\n",
      );
    }

    const record: ConversationRecord = {
      type: "turn",
      data: turn,
      timestamp,
    };
    await this.storage.appendText(
      this.conversationPath(sessionId, conversationAgentId),
      JSON.stringify(record) + "\n",
    );
  }

  async appendRunState(sessionId: string, state: RunState): Promise<void> {
    const conversationAgentId = state.agentId;
    const existingConversation = await this.readConversation(sessionId, conversationAgentId);
    if (existingConversation?.agentId && conversationAgentId && existingConversation.agentId !== conversationAgentId) {
      throw new Error(`Conversation agent mismatch for session "${sessionId}"`);
    }

    if (!existingConversation && (conversationAgentId || state.agentName)) {
      const metaRecord: ConversationRecord = {
        type: "meta",
        data: {
          ...(conversationAgentId ? { agentId: conversationAgentId } : {}),
          ...(state.agentName ? { agentName: state.agentName } : {}),
        },
        timestamp: new Date().toISOString(),
      };
      await this.storage.appendText(
        this.conversationPath(sessionId, conversationAgentId),
        JSON.stringify(metaRecord) + "\n",
      );
    }

    await this.storage.writeText(
      this.runStatePath(sessionId, state.runId, conversationAgentId),
      JSON.stringify(state),
    );
  }

  async deleteRunState(sessionId: string, runId: string, agentId?: string): Promise<void> {
    const file = this.runStatePath(sessionId, runId, agentId);
    const exists = await this.storage.stat(file);
    if (!exists) return;
    await this.storage.deleteFile(file);
  }

  async appendInputMessageHistory(
    entry: string,
    _sessionId?: string,
    _runId?: string,
  ): Promise<void> {
    const record = { entry, timestamp: new Date().toISOString() };
    await this.storage.appendText(
      INPUT_HISTORY_FILE,
      JSON.stringify(record) + "\n",
    );
  }

  async listInputMessageHistory(): Promise<string[]> {
    const raw = await this.storage.readText(INPUT_HISTORY_FILE);
    if (!raw) return [];
    return parseJsonl<{ entry: string }>(raw).map((r) => r.entry);
  }

  async appendUsage(
    amount: number,
    currency: string,
    sessionId?: string,
    runId?: string,
  ): Promise<void> {
    const entry: UsageEntry = {
      amount,
      currency,
      sessionId,
      runId,
      timestamp: new Date().toISOString(),
    };
    await this.storage.appendText(
      USAGE_FILE,
      JSON.stringify(entry) + "\n",
    );
  }

  async summarizeUsage(
    period?: string,
  ): Promise<McpUsageSummary | null> {
    const raw = await this.storage.readText(USAGE_FILE);
    if (!raw) return null;

    const entries = parseJsonl<UsageEntry>(raw);
    if (entries.length === 0) return null;

    const filtered = period
      ? entries.filter((e) => e.timestamp.startsWith(period))
      : entries;

    const totalByCurrency: Record<string, number> = {};
    let totalUsd = 0;

    for (const entry of filtered) {
      totalByCurrency[entry.currency] =
        (totalByCurrency[entry.currency] ?? 0) + entry.amount;
      if (entry.currency === "usd") {
        totalUsd += entry.amount;
      }
    }

    return {
      period: period ?? "all",
      cost: { totalUsd, totalByCurrency },
    };
  }

  async readIdempotencyRecord(
    key: string,
    _sessionId?: string,
    _agentId?: string,
  ): Promise<IdempotencyRecord | null> {
    const raw = await this.storage.readText(
      `${IDEMPOTENCY_DIR}/${key}.json`,
    );
    if (!raw) return null;
    return JSON.parse(raw) as IdempotencyRecord;
  }

  async writeIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    await this.storage.writeText(
      `${IDEMPOTENCY_DIR}/${record.idempotencyKey}.json`,
      JSON.stringify(record),
    );
  }

  async checkHealth(): Promise<{ ok: boolean; error?: string; driver?: string }> {
    try {
      const testPath = "_health_check_test";
      await this.storage.writeText(testPath, "ok");
      const result = await this.storage.readText(testPath);
      await this.storage.deleteFile(testPath);
      return { ok: result === "ok", driver: "filesystem" };
    } catch (err) {
      return {
        ok: false,
        driver: "filesystem",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async listConversationCandidates(
    agentId?: string,
  ): Promise<Array<{ sessionId: string; agentId?: string }>> {
    if (agentId) {
      const files = await this.storage.listFiles(`${CONVERSATIONS_DIR}/${encodeURIComponent(agentId)}`);
      return files
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => ({ sessionId: file.replace(/\.jsonl$/u, ""), agentId }));
    }

    const entries = await this.storage.listFiles(CONVERSATIONS_DIR);
    const candidates: Array<{ sessionId: string; agentId?: string }> = [];
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) {
        candidates.push({ sessionId: entry.replace(/\.jsonl$/u, "") });
        continue;
      }
      const nestedFiles = await this.storage.listFiles(`${CONVERSATIONS_DIR}/${entry}`);
      for (const file of nestedFiles) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }
        candidates.push({
          sessionId: file.replace(/\.jsonl$/u, ""),
          agentId: decodeURIComponent(entry),
        });
      }
    }
    return candidates;
  }

  private async listRunStateIds(sessionId: string, agentId?: string): Promise<string[]> {
    const entries = await this.storage.listFiles(this.runStateDir(sessionId, agentId));
    return entries
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/u, ""));
  }

  private async readLatestRunState(sessionId: string, agentId?: string): Promise<RunState | undefined> {
    const runIds = await this.listRunStateIds(sessionId, agentId);
    let latest: RunState | undefined;
    for (const runId of runIds) {
      const raw = await this.storage.readText(this.runStatePath(sessionId, runId, agentId));
      if (!raw) continue;
      const parsed = JSON.parse(raw) as RunState;
      if (!latest || parsed.updatedAt.localeCompare(latest.updatedAt) > 0) {
        latest = parsed;
      }
    }
    return latest;
  }
}

function parseJsonl<T>(raw: string): T[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
