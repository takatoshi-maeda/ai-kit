import type { PostgresSqlLike } from "../../src/agent/postgres/client.js";

type Row = Record<string, unknown>;

type TableName =
  | "conversations"
  | "conversation_events"
  | "input_history"
  | "usage_entries"
  | "idempotency_records";

interface FakePostgresState {
  conversations: Row[];
  conversation_events: Row[];
  input_history: Row[];
  usage_entries: Row[];
  idempotency_records: Row[];
}

export interface FakePostgresSql extends PostgresSqlLike {
  appliedSql(): string[];
  markMissingTable(table: TableName): void;
  tableRows(table: TableName): Row[];
  endCalls(): number;
}

export function createFakePostgresSql(options: { stringIds?: boolean } = {}): FakePostgresSql {
  const state: FakePostgresState = {
    conversations: [],
    conversation_events: [],
    input_history: [],
    usage_entries: [],
    idempotency_records: [],
  };
  const applied: string[] = [];
  const missingTables = new Set<TableName>();
  let conversationId = 1;
  let eventId = 1;
  let historyId = 1;
  let usageId = 1;
  let idempotencyId = 1;
  let endCallCount = 0;

  return {
    async unsafe<RowType extends Row = Row>(query: string, params: readonly unknown[] = []): Promise<RowType[]> {
      applied.push(query);
      const normalized = normalizeQuery(query);

      if (normalized.includes("create table if not exists") || normalized.includes("create schema if not exists")) {
        return [];
      }

      const table = detectTable(query);
      if (table && missingTables.has(table)) {
        throw new Error(`relation "public.${table}" does not exist`);
      }

      if (normalized.startsWith("select * from") && table === "conversations") {
        const [appName, sessionId, agentScope] = params;
        return state.conversations.filter((row) =>
          row.app_name === appName && row.session_id === sessionId && row.agent_scope === agentScope
        ) as RowType[];
      }

      if (normalized.startsWith("select event_type") && table === "conversation_events") {
        const [conversationIdParam] = params;
        return state.conversation_events
          .filter((row) => row.conversation_id === conversationIdParam)
          .sort((left, right) => Number(left.id) - Number(right.id)) as RowType[];
      }

      if (normalized.startsWith("select session_id, agent_id, updated_at") && table === "conversations") {
        const [appName, maybeScope, maybeLimit] = params;
        const hasScope = normalized.includes("and agent_scope =");
        const scoped = state.conversations.filter((row) =>
          row.app_name === appName && (!hasScope || row.agent_scope === maybeScope)
        );
        scoped.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
        const limit = Number(hasScope ? maybeLimit : maybeScope);
        return (Number.isFinite(limit) ? scoped.slice(0, limit) : scoped) as RowType[];
      }

      if (normalized.startsWith("delete from") && table === "conversations") {
        const [appName, sessionId, agentScope] = params;
        const deleted = state.conversations.filter((row) =>
          row.app_name === appName && row.session_id === sessionId && row.agent_scope === agentScope
        );
        state.conversations = state.conversations.filter((row) => !deleted.includes(row));
        const deletedIds = new Set(deleted.map((row) => row.id));
        state.conversation_events = state.conversation_events.filter((row) => !deletedIds.has(row.conversation_id));
        return deleted.map((row) => ({ id: row.id })) as RowType[];
      }

      if (normalized.startsWith("insert into") && table === "conversations") {
        const [
          appName,
          sessionId,
          agentScope,
          agentId,
          agentName,
          title,
          updatedAt,
          createdAt,
        ] = params;
        const existing = state.conversations.find((row) =>
          row.app_name === appName && row.session_id === sessionId && row.agent_scope === agentScope
        );
        if (existing) {
          existing.agent_id = agentId;
          existing.agent_name = agentName;
          existing.title = title;
          existing.updated_at = updatedAt;
          return [{ id: options.stringIds ? String(existing.id) : existing.id }] as RowType[];
        }
        const row = {
          id: conversationId++,
          app_name: appName,
          session_id: sessionId,
          agent_scope: agentScope,
          agent_id: agentId,
          agent_name: agentName,
          title,
          updated_at: updatedAt,
          created_at: createdAt,
        };
        state.conversations.push(row);
        return [{ id: options.stringIds ? String(row.id) : row.id }] as RowType[];
      }

      if (normalized.startsWith("insert into") && table === "conversation_events") {
        const [conversationIdParam, eventType, eventTimestamp, data, createdAt] = params;
        state.conversation_events.push({
          id: eventId++,
          conversation_id: conversationIdParam,
          event_type: eventType,
          event_timestamp: eventTimestamp,
          data,
          created_at: createdAt,
        });
        return [];
      }

      if (normalized.startsWith("insert into") && table === "input_history") {
        const [appName, agentId, agentName, sessionId, entry, runId, createdAt] = params;
        state.input_history.push({
          id: historyId++,
          app_name: appName,
          agent_id: agentId,
          agent_name: agentName,
          session_id: sessionId,
          entry,
          run_id: runId,
          created_at: createdAt,
        });
        return [];
      }

      if (normalized.startsWith("select entry") && table === "input_history") {
        const [appName] = params;
        return state.input_history
          .filter((row) => row.app_name === appName)
          .sort((left, right) => Number(left.id) - Number(right.id))
          .map((row) => ({ entry: row.entry })) as RowType[];
      }

      if (normalized.startsWith("insert into") && table === "usage_entries") {
        const [appName, agentId, agentName, sessionId, amount, currency, runId, createdAt] = params;
        state.usage_entries.push({
          id: usageId++,
          app_name: appName,
          agent_id: agentId,
          agent_name: agentName,
          session_id: sessionId,
          amount,
          currency,
          run_id: runId,
          created_at: createdAt,
        });
        return [];
      }

      if (normalized.startsWith("select amount, currency, created_at") && table === "usage_entries") {
        const [appName] = params;
        return state.usage_entries
          .filter((row) => row.app_name === appName)
          .sort((left, right) => Number(left.id) - Number(right.id))
          .map((row) => ({
            amount: row.amount,
            currency: row.currency,
            created_at: row.created_at,
          })) as RowType[];
      }

      if (normalized.startsWith("select idempotency_key") && table === "idempotency_records") {
        const [appName, key] = params;
        const row = state.idempotency_records.find((entry) =>
          entry.app_name === appName && entry.idempotency_key === key
        );
        return row ? [row] as RowType[] : [];
      }

      if (normalized.startsWith("insert into") && table === "idempotency_records") {
        const [appName, agentId, sessionId, key, runId, status, result, createdAt] = params;
        const existing = state.idempotency_records.find((row) =>
          row.app_name === appName && row.idempotency_key === key
        );
        if (existing) {
          existing.agent_id = agentId;
          existing.session_id = sessionId;
          existing.run_id = runId;
          existing.status = status;
          existing.result = result;
          existing.created_at = createdAt;
          return [];
        }
        state.idempotency_records.push({
          id: idempotencyId++,
          app_name: appName,
          agent_id: agentId,
          session_id: sessionId,
          idempotency_key: key,
          run_id: runId,
          status,
          result,
          created_at: createdAt,
        });
        return [];
      }

      if (normalized.startsWith("select id") && table === "conversations") {
        const [appName] = params;
        return state.conversations
          .filter((row) => row.app_name === appName)
          .slice(0, 1)
          .map((row) => ({ id: row.id })) as RowType[];
      }

      if (normalized.startsWith("select 1 from")) {
        return [{ "?column?": 1 }] as RowType[];
      }

      throw new Error(`Unhandled fake postgres query: ${normalized}`);
    },
    async begin<T>(callback: (sql: PostgresSqlLike) => Promise<T>): Promise<T> {
      return callback(this);
    },
    async end(): Promise<void> {
      endCallCount += 1;
    },
    appliedSql(): string[] {
      return [...applied];
    },
    markMissingTable(table: TableName): void {
      missingTables.add(table);
    },
    tableRows(table: TableName): Row[] {
      return [...state[table]];
    },
    endCalls(): number {
      return endCallCount;
    },
  };
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function detectTable(query: string): TableName | null {
  const match = query.match(/"(?:[^"]+)"\."([^"]+)"/);
  const tableName = match?.[1] ?? "";
  if (tableName.endsWith("conversations")) return "conversations";
  if (tableName.endsWith("conversation_events")) return "conversation_events";
  if (tableName.endsWith("input_history")) return "input_history";
  if (tableName.endsWith("usage_entries")) return "usage_entries";
  if (tableName.endsWith("idempotency_records")) return "idempotency_records";
  return null;
}
