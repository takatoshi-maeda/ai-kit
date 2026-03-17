import { createClient } from "@supabase/supabase-js";

export interface SupabaseLikeError {
  message: string;
}

export interface SupabaseQueryResult<T> {
  data: T[] | T | null;
  error: SupabaseLikeError | null;
}

export interface SupabaseQueryLike<T> extends PromiseLike<SupabaseQueryResult<T>> {
  select(columns?: string): SupabaseQueryLike<T>;
  insert(values: T | T[]): SupabaseQueryLike<T>;
  upsert(
    values: T | T[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): SupabaseQueryLike<T>;
  delete(): SupabaseQueryLike<T>;
  eq(column: string, value: unknown): SupabaseQueryLike<T>;
  order(column: string, options?: { ascending?: boolean }): SupabaseQueryLike<T>;
  limit(count: number): SupabaseQueryLike<T>;
  single(): SupabaseQueryLike<T>;
  maybeSingle(): SupabaseQueryLike<T>;
}

export interface SupabaseStorageBucketLike {
  upload(
    path: string,
    body: ArrayBuffer | ArrayBufferView,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: unknown; error: SupabaseLikeError | null }>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: SupabaseLikeError | null }>;
}

export interface SupabaseStorageRootLike {
  from(bucket: string): SupabaseStorageBucketLike;
  getBucket(
    id: string,
  ): Promise<{ data: { id: string } | null; error: SupabaseLikeError | null }>;
}

export interface SupabaseClientLike {
  from<T = Record<string, unknown>>(table: string): SupabaseQueryLike<T>;
  storage: SupabaseStorageRootLike;
}

export interface CreateSupabaseClientOptions {
  url: string;
  serviceRoleKey: string;
  schema?: string;
}

export function createSupabaseBackendClient(
  options: CreateSupabaseClientOptions,
): SupabaseClientLike {
  return createClient(options.url, options.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: options.schema ?? "public",
    },
  }) as unknown as SupabaseClientLike;
}

export function formatSupabaseError(error: SupabaseLikeError | Error | string | null | undefined): string {
  if (!error) {
    return "Unknown Supabase error";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message;
}
