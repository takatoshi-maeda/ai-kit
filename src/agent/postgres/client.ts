import postgres from "postgres";

export interface PostgresSqlLike {
  unsafe<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: readonly unknown[],
  ): Promise<Row[]>;
  begin<T>(callback: (sql: PostgresSqlLike) => Promise<T>): Promise<T>;
  end?(options?: { timeout?: number }): Promise<void>;
}

export interface CreatePostgresClientOptions {
  connectionString: string;
}

export function createPostgresClient(
  options: CreatePostgresClientOptions,
): PostgresSqlLike {
  return postgres(options.connectionString, {
    prepare: false,
    max: 5,
  }) as unknown as PostgresSqlLike;
}

export function formatPostgresError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "Unknown PostgreSQL error");
}
