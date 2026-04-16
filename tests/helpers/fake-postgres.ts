import type { PostgresSqlLike } from "../../src/agent/postgres/client.js";

type Row = Record<string, unknown>;

type TableName =
  | "versions"
  | "conversations"
  | "conversation_events"
  | "conversation_run_states"
  | "input_history"
  | "usage_entries"
  | "idempotency_records";

interface FakePostgresState {
  versions: Row[];
  conversations: Row[];
  conversation_events: Row[];
  conversation_run_states: Row[];
  input_history: Row[];
  usage_entries: Row[];
  idempotency_records: Row[];
}

export interface FakePostgresSql extends PostgresSqlLike {
  appliedSql(): string[];
  markMissingTable(table: TableName): void;
  markMissingColumn(table: TableName, column: string): void;
  tableRows(table: TableName): Row[];
  endCalls(): number;
}

export function createFakePostgresSql(
  options: { stringIds?: boolean; dateTimestamps?: boolean } = {},
): FakePostgresSql {
  const state: FakePostgresState = {
    versions: [],
    conversations: [],
    conversation_events: [],
    conversation_run_states: [],
    input_history: [],
    usage_entries: [],
    idempotency_records: [],
  };
  const applied: string[] = [];
  const missingTables = new Set<TableName>();
  const missingColumns = new Map<TableName, Set<string>>();
  let conversationId = 1;
  let versionId = 1;
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

      if (normalized === "select 1") {
        return [{ "?column?": 1 }] as RowType[];
      }

      if (
        normalized.startsWith("alter table ") ||
        normalized.startsWith("update ") ||
        normalized.startsWith("drop index if exists ") ||
        normalized.startsWith("create unique index if not exists ") ||
        normalized.startsWith("create index if not exists ")
      ) {
        return [];
      }

      const table = detectTable(query);
      if (table && missingTables.has(table)) {
        throw new Error(`relation "public.${table}" does not exist`);
      }
      if (table) {
        const missing = firstMissingSelectedColumn(query, table, missingColumns.get(table));
        if (missing) {
          throw new Error(`column "${missing}" does not exist`);
        }
      }

      if (normalized.startsWith("select version from") && table === "versions") {
        return state.versions
          .sort((left, right) => String(left.version).localeCompare(String(right.version)))
          .map((row) => ({ version: row.version })) as RowType[];
      }

      if (normalized.startsWith("select * from") && table === "conversations") {
        const [appName, userId, sessionId, agentScope] = params;
        return state.conversations.filter((row) =>
          row.app_name === appName &&
          row.user_id === userId &&
          row.session_id === sessionId &&
          row.agent_scope === agentScope
        ).map((row) => withDateTimestamps(row, options.dateTimestamps)) as RowType[];
      }

      if (normalized.startsWith("select event_type") && table === "conversation_events") {
        const [conversationIdParam] = params;
        return state.conversation_events
          .filter((row) => row.conversation_id === conversationIdParam)
          .sort((left, right) => Number(left.id) - Number(right.id))
          .map((row) => withDateTimestamps(row, options.dateTimestamps)) as RowType[];
      }

      if (normalized.startsWith("select *") && table === "conversation_run_states") {
        const [conversationIdParam] = params;
        return state.conversation_run_states
          .filter((row) => row.conversation_id === conversationIdParam)
          .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
          .slice(0, 1)
          .map((row) => withDateTimestamps(row, options.dateTimestamps)) as RowType[];
      }

      if (normalized.startsWith("select session_id, agent_id, updated_at") && table === "conversations") {
        const [appName, userId, maybeScope, maybeLimit] = params;
        const hasScope = normalized.includes("and agent_scope =");
        const scoped = state.conversations.filter((row) =>
          row.app_name === appName &&
          row.user_id === userId &&
          (!hasScope || row.agent_scope === maybeScope)
        );
        scoped.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
        const limit = Number(hasScope ? maybeLimit : maybeScope);
        return (Number.isFinite(limit) ? scoped.slice(0, limit) : scoped)
          .map((row) => withDateTimestamps(row, options.dateTimestamps)) as RowType[];
      }

      if (normalized.startsWith("delete from") && table === "conversations") {
        const [appName, userId, sessionId, agentScope] = params;
        const deleted = state.conversations.filter((row) =>
          row.app_name === appName &&
          row.user_id === userId &&
          row.session_id === sessionId &&
          row.agent_scope === agentScope
        );
        state.conversations = state.conversations.filter((row) => !deleted.includes(row));
        const deletedIds = new Set(deleted.map((row) => row.id));
        state.conversation_events = state.conversation_events.filter((row) => !deletedIds.has(row.conversation_id));
        state.conversation_run_states = state.conversation_run_states.filter((row) => !deletedIds.has(row.conversation_id));
        return deleted.map((row) => ({ id: row.id })) as RowType[];
      }

      if (normalized.startsWith("insert into") && table === "conversations") {
        const [
          appName,
          userId,
          sessionId,
          agentScope,
          agentId,
          agentName,
          title,
          updatedAt,
          createdAt,
        ] = params;
        const existing = state.conversations.find((row) =>
          row.app_name === appName &&
          row.user_id === userId &&
          row.session_id === sessionId &&
          row.agent_scope === agentScope
        );
        if (existing) {
          existing.user_id = userId;
          existing.agent_id = agentId;
          existing.agent_name = agentName;
          existing.title = title;
          existing.updated_at = updatedAt;
          return [{ id: options.stringIds ? String(existing.id) : existing.id }] as RowType[];
        }
        const row = {
          id: conversationId++,
          app_name: appName,
          user_id: userId,
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

      if (normalized.startsWith("insert into") && table === "versions") {
        const [version] = params;
        const existing = state.versions.find((row) => row.version === version);
        if (!existing) {
          state.versions.push({
            id: versionId++,
            version,
            applied_at: new Date().toISOString(),
          });
        }
        return [];
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

      if (normalized.startsWith("insert into") && table === "conversation_run_states") {
        const [
          conversationIdParam,
          runId,
          turnId,
          status,
          startedAt,
          updatedAt,
          userMessage,
          userContent,
          assistantMessage,
          timeline,
          metadata,
          agentId,
          agentName,
          createdAt,
        ] = params;
        const existing = state.conversation_run_states.find((row) =>
          row.conversation_id === conversationIdParam &&
          row.run_id === runId
        );
        if (existing) {
          Object.assign(existing, {
            turn_id: turnId,
            status,
            started_at: startedAt,
            updated_at: updatedAt,
            user_message: userMessage,
            user_content: userContent,
            assistant_message: assistantMessage,
            timeline,
            metadata,
            agent_id: agentId,
            agent_name: agentName,
          });
          return [];
        }
        state.conversation_run_states.push({
          conversation_id: conversationIdParam,
          run_id: runId,
          turn_id: turnId,
          status,
          started_at: startedAt,
          updated_at: updatedAt,
          user_message: userMessage,
          user_content: userContent,
          assistant_message: assistantMessage,
          timeline,
          metadata,
          agent_id: agentId,
          agent_name: agentName,
          created_at: createdAt,
        });
        return [];
      }

      if (normalized.startsWith("delete from") && table === "conversation_run_states") {
        const [conversationIdParam, runId] = params;
        state.conversation_run_states = state.conversation_run_states.filter((row) =>
          !(row.conversation_id === conversationIdParam && row.run_id === runId)
        );
        return [];
      }

      if (normalized.startsWith("insert into") && table === "input_history") {
        const [appName, userId, agentId, agentName, sessionId, entry, runId, createdAt] = params;
        state.input_history.push({
          id: historyId++,
          app_name: appName,
          user_id: userId,
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
        const [appName, userId] = params;
        return state.input_history
          .filter((row) => row.app_name === appName && row.user_id === userId)
          .sort((left, right) => Number(left.id) - Number(right.id))
          .map((row) => ({ entry: row.entry })) as RowType[];
      }

      if (normalized.startsWith("insert into") && table === "usage_entries") {
        const [appName, userId, agentId, agentName, sessionId, amount, currency, runId, createdAt] = params;
        state.usage_entries.push({
          id: usageId++,
          app_name: appName,
          user_id: userId,
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
        const [appName, userId] = params;
        return state.usage_entries
          .filter((row) => row.app_name === appName && row.user_id === userId)
          .sort((left, right) => Number(left.id) - Number(right.id))
          .map((row) => ({
            amount: row.amount,
            currency: row.currency,
            created_at: toMaybeDate(row.created_at, options.dateTimestamps),
          })) as RowType[];
      }

      if (normalized.startsWith("select idempotency_key") && table === "idempotency_records") {
        const [appName, userId, key] = params;
        const row = state.idempotency_records.find((entry) =>
          entry.app_name === appName &&
          entry.user_id === userId &&
          entry.idempotency_key === key
        );
        return row ? [withDateTimestamps(row, options.dateTimestamps)] as RowType[] : [];
      }

      if (normalized.startsWith("insert into") && table === "idempotency_records") {
        const [appName, userId, agentId, sessionId, key, runId, status, result, createdAt] = params;
        const existing = state.idempotency_records.find((row) =>
          row.app_name === appName &&
          row.user_id === userId &&
          row.idempotency_key === key
        );
        if (existing) {
          existing.user_id = userId;
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
          user_id: userId,
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
        const [appName, userId] = params;
        return state.conversations
          .filter((row) => row.app_name === appName && row.user_id === userId)
          .slice(0, 1)
          .map((row) => ({ id: row.id })) as RowType[];
      }

      if (normalized.startsWith("select 1 from")) {
        return [{ "?column?": 1 }] as RowType[];
      }

      if (normalized.startsWith("select ") && query.includes(" limit 1") && table) {
        const rows = state[table];
        return rows.length > 0 ? [rows[0] as RowType] : [];
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
    markMissingColumn(table: TableName, column: string): void {
      const set = missingColumns.get(table) ?? new Set<string>();
      set.add(column);
      missingColumns.set(table, set);
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
  if (tableName.endsWith("versions")) return "versions";
  if (tableName.endsWith("conversation_events")) return "conversation_events";
  if (tableName.endsWith("conversation_run_states")) return "conversation_run_states";
  if (tableName.endsWith("input_history")) return "input_history";
  if (tableName.endsWith("usage_entries")) return "usage_entries";
  if (tableName.endsWith("idempotency_records")) return "idempotency_records";
  return null;
}

function firstMissingSelectedColumn(
  query: string,
  table: TableName,
  missingColumns: Set<string> | undefined,
): string | null {
  if (!missingColumns || missingColumns.size === 0) {
    return null;
  }
  const normalized = normalizeQuery(query);
  if (!normalized.startsWith("select ")) {
    return null;
  }
  const fromToken = ` from "public"."ai_kit_${table}"`;
  const fromIndex = normalized.indexOf(fromToken);
  if (fromIndex === -1) {
    return null;
  }
  const selectList = normalized.slice("select ".length, fromIndex);
  for (const column of selectList.split(",").map((value) => value.trim())) {
    if (missingColumns.has(column)) {
      return column;
    }
  }
  return null;
}

function withDateTimestamps(row: Row, enabled?: boolean): Row {
  if (!enabled) {
    return row;
  }
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, toMaybeDate(value, enabled, key)]),
  );
}

function toMaybeDate(value: unknown, enabled?: boolean, key?: string): unknown {
  if (!enabled || typeof value !== "string") {
    return value;
  }
  if (!key || !/(?:_at|_timestamp)$/.test(key)) {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed;
}
