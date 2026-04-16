import {
  assembleConversation,
  summarizeConversation,
  type ConversationRecord,
} from "./conversation-assembler.js";
import type {
  AgentPersistence,
  AgentSessionState,
  Conversation,
  ConversationSummary,
  ConversationTurn,
  IdempotencyRecord,
  McpUsageSummary,
  RunState,
} from "./types.js";
import {
  createPostgresClient,
  formatPostgresError,
  type PostgresSqlLike,
} from "../postgres/client.js";

interface ConversationRow extends Record<string, unknown> {
  id: number;
  app_name: string;
  user_id: string;
  agent_id: string | null;
  agent_name: string | null;
  session_id: string;
  agent_scope: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationEventRow extends Record<string, unknown> {
  id?: number;
  conversation_id: number;
  event_type: ConversationRecord["type"];
  event_timestamp: string;
  data: ConversationRecord["data"];
  created_at: string;
}

interface ConversationRunStateRow extends Record<string, unknown> {
  conversation_id: number;
  run_id: string;
  turn_id: string | null;
  status: string;
  started_at: string;
  updated_at: string;
  user_message: string | null;
  user_content: RunState["userContent"] | null;
  assistant_message: string | null;
  timeline: RunState["timeline"] | null;
  metadata: RunState["metadata"] | null;
  agent_id: string | null;
  agent_name: string | null;
  created_at: string;
}

interface InputHistoryRow extends Record<string, unknown> {
  entry: string;
}

interface UsageEntryRow extends Record<string, unknown> {
  amount: number;
  currency: string;
  created_at: string;
}

interface IdempotencyRow extends Record<string, unknown> {
  user_id: string;
  idempotency_key: string;
  session_id: string;
  run_id: string;
  status: string;
  result: Record<string, unknown>;
  agent_id: string | null;
  created_at: string;
}

export interface PostgresPersistenceOptions {
  appName: string;
  userId: string;
  connectionString?: string;
  schema?: string;
  tablePrefix?: string;
  sql?: PostgresSqlLike;
}

export class PostgresPersistence implements AgentPersistence {
  private readonly sql: PostgresSqlLike;
  private readonly appName: string;
  private readonly userId: string;
  private readonly schema: string;
  private readonly tablePrefix: string;
  private readonly ownsClient: boolean;

  constructor(options: PostgresPersistenceOptions) {
    this.appName = options.appName;
    this.userId = options.userId;
    this.schema = options.schema ?? "public";
    this.tablePrefix = options.tablePrefix ?? "ai_kit_";
    this.ownsClient = !options.sql;
    this.sql = options.sql ?? createPostgresClient({
      connectionString: requiredOption(options.connectionString, "connectionString"),
    });
  }

  async close(): Promise<void> {
    if (!this.ownsClient) {
      return;
    }
    await this.sql.end?.({ timeout: 0 });
  }

  async readConversation(sessionId: string, agentId?: string): Promise<Conversation | null> {
    const conversation = await this.findConversation(this.sql, sessionId, agentId);
    if (!conversation) {
      return null;
    }

    const rows = await this.query<ConversationEventRow>(
      this.sql,
      `
        select event_type, event_timestamp, data
        from ${this.table("conversation_events")}
        where conversation_id = $1
          and event_type = 'turn'
        order by id asc
      `,
      [conversation.id],
    );
    const runStateRows = await this.query<ConversationRunStateRow>(
      this.sql,
      `
        select *
        from ${this.table("conversation_run_states")}
        where conversation_id = $1
        order by updated_at desc
        limit 1
      `,
      [conversation.id],
    );

    const records = rows.map<ConversationRecord>((row) => ({
      type: row.event_type,
      data: row.data,
      timestamp: normalizeTimestamp(row.event_timestamp),
    }));
    return assembleConversation(sessionId, records, {
      title: conversation.title ?? undefined,
      agentId: conversation.agent_id ?? agentId,
      agentName: conversation.agent_name ?? undefined,
      latestRunState: toRunState(runStateRows[0]),
      createdAt: normalizeTimestamp(conversation.created_at),
      updatedAt: normalizeTimestamp(conversation.updated_at),
    });
  }

