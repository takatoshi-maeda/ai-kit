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
import {
  createSupabaseBackendClient,
  formatSupabaseError,
  type SupabaseClientLike,
} from "../supabase/client.js";

interface ConversationRow {
  id?: number;
  app_name: string;
  agent_id: string | null;
  agent_name: string | null;
  session_id: string;
  agent_scope: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationEventRow {
  id?: number;
  conversation_id: number;
  event_type: ConversationRecord["type"];
  event_timestamp: string;
  data: ConversationRecord["data"];
  created_at: string;
}

interface InputHistoryRow {
  id?: number;
  app_name: string;
  agent_id: string | null;
  agent_name: string | null;
  session_id: string | null;
  entry: string;
  run_id: string | null;
  created_at: string;
}

interface UsageEntryRow {
  id?: number;
  app_name: string;
  agent_id: string | null;
  agent_name: string | null;
  session_id: string | null;
  amount: number;
  currency: string;
  run_id: string | null;
  created_at: string;
}

interface IdempotencyRow {
  id?: number;
  app_name: string;
  agent_id: string | null;
  session_id: string;
  idempotency_key: string;
  run_id: string;
  status: string;
  result: Record<string, unknown>;
  created_at: string;
}

export interface SupabasePersistenceOptions {
  appName: string;
  url?: string;
  serviceRoleKey?: string;
  schema?: string;
  tablePrefix?: string;
  client?: SupabaseClientLike;
}

export class SupabasePersistence implements AgentPersistence {
  private readonly client: SupabaseClientLike;
  private readonly appName: string;
  private readonly tablePrefix: string;

  constructor(options: SupabasePersistenceOptions) {
    this.appName = options.appName;
    this.tablePrefix = options.tablePrefix ?? "agent_";
    this.client = options.client ?? createSupabaseBackendClient({
      url: requiredOption(options.url, "url"),
      serviceRoleKey: requiredOption(options.serviceRoleKey, "serviceRoleKey"),
      schema: options.schema,
    });
  }

  async readConversation(sessionId: string, agentId?: string): Promise<Conversation | null> {
    const conversation = await this.findConversation(sessionId, agentId);
    if (!conversation) {
      return null;
    }

    const { data, error } = await this.client
      .from<ConversationEventRow>(this.tableName("conversation_events"))
      .select("event_type,event_timestamp,data")
      .eq("conversation_id", conversation.id)
      .order("id", { ascending: true });
    if (error) {
      throw new Error(formatSupabaseError(error));
    }

    const records = asArray<ConversationEventRow>(data).map<ConversationRecord>((row) => ({
      type: row.event_type,
      data: row.data,
      timestamp: row.event_timestamp,
    }));
    return assembleConversation(sessionId, records, agentId);
  }

  async listConversationSummaries(
    limit?: number,
    agentId?: string,
  ): Promise<ConversationSummary[]> {
    let query = this.client
      .from<ConversationRow>(this.tableName("conversations"))
      .select("session_id,agent_id,updated_at")
      .eq("app_name", this.appName)
      .order("updated_at", { ascending: false });

    if (agentId) {
      query = query.eq("agent_scope", toAgentScope(agentId));
    }
    if (typeof limit === "number") {
      query = query.limit(limit);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(formatSupabaseError(error));
    }

    const summaries: ConversationSummary[] = [];
    for (const row of asArray<ConversationRow>(data)) {
      const conversation = await this.readConversation(row.session_id, row.agent_id ?? undefined);
      if (conversation) {
        summaries.push(summarizeConversation(conversation));
      }
    }
    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return summaries;
  }

  async deleteConversation(sessionId: string, agentId?: string): Promise<boolean> {
    const { data, error } = await this.client
      .from<ConversationRow>(this.tableName("conversations"))
      .delete()
      .eq("app_name", this.appName)
      .eq("session_id", sessionId)
      .eq("agent_scope", toAgentScope(agentId))
      .select("id");
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
    return asArray<ConversationRow>(data).length > 0;
  }

