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
  createPostgresClient,
  formatPostgresError,
  type PostgresSqlLike,
} from "../postgres/client.js";

interface ConversationRow extends Record<string, unknown> {
  id: number;
  app_name: string;
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

interface InputHistoryRow extends Record<string, unknown> {
  entry: string;
}

interface UsageEntryRow extends Record<string, unknown> {
  amount: number;
  currency: string;
  created_at: string;
}

interface IdempotencyRow extends Record<string, unknown> {
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
  connectionString?: string;
  schema?: string;
  tablePrefix?: string;
  sql?: PostgresSqlLike;
}

export class PostgresPersistence implements AgentPersistence {
  private readonly sql: PostgresSqlLike;
  private readonly appName: string;
  private readonly schema: string;
  private readonly tablePrefix: string;
  private readonly ownsClient: boolean;

  constructor(options: PostgresPersistenceOptions) {
    this.appName = options.appName;
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
        order by id asc
      `,
      [conversation.id],
    );

    const records = rows.map<ConversationRecord>((row) => ({
      type: row.event_type,
      data: row.data,
      timestamp: normalizeTimestamp(row.event_timestamp),
    }));
    return assembleConversation(sessionId, records, agentId);
  }

  async listConversationSummaries(
    limit?: number,
    agentId?: string,
  ): Promise<ConversationSummary[]> {
    const params: unknown[] = [this.appName];
    let query = `
      select session_id, agent_id, updated_at
      from ${this.table("conversations")}
      where app_name = $1
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
          and session_id = $2
          and agent_scope = $3
        returning id
      `,
      [this.appName, sessionId, toAgentScope(agentId)],
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

      if (title || turn.agentId || turn.agentName) {
        await this.insertEvent(tx, conversationId, {
          type: "meta",
          data: {
            ...(title ? { title } : {}),
            ...(turn.agentId ? { agentId: turn.agentId } : {}),
            ...(turn.agentName ? { agentName: turn.agentName } : {}),
          },
          timestamp,
        });
      }

      await this.insertEvent(tx, conversationId, {
        type: "turn",
        data: turn,
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

      if (!existingConversation && (state.agentId || state.agentName)) {
        await this.insertEvent(tx, conversationId, {
          type: "meta",
          data: {
            ...(state.agentId ? { agentId: state.agentId } : {}),
            ...(state.agentName ? { agentName: state.agentName } : {}),
          },
          timestamp,
        });
      }

      await this.insertEvent(tx, conversationId, {
        type: "run_state",
        data: state,
        timestamp,
      });
    });
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
          app_name, agent_id, agent_name, session_id, entry, run_id, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [this.appName, null, null, sessionId ?? null, entry, runId ?? null, new Date().toISOString()],
    );
  }

  async listInputMessageHistory(): Promise<string[]> {
    const rows = await this.query<InputHistoryRow>(
      this.sql,
      `
        select entry
        from ${this.table("input_history")}
        where app_name = $1
        order by id asc
      `,
      [this.appName],
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
          app_name, agent_id, agent_name, session_id, amount, currency, run_id, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        this.appName,
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
        order by id asc
      `,
      [this.appName],
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
        select idempotency_key, session_id, run_id, status, result, agent_id, created_at
        from ${this.table("idempotency_records")}
        where app_name = $1
          and idempotency_key = $2
        limit 1
      `,
      [this.appName, key],
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
      agentId: data.agent_id ?? undefined,
      createdAt: normalizeTimestamp(data.created_at),
    };
  }

  async writeIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    await this.query(
      this.sql,
      `
        insert into ${this.table("idempotency_records")} (
          app_name, agent_id, session_id, idempotency_key, run_id, status, result, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (app_name, idempotency_key)
        do update set
          agent_id = excluded.agent_id,
          session_id = excluded.session_id,
          run_id = excluded.run_id,
          status = excluded.status,
          result = excluded.result,
          created_at = excluded.created_at
      `,
      [
        this.appName,
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
          limit 1
        `,
        [this.appName],
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
          app_name, session_id, agent_scope, agent_id, agent_name, title, updated_at, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (app_name, session_id, agent_scope)
        do update set
          agent_id = excluded.agent_id,
          agent_name = excluded.agent_name,
          title = excluded.title,
          updated_at = excluded.updated_at
        returning id
      `,
      [
        this.appName,
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
          and session_id = $2
          and agent_scope = $3
        limit 1
      `,
      [this.appName, sessionId, toAgentScope(agentId)],
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

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new Error(`Unexpected PostgreSQL timestamp value: ${String(value)}`);
}