  async listConversationSummaries(
    limit?: number,
    agentId?: string,
  ): Promise<ConversationSummary[]> {
    const params: unknown[] = [this.appName, this.userId];
    let query = `
      select session_id, agent_id, updated_at
      from ${this.table("conversations")}
      where app_name = $1
        and user_id = $2
    `;
    if (agentId) {
      params.push(toAgentScope(agentId));
      query += ` and agent_scope = $${params.length}`;
    }
    query += " order by updated_at desc";
    if (typeof limit === "number") {
      params.push(limit);
      query += ` limit $${params.length}`;
    }

    const rows = await this.query<ConversationRow>(this.sql, query, params);
    const summaries: ConversationSummary[] = [];
    for (const row of rows) {
      const conversation = await this.readConversation(row.session_id, row.agent_id ?? undefined);
      if (conversation) {
        summaries.push(summarizeConversation(conversation));
      }
    }
    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return summaries;
  }

  async deleteConversation(sessionId: string, agentId?: string): Promise<boolean> {
    const rows = await this.query<{ id: number }>(
      this.sql,
      `
        delete from ${this.table("conversations")}
        where app_name = $1
          and user_id = $2
          and session_id = $3
          and agent_scope = $4
        returning id
      `,
      [this.appName, this.userId, sessionId, toAgentScope(agentId)],
    );
    return rows.length > 0;
  }

  async appendConversationTurn(
    sessionId: string,
    turn: ConversationTurn,
    title?: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.sql.begin(async (tx) => {
      const conversationId = await this.ensureConversation(tx, sessionId, turn.agentId, {
        title,
        agentName: turn.agentName,
        updatedAt: timestamp,
      });

      await this.insertEvent(tx, conversationId, {
        type: "turn",
        data: turn,
        timestamp,
      });
    });
  }

  async appendSessionState(
    sessionId: string,
    sessionState: AgentSessionState,
    options?: {
      agentId?: string;
      agentName?: string;
      title?: string;
    },
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.sql.begin(async (tx) => {
      const conversationId = await this.ensureConversation(tx, sessionId, options?.agentId, {
        title: options?.title,
        agentName: options?.agentName,
        updatedAt: timestamp,
      });

      await this.insertEvent(tx, conversationId, {
        type: "state",
        data: { sessionState },
        timestamp,
      });
    });
  }

  async appendRunState(sessionId: string, state: RunState): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.sql.begin(async (tx) => {
      const existingConversation = await this.findConversation(tx, sessionId, state.agentId);
      if (
        existingConversation?.agent_id &&
        state.agentId &&
        existingConversation.agent_id !== state.agentId
      ) {
        throw new Error(`Conversation agent mismatch for session "${sessionId}"`);
      }

      const conversationId = await this.ensureConversation(tx, sessionId, state.agentId, {
        agentName: state.agentName,
        updatedAt: timestamp,
      });

      await this.upsertRunStateRecord(tx, conversationId, state, timestamp);
    });
  }

  async deleteRunState(sessionId: string, runId: string, agentId?: string): Promise<void> {
    const conversation = await this.findConversation(this.sql, sessionId, agentId);
    if (!conversation) {
      return;
    }
    await this.query(
      this.sql,
      `
        delete from ${this.table("conversation_run_states")}
        where conversation_id = $1
          and run_id = $2
      `,
      [conversation.id, runId],
    );
  }