  async appendConversationTurn(
    sessionId: string,
    turn: ConversationTurn,
    title?: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const conversationId = await this.ensureConversation(sessionId, turn.agentId, {
      title,
      agentName: turn.agentName,
      updatedAt: timestamp,
    });

    if (title || turn.agentId || turn.agentName) {
      await this.insertEvent(conversationId, {
        type: "meta",
        data: {
          ...(title ? { title } : {}),
          ...(turn.agentId ? { agentId: turn.agentId } : {}),
          ...(turn.agentName ? { agentName: turn.agentName } : {}),
        },
        timestamp,
      });
    }

    await this.insertEvent(conversationId, {
      type: "turn",
      data: turn,
      timestamp,
    });
  }

  async appendRunState(sessionId: string, state: RunState): Promise<void> {
    const timestamp = new Date().toISOString();
    const existingConversation = await this.findConversation(sessionId, state.agentId);
    if (
      existingConversation?.agent_id &&
      state.agentId &&
      existingConversation.agent_id !== state.agentId
    ) {
      throw new Error(`Conversation agent mismatch for session "${sessionId}"`);
    }

    const conversationId = await this.ensureConversation(sessionId, state.agentId, {
      agentName: state.agentName,
      updatedAt: timestamp,
    });

    if (!existingConversation && (state.agentId || state.agentName)) {
      await this.insertEvent(conversationId, {
        type: "meta",
        data: {
          ...(state.agentId ? { agentId: state.agentId } : {}),
          ...(state.agentName ? { agentName: state.agentName } : {}),
        },
        timestamp,
      });
    }

    await this.insertEvent(conversationId, {
      type: "run_state",
      data: state,
      timestamp,
    });
  }

  async appendInputMessageHistory(
    entry: string,
    sessionId?: string,
    runId?: string,
  ): Promise<void> {
    const { error } = await this.client
      .from<InputHistoryRow>(this.tableName("input_history"))
      .insert({
        app_name: this.appName,
        agent_id: null,
        agent_name: null,
        session_id: sessionId ?? null,
        entry,
        run_id: runId ?? null,
        created_at: new Date().toISOString(),
      });
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
  }

  async listInputMessageHistory(): Promise<string[]> {
    const { data, error } = await this.client
      .from<InputHistoryRow>(this.tableName("input_history"))
      .select("entry")
      .eq("app_name", this.appName)
      .order("id", { ascending: true });
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
    return asArray<InputHistoryRow>(data).map((row) => row.entry);
  }

  async appendUsage(
    amount: number,
    currency: string,
    sessionId?: string,
    runId?: string,
  ): Promise<void> {
    const { error } = await this.client
      .from<UsageEntryRow>(this.tableName("usage_entries"))
      .insert({
        app_name: this.appName,
        agent_id: null,
        agent_name: null,
        session_id: sessionId ?? null,
        amount,
        currency,
        run_id: runId ?? null,
        created_at: new Date().toISOString(),
      });
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
  }

