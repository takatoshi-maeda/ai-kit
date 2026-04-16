import type { DataStorage } from "../../storage/storage.js";
import {
  assembleConversation,
  summarizeConversation,
  type ConversationRecord,
  type ConversationMetaRecord,
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

interface StoredConversationMeta extends ConversationMetaRecord {
  createdAt: string;
  updatedAt: string;
}

interface StoredRunState extends RunState {
  metadata?: RunState["metadata"];
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

  private conversationMetaPath(sessionId: string, agentId?: string): string {
    if (!agentId) {
      return `${CONVERSATIONS_DIR}/${sessionId}.meta.json`;
    }
    return `${CONVERSATIONS_DIR}/${encodeURIComponent(agentId)}/${sessionId}.meta.json`;
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
    const meta = await this.readConversationMeta(sessionId, agentId);
    const records = raw ? parseJsonl<ConversationRecord>(raw) : [];
    const latestRunState = await this.readLatestRunState(sessionId, agentId);
    if (records.length === 0 && !latestRunState && !meta) return null;
    return assembleConversation(sessionId, records, {
      title: meta?.title,
      agentId: agentId ?? meta?.agentId,
      agentName: meta?.agentName,
      latestRunState,
      createdAt: meta?.createdAt,
      updatedAt: meta?.updatedAt,
    });
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
    const metaExists = await this.storage.stat(this.conversationMetaPath(sessionId, agentId));
    const runStateIds = await this.listRunStateIds(sessionId, agentId);
    if (!exists && !metaExists && runStateIds.length === 0) return false;
    if (exists) {
      await this.storage.deleteFile(this.conversationPath(sessionId, agentId));
    }
    if (metaExists) {
      await this.storage.deleteFile(this.conversationMetaPath(sessionId, agentId));
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
    await this.writeConversationMeta(sessionId, conversationAgentId, {
      title,
      agentId: conversationAgentId,
      agentName: turn.agentName,
      timestamp,
    });

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
    await this.writeConversationMeta(sessionId, conversationAgentId, {
      agentId: conversationAgentId,
      agentName: state.agentName,
      timestamp: new Date().toISOString(),
    });

    await this.storage.writeText(
      this.runStatePath(sessionId, state.runId, conversationAgentId),
      JSON.stringify(state satisfies StoredRunState),
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
      return uniqueConversationCandidates(files
        .filter((file) => file.endsWith(".jsonl") || file.endsWith(".meta.json"))
        .map((file) => ({ sessionId: toSessionIdFromConversationFile(file), agentId })));
    }

    const entries = await this.storage.listFiles(CONVERSATIONS_DIR);
    const candidates: Array<{ sessionId: string; agentId?: string }> = [];
    for (const entry of entries) {
      if (entry.endsWith(".jsonl") || entry.endsWith(".meta.json")) {
        candidates.push({ sessionId: toSessionIdFromConversationFile(entry) });
        continue;
      }
      const nestedFiles = await this.storage.listFiles(`${CONVERSATIONS_DIR}/${entry}`);
      for (const file of nestedFiles) {
        if (!file.endsWith(".jsonl") && !file.endsWith(".meta.json")) {
          continue;
        }
        candidates.push({
          sessionId: toSessionIdFromConversationFile(file),
          agentId: decodeURIComponent(entry),
        });
      }
    }
    return uniqueConversationCandidates(candidates);
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
      const parsed = JSON.parse(raw) as StoredRunState;
      if (!latest || parsed.updatedAt.localeCompare(latest.updatedAt) > 0) {
        latest = parsed;
      }
    }
    return latest;
  }

  private async readConversationMeta(
    sessionId: string,
    agentId?: string,
  ): Promise<StoredConversationMeta | undefined> {
    const raw = await this.storage.readText(this.conversationMetaPath(sessionId, agentId));
    if (!raw) {
      return undefined;
    }
    return JSON.parse(raw) as StoredConversationMeta;
  }

  private async writeConversationMeta(
    sessionId: string,
    agentId: string | undefined,
    options: {
      title?: string;
      agentId?: string;
      agentName?: string;
      timestamp: string;
    },
  ): Promise<void> {
    const existing = await this.readConversationMeta(sessionId, agentId);
    const next: StoredConversationMeta = {
      title: options.title ?? existing?.title,
      agentId: options.agentId ?? existing?.agentId,
      agentName: options.agentName ?? existing?.agentName,
      createdAt: existing?.createdAt ?? options.timestamp,
      updatedAt: options.timestamp,
    };
    await this.storage.writeText(
      this.conversationMetaPath(sessionId, agentId),
      JSON.stringify(next),
    );
  }
}

function parseJsonl<T>(raw: string): T[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function toSessionIdFromConversationFile(file: string): string {
  return file.replace(/\.meta\.json$/u, "").replace(/\.jsonl$/u, "");
}

function uniqueConversationCandidates(
  candidates: Array<{ sessionId: string; agentId?: string }>,
): Array<{ sessionId: string; agentId?: string }> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.agentId ?? ""}:${candidate.sessionId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