  async appendInputMessageHistory(
    entry: string,
    sessionId?: string,
    runId?: string,
  ): Promise<void> {
    await this.query(
      this.sql,
      `
        insert into ${this.table("input_history")} (
          app_name, user_id, agent_id, agent_name, session_id, entry, run_id, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [this.appName, this.userId, null, null, sessionId ?? null, entry, runId ?? null, new Date().toISOString()],
    );
  }

  async listInputMessageHistory(): Promise<string[]> {
    const rows = await this.query<InputHistoryRow>(
      this.sql,
      `
        select entry
        from ${this.table("input_history")}
        where app_name = $1
          and user_id = $2
        order by id asc
      `,
      [this.appName, this.userId],
    );
    return rows.map((row) => row.entry);
  }

  async appendUsage(
    amount: number,
    currency: string,
    sessionId?: string,
    runId?: string,
  ): Promise<void> {
    await this.query(
      this.sql,
      `
        insert into ${this.table("usage_entries")} (
          app_name, user_id, agent_id, agent_name, session_id, amount, currency, run_id, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        this.appName,
        this.userId,
        null,
        null,
        sessionId ?? null,
        amount,
        currency,
        runId ?? null,
        new Date().toISOString(),
      ],
    );
  }

  async summarizeUsage(period?: string): Promise<McpUsageSummary | null> {
    const rows = await this.query<UsageEntryRow>(
      this.sql,
      `
        select amount, currency, created_at
        from ${this.table("usage_entries")}
        where app_name = $1
          and user_id = $2
        order by id asc
      `,
      [this.appName, this.userId],
    );
    if (rows.length === 0) {
      return null;
    }

    const filtered = period
      ? rows.filter((entry) => normalizeTimestamp(entry.created_at).startsWith(period))
      : rows;

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
    const rows = await this.query<IdempotencyRow>(
      this.sql,
      `
        select idempotency_key, user_id, session_id, run_id, status, result, agent_id, created_at
        from ${this.table("idempotency_records")}
        where app_name = $1
          and user_id = $2
          and idempotency_key = $3
        limit 1
      `,
      [this.appName, this.userId, key],
    );
    const data = rows[0];
    if (!data) {
      return null;
    }

    return {
      idempotencyKey: data.idempotency_key,
      sessionId: data.session_id,
      runId: data.run_id,
      status: data.status,
      result: data.result,
      userId: data.user_id,
      agentId: data.agent_id ?? undefined,
      createdAt: normalizeTimestamp(data.created_at),
    };
  }