  async summarizeUsage(period?: string): Promise<McpUsageSummary | null> {
    const { data, error } = await this.client
      .from<UsageEntryRow>(this.tableName("usage_entries"))
      .select("amount,currency,created_at")
      .eq("app_name", this.appName)
      .order("id", { ascending: true });
    if (error) {
      throw new Error(formatSupabaseError(error));
    }

    const entries = asArray<UsageEntryRow>(data);
    if (entries.length === 0) {
      return null;
    }

    const filtered = period
      ? entries.filter((entry) => entry.created_at.startsWith(period))
      : entries;

    const totalByCurrency: Record<string, number> = {};
    let totalUsd = 0;
    for (const entry of filtered) {
      totalByCurrency[entry.currency] =
        (totalByCurrency[entry.currency] ?? 0) + Number(entry.amount);
      if (entry.currency === "usd") {
        totalUsd += Number(entry.amount);
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
    const { data, error } = await this.client
      .from<IdempotencyRow>(this.tableName("idempotency_records"))
      .select("idempotency_key,session_id,run_id,status,result,agent_id,created_at")
      .eq("app_name", this.appName)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
    if (!data || Array.isArray(data)) {
      return null;
    }

    return {
      idempotencyKey: data.idempotency_key,
      sessionId: data.session_id,
      runId: data.run_id,
      status: data.status,
      result: data.result,
      agentId: data.agent_id ?? undefined,
      createdAt: data.created_at,
    };
  }

  async writeIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    const { error } = await this.client
      .from<IdempotencyRow>(this.tableName("idempotency_records"))
      .upsert(
        {
          app_name: this.appName,
          agent_id: record.agentId ?? null,
          session_id: record.sessionId,
          idempotency_key: record.idempotencyKey,
          run_id: record.runId,
          status: record.status,
          result: record.result,
          created_at: record.createdAt,
        },
        {
          onConflict: "app_name,idempotency_key",
          ignoreDuplicates: false,
        },
      );
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
  }

  async checkHealth(): Promise<{ ok: boolean; error?: string; driver?: string }> {
    try {
      const { error } = await this.client
        .from<ConversationRow>(this.tableName("conversations"))
        .select("id")
        .eq("app_name", this.appName)
        .limit(1);
      if (error) {
        throw new Error(formatSupabaseError(error));
      }
      return { ok: true, driver: "supabase" };
    } catch (error) {
      return {
        ok: false,
        driver: "supabase",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureConversation(
    sessionId: string,
    agentId: string | undefined,
    options: {
      title?: string;
      agentName?: string;
      updatedAt: string;
    },
  ): Promise<number> {
    const existingConversation = await this.findConversation(sessionId, agentId);
    if (
      existingConversation?.agent_id &&
      agentId &&
      existingConversation.agent_id !== agentId
    ) {
      throw new Error(`Conversation agent mismatch for session "${sessionId}"`);
    }

    const row = {
      app_name: this.appName,
      session_id: sessionId,
      agent_scope: toAgentScope(agentId),
      agent_id: agentId ?? null,
      agent_name: options.agentName ?? existingConversation?.agent_name ?? null,
      title: options.title ?? existingConversation?.title ?? null,
      updated_at: options.updatedAt,
      created_at: existingConversation?.created_at ?? options.updatedAt,
    };

    const { data, error } = await this.client
      .from<ConversationRow>(this.tableName("conversations"))
      .upsert(row, {
        onConflict: "app_name,session_id,agent_scope",
        ignoreDuplicates: false,
      })
      .select("id")
      .single();
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
    if (!data || Array.isArray(data)) {
      throw new Error("Supabase conversation upsert did not return a row");
    }
    if (typeof data.id !== "number") {
      throw new Error("Supabase conversation upsert did not return an id");
    }
    return data.id;
  }

  private async insertEvent(
    conversationId: number,
    record: ConversationRecord,
  ): Promise<void> {
    const { error } = await this.client
      .from<ConversationEventRow>(this.tableName("conversation_events"))
      .insert({
        conversation_id: conversationId,
        event_type: record.type,
        event_timestamp: record.timestamp,
        data: record.data,
        created_at: record.timestamp,
      });
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
  }

  private async findConversation(
    sessionId: string,
    agentId?: string,
  ): Promise<ConversationRow | null> {
    const { data, error } = await this.client
      .from<ConversationRow>(this.tableName("conversations"))
      .select("*")
      .eq("app_name", this.appName)
      .eq("session_id", sessionId)
      .eq("agent_scope", toAgentScope(agentId))
      .maybeSingle();
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
    if (!data || Array.isArray(data)) {
      return null;
    }
    return data;
  }

  private tableName(name: string): string {
    return `${this.tablePrefix}${name}`;
  }
}

function requiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Supabase persistence requires ${name}`);
}

function toAgentScope(agentId?: string): string {
  return agentId ?? "";
}

function asArray<T>(value: T[] | T | null): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value ? [value] : [];
}
