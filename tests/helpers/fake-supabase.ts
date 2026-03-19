import type {
  SupabaseClientLike,
  SupabaseLikeError,
  SupabaseQueryLike,
  SupabaseQueryResult,
  SupabaseStorageBucketLike,
} from "../../src/agent/supabase/client.js";

type Row = Record<string, unknown>;

interface TableState {
  rows: Row[];
  nextId: number;
}

interface QueryState {
  operation: "select" | "insert" | "upsert" | "delete";
  selectedColumns?: string;
  payload?: Row[];
  onConflict?: string;
  filters: Array<{ column: string; value: unknown }>;
  orderBy?: { column: string; ascending: boolean };
  limit?: number;
  expectSingle: boolean;
  allowMissingSingle: boolean;
}

export interface FakeSupabaseClient extends SupabaseClientLike {
  reset(): void;
  tableRows(table: string): Row[];
  storageObject(bucket: string, path: string): {
    bytes: Uint8Array;
    contentType?: string;
  } | null;
  failNext(error: string): void;
}

export function createFakeSupabaseClient(): FakeSupabaseClient {
  const tables = new Map<string, TableState>();
  const storageBuckets = new Map<string, Map<string, { bytes: Uint8Array; contentType?: string }>>();
  let nextError: string | null = null;

  const client: FakeSupabaseClient = {
    from<T = Record<string, unknown>>(table: string): SupabaseQueryLike<T> {
      return new FakeQueryBuilder<T>(table, executeQuery);
    },
    storage: {
      async getBucket(bucket: string) {
        const error = consumeError();
        if (error) {
          return { data: null, error };
        }
        if (!storageBuckets.has(bucket)) {
          return { data: null, error: { message: `Bucket not found: ${bucket}` } };
        }
        return { data: { id: bucket }, error: null };
      },
      from(bucket: string): SupabaseStorageBucketLike {
        return {
          async upload(path: string, body: ArrayBuffer | ArrayBufferView, options) {
            const error = consumeError();
            if (error) {
              return { data: null, error };
            }
            const bucketState = getBucket(bucket);
            bucketState.set(path, {
              bytes: toUint8Array(body),
              contentType: options?.contentType,
            });
            return { data: { path }, error: null };
          },
          async createSignedUrl(path: string, expiresIn: number) {
            const error = consumeError();
            if (error) {
              return { data: null, error };
            }
            if (!getBucket(bucket).has(path)) {
              return {
                data: null,
                error: { message: `Object not found: ${bucket}/${path}` },
              };
            }
            return {
              data: {
                signedUrl: `https://example.supabase.test/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeURIComponent(path)}?expiresIn=${expiresIn}`,
              },
              error: null,
            };
          },
        };
      },
    },
    reset() {
      tables.clear();
      storageBuckets.clear();
      nextError = null;
    },
    tableRows(table: string) {
      return getTable(table).rows.map((row) => ({ ...row }));
    },
    storageObject(bucket: string, path: string) {
      const object = getBucket(bucket).get(path);
      return object ? { bytes: object.bytes, contentType: object.contentType } : null;
    },
    failNext(error: string) {
      nextError = error;
    },
  };

  return client;

  function executeQuery<T>(
    table: string,
    state: QueryState,
  ): Promise<SupabaseQueryResult<T>> {
    const error = consumeError();
    if (error) {
      return Promise.resolve({ data: null, error });
    }

    const result = runQuery(table, state);
    return Promise.resolve(result as SupabaseQueryResult<T>);
  }

  function runQuery(table: string, state: QueryState): SupabaseQueryResult<Row> {
    const tableState = getTable(table);

    if (state.operation === "insert") {
      const inserted = (state.payload ?? []).map((row) => insertRow(tableState, row));
      return finalizeResult(table, inserted, state);
    }

    if (state.operation === "upsert") {
      const upserted = (state.payload ?? []).map((row) =>
        upsertRow(tableState, row, state.onConflict),
      );
      return finalizeResult(table, upserted, state);
    }

    if (state.operation === "delete") {
      const matchingRows = applyQuery(tableState.rows, state);
      if (matchingRows.length > 0) {
        const ids = new Set(matchingRows.map((row) => row.id));
        tableState.rows = tableState.rows.filter((row) => !ids.has(row.id));
        cascadeDelete(table, matchingRows);
      }
      return finalizeResult(table, matchingRows, state);
    }

    const selected = applyQuery(tableState.rows, state);
    return finalizeResult(table, selected, state);
  }

  function finalizeResult(
    table: string,
    rows: Row[],
    state: QueryState,
  ): SupabaseQueryResult<Row> {
    const projected = projectRows(rows, state.selectedColumns);
    if (state.expectSingle) {
      if (projected.length === 0 && state.allowMissingSingle) {
        return { data: null, error: null };
      }
      if (projected.length !== 1) {
        return {
          data: null,
          error: { message: `Expected exactly one row from ${table}, got ${projected.length}` },
        };
      }
      return { data: projected[0], error: null };
    }
    return { data: projected, error: null };
  }

  function applyQuery(rows: Row[], state: QueryState): Row[] {
    let result = rows.filter((row) =>
      state.filters.every((filter) => row[filter.column] === filter.value)
    );
    if (state.orderBy) {
      const { column, ascending } = state.orderBy;
      result = [...result].sort((left, right) => {
        const leftValue = left[column];
        const rightValue = right[column];
        const cmp = compareQueryValues(leftValue, rightValue);
        return ascending ? cmp : -cmp;
      });
    } else {
      result = [...result];
    }
    if (typeof state.limit === "number") {
      result = result.slice(0, state.limit);
    }
    return result.map((row) => ({ ...row }));
  }

  function projectRows(rows: Row[], columns?: string): Row[] {
    if (!columns || columns === "*") {
      return rows.map((row) => ({ ...row }));
    }
    const selected = columns.split(",").map((column) => column.trim()).filter(Boolean);
    return rows.map((row) => {
      const projected: Row = {};
      for (const column of selected) {
        projected[column] = row[column];
      }
      return projected;
    });
  }

  function insertRow(tableState: TableState, row: Row): Row {
    const inserted = { ...row };
    if (inserted.id === undefined) {
      inserted.id = tableState.nextId++;
    }
    tableState.rows.push(inserted);
    return { ...inserted };
  }

  function upsertRow(
    tableState: TableState,
    row: Row,
    onConflict?: string,
  ): Row {
    const keys = (onConflict ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    if (keys.length === 0) {
      return insertRow(tableState, row);
    }

    const existing = tableState.rows.find((candidate) =>
      keys.every((key) => candidate[key] === row[key])
    );
    if (!existing) {
      return insertRow(tableState, row);
    }
    Object.assign(existing, row);
    return { ...existing };
  }

  function cascadeDelete(table: string, rows: Row[]): void {
    if (!table.endsWith("conversations")) {
      return;
    }
    const eventsTable = table.replace(/conversations$/, "conversation_events");
    const eventState = tables.get(eventsTable);
    if (eventState) {
      const conversationIds = new Set(rows.map((row) => row.id));
      eventState.rows = eventState.rows.filter((row) => !conversationIds.has(row.conversation_id));
    }
    const runStatesTable = table.replace(/conversations$/, "conversation_run_states");
    const runStateState = tables.get(runStatesTable);
    if (runStateState) {
      const conversationIds = new Set(rows.map((row) => row.id));
      runStateState.rows = runStateState.rows.filter((row) => !conversationIds.has(row.conversation_id));
    }
  }

  function getTable(table: string): TableState {
    const existing = tables.get(table);
    if (existing) {
      return existing;
    }
    const created: TableState = { rows: [], nextId: 1 };
    tables.set(table, created);
    return created;
  }

  function getBucket(bucket: string): Map<string, { bytes: Uint8Array; contentType?: string }> {
    const existing = storageBuckets.get(bucket);
    if (existing) {
      return existing;
    }
    const created = new Map<string, { bytes: Uint8Array; contentType?: string }>();
    storageBuckets.set(bucket, created);
    return created;
  }

  function consumeError(): SupabaseLikeError | null {
    if (!nextError) {
      return null;
    }
    const error = { message: nextError };
    nextError = null;
    return error;
  }
}

function compareQueryValues(left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}

class FakeQueryBuilder<T extends Row> implements SupabaseQueryLike<T> {
  private readonly state: QueryState = {
    operation: "select",
    filters: [],
    expectSingle: false,
    allowMissingSingle: false,
  };

  constructor(
    private readonly table: string,
    private readonly execute: (table: string, state: QueryState) => Promise<SupabaseQueryResult<T>>,
  ) {}

  select(columns?: string): SupabaseQueryLike<T> {
    this.state.selectedColumns = columns;
    return this;
  }

  insert(values: T | T[]): SupabaseQueryLike<T> {
    this.state.operation = "insert";
    this.state.payload = normalizeRows(values);
    return this;
  }

  upsert(
    values: T | T[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): SupabaseQueryLike<T> {
    this.state.operation = "upsert";
    this.state.payload = normalizeRows(values);
    this.state.onConflict = options?.onConflict;
    return this;
  }

  delete(): SupabaseQueryLike<T> {
    this.state.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryLike<T> {
    this.state.filters.push({ column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): SupabaseQueryLike<T> {
    this.state.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number): SupabaseQueryLike<T> {
    this.state.limit = count;
    return this;
  }

  single(): SupabaseQueryLike<T> {
    this.state.expectSingle = true;
    this.state.allowMissingSingle = false;
    return this;
  }

  maybeSingle(): SupabaseQueryLike<T> {
    this.state.expectSingle = true;
    this.state.allowMissingSingle = true;
    return this;
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute(this.table, { ...this.state, filters: [...this.state.filters] })
      .then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

function normalizeRows<T extends Row>(values: T | T[]): Row[] {
  return (Array.isArray(values) ? values : [values]).map((value) => ({ ...value }));
}

function toUint8Array(body: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
}