  async writeIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    await this.query(
      this.sql,
      `
        insert into ${this.table("idempotency_records")} (
          app_name, user_id, agent_id, session_id, idempotency_key, run_id, status, result, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (app_name, user_id, idempotency_key)
        do update set
          user_id = excluded.user_id,
          agent_id = excluded.agent_id,
          session_id = excluded.session_id,
          run_id = excluded.run_id,
          status = excluded.status,
          result = excluded.result,
          created_at = excluded.created_at
      `,
      [
        this.appName,
        this.userId,
        record.agentId ?? null,
        record.sessionId,
        record.idempotencyKey,
        record.runId,
        record.status,
        record.result,
        record.createdAt,
      ],
    );
  }

  async checkHealth(): Promise<{ ok: boolean; error?: string; driver?: string }> {
    try {
      await this.query(
        this.sql,
        `
          select id
          from ${this.table("conversations")}
          where app_name = $1
            and user_id = $2
          limit 1
        `,
        [this.appName, this.userId],
      );
      return { ok: true, driver: "postgres" };
    } catch (error) {
      return {
        ok: false,
        driver: "postgres",
        error: formatPostgresError(error),
      };
    }
  }

  private async ensureConversation(
    sql: PostgresSqlLike,
    sessionId: string,
    agentId: string | undefined,
    options: {
      title?: string;
      agentName?: string;
      updatedAt: string;
    },
  ): Promise<number> {
    const existingConversation = await this.findConversation(sql, sessionId, agentId);
    if (
      existingConversation?.agent_id &&
      agentId &&
      existingConversation.agent_id !== agentId
    ) {
      throw new Error(`Conversation agent mismatch for session "${sessionId}"`);
    }

    const rows = await this.query<{ id: number | string | bigint }>(
      sql,
      `
        insert into ${this.table("conversations")} (
          app_name, user_id, session_id, agent_scope, agent_id, agent_name, title, updated_at, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (app_name, user_id, session_id, agent_scope)
        do update set
          user_id = excluded.user_id,
          agent_id = excluded.agent_id,
          agent_name = excluded.agent_name,
          title = excluded.title,
          updated_at = excluded.updated_at
        returning id
      `,
      [
        this.appName,
        this.userId,
        sessionId,
        toAgentScope(agentId),
        agentId ?? null,
        options.agentName ?? existingConversation?.agent_name ?? null,
        options.title ?? existingConversation?.title ?? null,
        options.updatedAt,
        existingConversation?.created_at ?? options.updatedAt,
      ],
    );
    const row = rows[0];
    const id = normalizeNumericId(row?.id);
    if (id === null) {
      throw new Error("PostgreSQL conversation upsert did not return an id");
    }
    return id;
  }

  private async insertEvent(
    sql: PostgresSqlLike,
    conversationId: number,
    record: ConversationRecord,
  ): Promise<void> {
    await this.query(
      sql,
      `
        insert into ${this.table("conversation_events")} (
          conversation_id, event_type, event_timestamp, data, created_at
        ) values ($1, $2, $3, $4, $5)
      `,
      [conversationId, record.type, record.timestamp, record.data, record.timestamp],
    );
  }

  private async upsertRunStateRecord(
    sql: PostgresSqlLike,
    conversationId: number,
    state: RunState,
    timestamp: string,
  ): Promise<void> {
    await this.query(
      sql,
      `
        insert into ${this.table("conversation_run_states")} (
          conversation_id, run_id, turn_id, status, started_at, updated_at,
          user_message, user_content, assistant_message, timeline, metadata,
          agent_id, agent_name, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        on conflict (conversation_id, run_id)
        do update set
          turn_id = excluded.turn_id,
          status = excluded.status,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          user_message = excluded.user_message,
          user_content = excluded.user_content,
          assistant_message = excluded.assistant_message,
          timeline = excluded.timeline,
          metadata = excluded.metadata,
          agent_id = excluded.agent_id,
          agent_name = excluded.agent_name
      `,
      [
        conversationId,
        state.runId,
        state.turnId ?? null,
        state.status,
        state.startedAt,
        state.updatedAt,
        state.userMessage ?? null,
        state.userContent ?? null,
        state.assistantMessage ?? null,
        state.timeline ?? null,
        state.metadata ?? null,
        state.agentId ?? null,
        state.agentName ?? null,
        timestamp,
      ],
    );
  }

  private async findConversation(
    sql: PostgresSqlLike,
    sessionId: string,
    agentId?: string,
  ): Promise<ConversationRow | null> {
    const rows = await this.query<ConversationRow>(
      sql,
      `
        select *
        from ${this.table("conversations")}
        where app_name = $1
          and user_id = $2
          and session_id = $3
          and agent_scope = $4
        limit 1
      `,
      [this.appName, this.userId, sessionId, toAgentScope(agentId)],
    );
    return rows[0] ?? null;
  }

  private async query<Row extends Record<string, unknown>>(
    sql: PostgresSqlLike,
    query: string,
    params: unknown[] = [],
  ): Promise<Row[]> {
    try {
      return await sql.unsafe<Row>(query, params);
    } catch (error) {
      throw new Error(formatPostgresError(error));
    }
  }

  private table(name: string): string {
    return `${quoteIdentifier(this.schema)}.${quoteIdentifier(`${this.tablePrefix}${name}`)}`;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function requiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`PostgreSQL persistence requires ${name}`);
}

function toAgentScope(agentId?: string): string {
  return agentId ?? "";
}

function normalizeNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  return null;
}

function toRunState(row?: ConversationRunStateRow): RunState | undefined {
  if (!row) {
    return undefined;
  }
  return {
    runId: row.run_id,
    turnId: row.turn_id ?? undefined,
    status: row.status,
    startedAt: normalizeTimestamp(row.started_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    userMessage: row.user_message ?? undefined,
    userContent: row.user_content ?? undefined,
    assistantMessage: row.assistant_message ?? undefined,
    timeline: row.timeline ?? undefined,
    metadata: row.metadata ?? undefined,
    agentId: row.agent_id ?? undefined,
    agentName: row.agent_name ?? undefined,
  };
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new Error(`Unexpected PostgreSQL timestamp value: ${String(value)}`);
}
